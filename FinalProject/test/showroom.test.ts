import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { Orchestrator } from '../src/orchestrator/service.js';
import { createFixtureStudioProvider } from '../src/providers/studio-fixture.js';
import { createPrerecordedDemoProvider, DEMO_MEDIA } from '../src/providers/demo-media.js';
import { ShowroomActionSchema, ShowroomSnapshotSchema, type ShowroomSnapshot, type StudioSelection } from '../src/contracts/showroom.js';
import { createApp } from '../src/http/app.js';
import { readConfig, SHOWROOM_SESSION_TTL_MS } from '../src/config.js';
import { ProviderFailure } from '../src/providers/http-client.js';
import type { ShowroomCalendar, ShowroomMotion } from '../src/orchestrator/showroom.js';
import type { BridgeStatus } from '../src/contracts/bridge.js';
import {
  CalendarError, CalendarSchedulingService, FileCalendarReceiptStore, GoogleCalendarProvider,
  confirmationKey, createAppointmentDraft, parseCalendarConfig, type GoogleCalendarEvent,
} from '../src/calendar/index.js';

const consent = { policyVersion: 'showroom-v1', personalization: true, capture: true, likeness: true, providerTransfer: true, calendar: false, motion: false };
const selection: StudioSelection = {
  productId: 'toyota-camry', templateId: 'DREAM_ROUTE', heroMode: 'LIKENESS',
  productionMode: 'reviewed-storyboard', videoProvider: 'google-veo', enableHeroVideo: true,
  storyFormat: 'four-shot', renderLayout: 'video-bookends', movieDurationSeconds: 15,
};
const fixtureBytes = readFile(new URL('../fixtures/media/default-demo.mp4', import.meta.url)).then(bytes => new Uint8Array(bytes));
async function setup(t: TestContext, options: { calendar?: ShowroomCalendar; motion?: ShowroomMotion; now?: () => number } = {}) {
  const bytes = await fixtureBytes;
  const orchestrator = new Orchestrator({
    mediaProvider: createPrerecordedDemoProvider(bytes), studioProvider: createFixtureStudioProvider(bytes),
    showroomMode: 'fixture', calendar: options.calendar, motion: options.motion, now: options.now,
  });
  t.after(() => orchestrator.dispose());
  const created = orchestrator.createSession();
  const service = orchestrator.showroom!;
  const snapshot = () => service.snapshot(created.sessionId);
  const action = async (type: string, payload: unknown, overrides: Record<string, unknown> = {}) => service.action(created.sessionId, {
    schemaVersion: 1, eventId: randomUUID(), expectedRevision: snapshot().revision, type, payload, ...overrides,
  });
  const confirm = async () => {
    const pending = snapshot().pendingAction!;
    return action('action_confirmed', { pendingActionId: pending.pendingActionId,
      confirmationFingerprint: pending.confirmationFingerprint, decision: 'approve', channel: 'touch' });
  };
  const intake = async () => {
    await action('consent_recorded', consent); await confirm();
    await action('answer_proposed', { field: 'visitor', value: { displayName: 'Taylor' } }); await confirm();
    await action('answer_proposed', { field: 'context', value: { signals: [{ value: 'mountain hikes', source: 'manual', visualUseAllowed: true, confidence: null }] } }); await confirm();
    await action('answer_proposed', { field: 'selection', value: selection }); await confirm();
  };
  const photo = async (background = 'red') => new Uint8Array(await sharp({
    create: { width: 16, height: 20, channels: 3, background },
  }).png().toBuffer());
  const upload = async (background = 'red') => service.upload(created.sessionId, await photo(background), 'image/png', snapshot().revision, randomUUID());
  const capture = async (ids: string[]) => action('capture_set_recorded', {
    captureSetId: randomUUID(), sessionId: created.sessionId, consentId: snapshot().consent!.consentId,
    inputRevision: snapshot().inputRevision, primaryAssetId: ids[0],
    references: ids.map((assetId, index) => ({ assetId, view: ['front_face', 'half_body', 'profile', 'three_quarter'][index] })),
  });
  const movie = async () => {
    await intake();
    const photo = await upload(); await capture([photo.assetId]);
    await action('studio_requested', {}); await confirm(); await service.settled();
    return snapshot();
  };
  return { orchestrator, service, created, snapshot, action, confirm, intake, photo, upload, capture, movie };
}

test('fixture showroom uses explicit consent, self-report, immutable accepted intent and an honest registered film', async t => {
  const f = await setup(t);
  const first = f.snapshot();
  assert.equal(first.mode, 'fixture');
  assert.equal(first.consent, null);
  await assert.rejects(f.upload(), /consent/);
  const ready = await f.movie();
  assert.equal(ready.visitor?.source, 'self_reported');
  assert.equal(ready.visitor?.displayName, 'Taylor');
  assert.equal(ready.studio.status, 'ready');
  if (ready.studio.status !== 'ready') throw new Error('Expected ready');
  assert.equal(ready.studio.provenance, 'mock_fixture');
  assert.equal(ready.studio.checksum, DEMO_MEDIA.sha256);
  assert.equal(ready.studio.byteLength, DEMO_MEDIA.bytes);
  assert.equal(ready.studio.durationSeconds, DEMO_MEDIA.durationSeconds);
  assert.equal(f.orchestrator.snapshot(f.created.sessionId).customer, undefined);
  assert.equal(f.orchestrator.snapshot(f.created.sessionId).state, 'media_ready');
  await assert.rejects(f.action('answer_proposed', { field: 'visitor', value: { displayName: 'Another visitor' } }), /immutable/);
  await assert.rejects(f.upload('blue'), /immutable/);
  await assert.rejects(f.orchestrator.command(f.created.sessionId, 'identify_customer', { customerId: 'demo-alex', method: 'manual' }), /showroom/);
  const playback = { jobId: ready.studio.jobId, assetId: ready.studio.assetId, playbackId: randomUUID() };
  await assert.rejects(f.action('playback_ended', playback), /current playback/);
  await f.action('playback_started', playback);
  assert.equal(f.snapshot().playback.status, 'playing');
  assert.equal(f.orchestrator.snapshot(f.created.sessionId).events.at(-1)?.type, 'media_revealed');
  await f.action('playback_ended', playback);
  assert.equal(f.snapshot().state, 'followup');
  assert.ok(ShowroomSnapshotSchema.safeParse(f.snapshot()).success);
});

test('stale approvals and event conflicts cannot confirm a different proposal', async t => {
  const f = await setup(t);
  await f.action('consent_recorded', consent);
  const first = f.snapshot();
  await f.action('consent_recorded', { ...consent, motion: true });
  await assert.rejects(f.action('action_confirmed', {
    pendingActionId: first.pendingAction!.pendingActionId, confirmationFingerprint: first.pendingAction!.confirmationFingerprint,
    decision: 'approve', channel: 'voice',
  }, { expectedRevision: first.revision }), /Refresh/);
  const event = ShowroomActionSchema.parse({ schemaVersion: 1, eventId: randomUUID(), expectedRevision: f.snapshot().revision,
    type: 'action_confirmed', payload: { pendingActionId: f.snapshot().pendingAction!.pendingActionId,
      confirmationFingerprint: f.snapshot().pendingAction!.confirmationFingerprint, decision: 'approve', channel: 'voice' } });
  const results = await Promise.all([f.service.action(f.created.sessionId, event), f.service.action(f.created.sessionId, event)]);
  assert.equal(results[0]!.acknowledgement?.revision, results[1]!.acknowledgement?.revision);
  await assert.rejects(f.service.action(f.created.sessionId, { ...event, payload: { ...event.payload, decision: 'reject' } }), /different input/);
});

test('original upload dedupe, four-photo cap, ownership and scoped retakes are enforced', async t => {
  const f = await setup(t);
  await f.intake();
  const bytes = await f.photo();
  const revision = f.snapshot().revision;
  const eventId = randomUUID();
  const one = await f.service.upload(f.created.sessionId, bytes, 'image/png', revision, eventId);
  const again = await f.service.upload(f.created.sessionId, bytes, 'image/png', revision, eventId);
  assert.equal(one.assetId, again.assetId);
  await assert.rejects(f.upload(), /already registered/);
  const two = await f.upload('blue');
  const three = await f.upload('green');
  const four = await f.upload('yellow');
  await assert.rejects(f.upload('black'), /at most four/);
  await assert.rejects(f.capture([randomUUID()]), /owned reference/);
  await f.capture([one.assetId, two.assetId, three.assetId, four.assetId]);
  await f.service.deleteReference(f.created.sessionId, two.assetId, f.snapshot().revision, randomUUID());
  assert.throws(() => f.orchestrator.asset(f.created.sessionId, two.assetId), /not available/);
  await f.upload('black');
  const other = f.orchestrator.createSession();
  assert.throws(() => f.orchestrator.asset(other.sessionId, one.assetId), /not available/);
});

test('image decoder rejects false signatures, format mismatch, oversized input and animation', async t => {
  const f = await setup(t); await f.intake();
  await assert.rejects(f.service.upload(f.created.sessionId, new Uint8Array([137, 80, 78, 71]), 'image/png', f.snapshot().revision, randomUUID()), /decoded/);
  await assert.rejects(f.service.upload(f.created.sessionId, await f.photo(), 'image/jpeg', f.snapshot().revision, randomUUID()), /format/);
  await assert.rejects(f.service.upload(f.created.sessionId, new Uint8Array(5 * 1024 * 1024 + 1), 'image/png', f.snapshot().revision, randomUUID()), /5 MiB/);
});

test('calendar confirmation binds full 60-minute readback and survives photograph withdrawal without cancellation', async t => {
  const confirmed: unknown[] = [];
  const calendar: ShowroomCalendar = {
    draft: (proposal, product) => ({
      startTime: proposal.startTime, endTime: new Date(Date.parse(proposal.startTime) + 3_600_000).toISOString(),
      timeZone: 'America/New_York', attendees: [proposal.customerEmail, 'staff@example.test'],
      subject: `${product.name} test drive`, location: 'Test showroom', productId: product.id, productName: product.name,
    }),
    checkAvailability: async () => ({ available: true }),
    confirm: async input => { confirmed.push(input); return { status: 'created', eventId: 'fake-calendar-event', invitationsRequested: true }; },
  };
  const f = await setup(t, { calendar });
  const ready = await f.movie();
  if (ready.studio.status !== 'ready') throw new Error('Expected ready');
  const playback = { jobId: ready.studio.jobId, assetId: ready.studio.assetId, playbackId: randomUUID() };
  await f.action('playback_started', playback); await f.action('playback_ended', playback);
  await f.action('consent_recorded', { ...consent, calendar: true }); await f.confirm();
  await f.action('calendar_draft_proposed', { startTime: '2026-09-20T15:00:00-04:00', customerEmail: 'customer@example.test' });
  assert.match(f.snapshot().pendingAction!.readback, /staff@example.test/);
  assert.match(f.snapshot().pendingAction!.readback, /60-minute/);
  assert.equal(confirmed.length, 0);
  await f.confirm();
  assert.equal(confirmed.length, 1);
  await f.action('consent_recorded', { ...consent, capture: false, calendar: true });
  assert.equal(f.snapshot().state, 'cancelled');
  assert.equal(f.snapshot().calendar.status, 'scheduled');
  assert.throws(() => f.orchestrator.asset(f.created.sessionId, playback.assetId), /not available/);
});

test('fixture catalog never silently aliases demo-car and unknown enrichment is rejected', async t => {
  const f = await setup(t);
  await f.action('consent_recorded', consent); await f.confirm();
  await f.action('answer_proposed', { field: 'selection', value: selection });
  assert.match(f.snapshot().pendingAction!.readback, /Toyota Camry/);
  await f.confirm();
  assert.equal(f.snapshot().selection?.productId, 'toyota-camry');
  await assert.rejects(f.action('answer_proposed', { field: 'selection', value: { ...selection, productId: 'demo-car' } }), /catalog product/);
  await assert.rejects(f.action('answer_proposed', { field: 'context', value: {
    signals: [{ value: 'inferred preference', source: 'approved-research', visualUseAllowed: true, confidence: 0.9 }],
  } }), /self-reported/);
});

test('HTTP pairing is one-time and reference/showroom routes require the same session capability', async t => {
  const f = await setup(t);
  const config = readConfig({ SHOWROOM_MODE: 'fixture', SHOWROOM_OPERATOR_TOKEN: 'operator-token-12345678901234567890' });
  const app = createApp({ orchestrator: f.orchestrator, config, deviceToken: 'device-token', log: () => {} });
  const request = (path: string, token?: string, body?: unknown) => app.request(`http://localhost${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  assert.equal((await request('/v1/operator/kiosk-pairings', undefined, {})).status, 401);
  const issued = await request('/v1/operator/kiosk-pairings', config.SHOWROOM_OPERATOR_TOKEN, {});
  assert.equal(issued.status, 201);
  const code = await issued.json();
  const paired = await request('/v1/kiosk/pair', undefined, { pairingCode: code.pairingCode });
  assert.equal(paired.status, 201);
  const session = await paired.json();
  assert.ok(session.expiresAt - Date.now() > SHOWROOM_SESSION_TTL_MS - 10_000);
  assert.equal((await request('/v1/kiosk/pair', undefined, { pairingCode: code.pairingCode })).status, 401);
  assert.equal((await request(`/v1/sessions/${session.sessionId}/showroom`)).status, 401);
  const authorized = await request(`/v1/sessions/${session.sessionId}/showroom`, session.sessionToken);
  assert.equal(authorized.status, 200);
  assert.equal(ShowroomSnapshotSchema.parse(await authorized.json()).mode, 'fixture');
  const readiness = await (await request('/readyz')).json();
  assert.equal(readiness.showroom.mode, 'fixture');
  assert.equal(readiness.showroom.voice.enabled, false);
  const stop = { schemaVersion: 1, eventId: randomUUID(), expectedRevision: 0, type: 'stop_requested', payload: { reason: 'user' } };
  assert.equal((await request(`/v1/sessions/${session.sessionId}/showroom/actions`, undefined, stop)).status, 401);
  assert.equal((await request(`/v1/sessions/${session.sessionId}/showroom/actions`, f.created.sessionToken, stop)).status, 401);
});

test('motion approval alone never pulses; fresh tracking uses a bounded grant and exact retries do not move twice', async t => {
  let now = Date.now();
  let pulses = 0;
  const bridge: BridgeStatus = {
    bridgeId: randomUUID(), connected: true, armed: true, stopped: true, leaseGeneration: 1,
    leaseId: randomUUID(), leaseExpiresAt: now + 30_000, lastHeartbeatAt: now,
  };
  const motion: ShowroomMotion = {
    sessionState: () => bridge,
    stopSession: () => null,
    authorizeMotion: async (sessionId, intent) => ({
      commandId: randomUUID(), bridgeId: bridge.bridgeId, sessionId,
      leaseId: intent.leaseId, leaseGeneration: intent.leaseGeneration, sequence: ++pulses,
      issuedAt: now, expiresAt: now + 1000, type: 'motion', intent: intent.intent,
      speed: 'low', pulseMs: intent.pulseMs, tracking: intent.tracking,
    }),
  };
  const f = await setup(t, { motion, now: () => now });
  await f.action('consent_recorded', { ...consent, motion: true }); await f.confirm();
  const intent = { intent: 'reverse_for_half_body', speed: 'low', pulseMs: 500, leaseId: bridge.leaseId, leaseGeneration: 1 };
  await f.action('motion_requested', intent); await f.confirm();
  assert.equal(pulses, 0);
  const grantId = f.snapshot().motionGrant!.grantId;
  const tracking = () => ({ capturedAt: new Date(now).toISOString(), confidence: 0.95, personCount: 1, goal: 'half_body', centerX: 0.5, centerY: 0.5, bodyOccupancy: 0.9 });
  const event = { schemaVersion: 1, eventId: randomUUID(), expectedRevision: f.snapshot().revision,
    type: 'motion_execution_requested', payload: { grantId, tracking: tracking() } };
  await f.service.action(f.created.sessionId, event); await f.service.action(f.created.sessionId, event);
  assert.equal(pulses, 1);
  for (let index = 0; index < 3; index++) {
    now += 1000; await f.action('motion_execution_requested', { grantId, tracking: tracking() });
  }
  now += 1000;
  await assert.rejects(f.action('motion_execution_requested', { grantId, tracking: tracking() }), /budget/);
  assert.equal(pulses, 4);
  await f.action('stop_requested', { reason: 'user' }, { expectedRevision: 0 });
  assert.equal(f.snapshot().motionGrant, null);
});

test('Stop and consent withdrawal bypass a blocked calendar action and stale revision without cancelling its appointment', async t => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let stops = 0;
  const calendar: ShowroomCalendar = {
    draft: (proposal, product) => ({
      startTime: proposal.startTime, endTime: new Date(Date.parse(proposal.startTime) + 3_600_000).toISOString(),
      timeZone: 'America/New_York', attendees: [proposal.customerEmail], subject: 'Test drive', location: 'Showroom',
      productId: product.id, productName: product.name,
    }),
    checkAvailability: async () => ({ available: true }),
    confirm: async () => { entered(); await blocked; return { status: 'created', eventId: 'confirmed-appointment', invitationsRequested: true }; },
  };
  const f = await setup(t, { calendar, motion: {
    sessionState: () => null, stopSession: () => { stops++; },
    authorizeMotion: async () => { throw new Error('No hardware'); },
  } });
  t.after(release);
  const ready = await f.movie();
  if (ready.studio.status !== 'ready') throw new Error('Expected ready');
  const playback = { jobId: ready.studio.jobId, assetId: ready.studio.assetId, playbackId: randomUUID() };
  await f.action('playback_started', playback); await f.action('playback_ended', playback);
  await f.action('consent_recorded', { ...consent, calendar: true }); await f.confirm();
  await f.action('calendar_draft_proposed', { startTime: '2026-09-20T15:00:00-04:00', customerEmail: 'customer@example.test' });
  const pending = f.confirm();
  await started;
  const stopEventId = randomUUID();
  const stop = await f.action('stop_requested', { reason: 'user' }, { expectedRevision: 0, eventId: stopEventId });
  assert.equal(stop.calendar.status, 'submitting');
  assert.ok(stops > 0);
  const count = stops;
  await f.action('stop_requested', { reason: 'user' }, { expectedRevision: 0, eventId: stopEventId });
  assert.equal(stops, count);
  const ended = await f.action('consent_recorded', { ...consent, capture: false, calendar: true }, { expectedRevision: 0 });
  assert.equal(ended.state, 'cancelled');
  assert.throws(() => f.orchestrator.asset(f.created.sessionId, playback.assetId), /not available/);
  release(); await pending;
  assert.equal(f.snapshot().calendar.status, 'scheduled');
});

test('an uncertain calendar confirmation reconciles only its exact original event and immutable draft', async t => {
  const requests: { confirmationId: string; draft: unknown }[] = [];
  const calendar: ShowroomCalendar = {
    draft: (proposal, product) => ({
      startTime: proposal.startTime, endTime: new Date(Date.parse(proposal.startTime) + 3_600_000).toISOString(),
      timeZone: 'America/New_York', attendees: [proposal.customerEmail], subject: 'Test drive', location: 'Showroom',
      productId: product.id, productName: product.name,
    }),
    checkAvailability: async () => ({ available: true }),
    confirm: async request => {
      requests.push({ confirmationId: request.confirmationId, draft: structuredClone(request.draft) });
      if (requests.length === 1) throw new ProviderFailure('CALENDAR_UNCERTAIN', 'Simulated uncertain provider acceptance.', false, true);
      return { status: 'created', eventId: 'one-reconciled-event', invitationsRequested: true };
    },
  };
  const f = await setup(t, { calendar });
  const ready = await f.movie();
  if (ready.studio.status !== 'ready') throw new Error('Expected ready');
  const playback = { jobId: ready.studio.jobId, assetId: ready.studio.assetId, playbackId: randomUUID() };
  await f.action('playback_started', playback); await f.action('playback_ended', playback);
  await f.action('consent_recorded', { ...consent, calendar: true }); await f.confirm();
  await f.action('calendar_draft_proposed', { startTime: '2026-09-20T15:00:00-04:00', customerEmail: 'customer@example.test' });
  const pending = f.snapshot().pendingAction!;
  const event = { schemaVersion: 1, eventId: randomUUID(), expectedRevision: f.snapshot().revision,
    type: 'action_confirmed', payload: { pendingActionId: pending.pendingActionId,
      confirmationFingerprint: pending.confirmationFingerprint, decision: 'approve', channel: 'touch' } };
  assert.equal((await f.service.action(f.created.sessionId, event)).calendar.status, 'uncertain');
  await assert.rejects(f.action('calendar_draft_proposed', { startTime: '2026-09-20T16:00:00-04:00', customerEmail: 'customer@example.test' }), /Reconcile/);
  assert.equal((await f.service.action(f.created.sessionId, event)).calendar.status, 'scheduled');
  assert.deepEqual(requests[1], requests[0]);
  await f.service.action(f.created.sessionId, event);
  assert.equal(requests.length, 2);
});

test('a real calendar post-insert receipt failure stays uncertain in the showroom and cannot create a replacement event', async t => {
  await mkdir(resolve('.runtime', 'tests'), { recursive: true });
  const directory = await mkdtemp(resolve('.runtime', 'tests', 'showroom-calendar-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const now = new Date('2026-09-13T12:00:00Z');
  const config = parseCalendarConfig({
    CALENDAR_PROVIDER: 'google', GOOGLE_CLIENT_ID: 'fake-client', GOOGLE_CLIENT_SECRET: 'fake-secret',
    SCHEDULING_TIME_ZONE: 'America/New_York', SCHEDULING_LOCATION: 'Test showroom',
    SCHEDULING_STAFF_EMAILS: 'staff@example.test',
  });
  if (config.provider !== 'google') throw new Error('Expected explicit fake Google configuration.');
  const events = new Map<string, GoogleCalendarEvent>();
  let insertions = 0;
  const provider = new GoogleCalendarProvider(config, {
    clock: () => now, auth: { getAccessToken: async () => 'fake-access-token' },
    fetch: async (target, init) => {
      const url = new URL(target);
      assert.equal(url.origin, 'https://www.googleapis.com');
      if (url.pathname.endsWith('/freeBusy')) {
        const interval: { timeMin: string; timeMax: string } = JSON.parse(String(init.body));
        return Response.json({ ...interval, calendars: { primary: { busy: [] } } });
      }
      if (init.method === 'GET') {
        const event = events.get(url.pathname.split('/').at(-1)!);
        return event ? Response.json(event) : new Response(null, { status: 404 });
      }
      assert.equal(init.method, 'POST');
      assert.equal(url.searchParams.get('sendUpdates'), 'all');
      insertions++;
      const input: GoogleCalendarEvent = JSON.parse(String(init.body));
      const event: GoogleCalendarEvent = { ...input, status: 'confirmed', organizer: { self: true }, etag: '"v1"' };
      events.set(event.id, event);
      return Response.json(event);
    },
  });
  const receipts = new FileCalendarReceiptStore(directory);
  const save = receipts.save.bind(receipts);
  let failCreated = true;
  receipts.save = async receipt => {
    if (failCreated && receipt.state === 'created') {
      throw new CalendarError('CALENDAR_STORAGE_FAILED', 'Injected post-insert receipt failure.', 503);
    }
    await save(receipt);
  };
  const scheduling = new CalendarSchedulingService(config, { provider, receipts, clock: () => now });
  const f = await setup(t, { now: () => now.getTime(), calendar: {
    draft: (proposal, product) => createAppointmentDraft(config, { ...proposal, productId: product.id, productName: product.name }, now),
    checkAvailability: draft => scheduling.checkAvailability({ ...draft, attendees: [...draft.attendees] }),
    confirm: request => scheduling.confirm({ ...request, draft: { ...request.draft, attendees: [...request.draft.attendees] } }),
  } });
  const ready = await f.movie();
  if (ready.studio.status !== 'ready') throw new Error('Expected ready');
  const playback = { jobId: ready.studio.jobId, assetId: ready.studio.assetId, playbackId: randomUUID() };
  await f.action('playback_started', playback); await f.action('playback_ended', playback);
  await f.action('consent_recorded', { ...consent, calendar: true }); await f.confirm();
  await f.action('calendar_draft_proposed', { startTime: '2026-09-20T15:00:00-04:00', customerEmail: 'customer@example.test' });
  const pending = f.snapshot().pendingAction!;
  const confirmation = {
    schemaVersion: 1, eventId: randomUUID(), expectedRevision: f.snapshot().revision, type: 'action_confirmed',
    payload: { pendingActionId: pending.pendingActionId, confirmationFingerprint: pending.confirmationFingerprint, decision: 'approve', channel: 'touch' },
  };
  const uncertain = await f.service.action(f.created.sessionId, confirmation);
  assert.equal(uncertain.calendar.status, 'uncertain');
  assert.equal(insertions, 1);
  assert.equal(events.size, 1);
  assert.equal((await receipts.load(confirmationKey(pending.pendingActionId)))?.state, 'pending');
  await assert.rejects(f.action('calendar_draft_proposed', {
    startTime: '2026-09-20T16:00:00-04:00', customerEmail: 'replacement@example.test',
  }), /Reconcile/);
  failCreated = false;
  const reconciled = await f.service.action(f.created.sessionId, confirmation);
  assert.equal(reconciled.calendar.status, 'scheduled');
  if (reconciled.calendar.status !== 'scheduled') throw new Error('Expected scheduled');
  assert.equal(reconciled.calendar.confirmationId, pending.pendingActionId);
  assert.ok(events.has(reconciled.calendar.eventId));
  assert.equal((await receipts.load(confirmationKey(pending.pendingActionId)))?.state, 'created');
  await f.service.action(f.created.sessionId, confirmation);
  assert.equal(insertions, 1);
  assert.equal(events.size, 1);
});
