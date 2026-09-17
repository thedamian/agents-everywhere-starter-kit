import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { z } from 'zod';
import * as showroom from '../src/contracts/showroom.js';
import * as bridge from '../src/contracts/bridge.js';
import {
  AppointmentDraftSchema, ShowroomActionSchema, ShowroomContractError,
  StudioSelectionSchema, assertExpectedRevision, assertPendingConfirmation,
  type PendingAction,
} from '../src/contracts/showroom.js';
import { BRIDGE_LIMITS, BridgeCommandSchema, BridgeLeaseSchema } from '../src/contracts/bridge.js';

const id = '11111111-1111-4111-8111-111111111111';
const now = 1_800_000_000_000;
const selection = {
  productId: 'toyota-camry', templateId: 'DREAM_ROUTE', heroMode: 'LIKENESS',
  productionMode: 'reviewed-storyboard', videoProvider: 'google-veo', enableHeroVideo: true,
  storyFormat: 'four-shot', renderLayout: 'storyboard', movieDurationSeconds: null,
};
const pending: PendingAction = {
  pendingActionId: id, expectedRevision: 3, inputRevision: 2,
  confirmationFingerprint: 'a'.repeat(64), readback: 'Your name is Alex. Is that right?',
  expiresAt: now + 1000, kind: 'answer', payload: { field: 'visitor', value: { displayName: 'Alex' } },
};
const confirmation = {
  pendingActionId: id, confirmationFingerprint: 'a'.repeat(64), decision: 'approve' as const, channel: 'voice' as const,
};

test('showroom actions require optimistic concurrency as well as dedupe and reject extra fields', () => {
  const action = { schemaVersion: 1, eventId: id, expectedRevision: 0, type: 'studio_requested', payload: {} };
  assert.equal(ShowroomActionSchema.safeParse(action).success, true);
  assert.equal(ShowroomActionSchema.safeParse({ ...action, expectedRevision: undefined }).success, false);
  assert.equal(ShowroomActionSchema.safeParse({ ...action, providerToken: 'not-allowed' }).success, false);
  assert.throws(() => assertExpectedRevision(0, 1), ShowroomContractError);
});

test('confirmation binds exact pending action, current state, input revision, fingerprint and expiry', () => {
  assertPendingConfirmation(pending, confirmation, 3, 3, 2, now);
  for (const mutate of [
    { expectedRevision: 4 }, { inputRevision: 3 }, { confirmationFingerprint: 'b'.repeat(64) },
    { pendingActionId: '22222222-2222-4222-8222-222222222222' }, { expiresAt: now },
  ]) assert.throws(() => assertPendingConfirmation({ ...pending, ...mutate }, confirmation, 3, 3, 2, now), ShowroomContractError);
});

test('studio selection preserves real provider and production restrictions', () => {
  assert.equal(StudioSelectionSchema.safeParse(selection).success, true);
  assert.equal(StudioSelectionSchema.safeParse({ ...selection, productId: 'demo car' }).success, false);
  assert.equal(StudioSelectionSchema.safeParse({ ...selection, templateId: 'invented' }).success, false);
  assert.equal(StudioSelectionSchema.safeParse({ ...selection, productionMode: 'movie-first' }).success, false);
  assert.equal(StudioSelectionSchema.safeParse({ ...selection, movieDurationSeconds: 15 }).success, false);
});

test('calendar drafts bind all invitees and exactly sixty minutes including offset transitions', () => {
  const draft = {
    startTime: '2026-11-01T01:30:00-04:00', endTime: '2026-11-01T01:30:00-05:00',
    timeZone: 'America/New_York', attendees: ['visitor@example.com', 'staff@example.com'],
    subject: 'Toyota Camry test drive', location: 'Showroom', productId: 'toyota-camry', productName: 'Toyota Camry',
  };
  assert.equal(AppointmentDraftSchema.safeParse(draft).success, true);
  assert.equal(AppointmentDraftSchema.safeParse({ ...draft, endTime: '2026-11-01T02:30:00-05:00' }).success, false);
  assert.equal(AppointmentDraftSchema.safeParse({ ...draft, timeZone: 'Invented/Zone' }).success, false);
  assert.equal(AppointmentDraftSchema.safeParse({ ...draft, attendees: ['VISITOR@example.com', 'visitor@example.com'] }).success, false);
});

test('motion has bounded pulses and fresh-command lifetime, no raw BLE or unbounded directions', () => {
  const base = {
    bridgeId: id, sessionId: id, leaseId: id, leaseGeneration: 1,
    commandId: id, sequence: 1, issuedAt: now, expiresAt: now + BRIDGE_LIMITS.maxCommandLifetimeMs,
    type: 'motion', intent: 'reverse_for_half_body', speed: 'low', pulseMs: 500,
    tracking: { capturedAt: new Date(now).toISOString(), confidence: 0.9, personCount: 1, goal: 'half_body', centerX: 0.5, centerY: 0.5, bodyOccupancy: 0.7 },
  };
  assert.equal(BridgeCommandSchema.safeParse(base).success, true);
  for (const mutate of [{ pulseMs: 501 }, { speed: 'high' }, { intent: 'forward' }, { sequence: 0 },
    { expiresAt: now + 2001 }, { expiresAt: now }, { bytes: [1, 2] }]) {
    assert.equal(BridgeCommandSchema.safeParse({ ...base, ...mutate }).success, false);
  }
  const lease = { bridgeId: id, sessionId: id, leaseId: id, generation: 1, issuedAt: now, expiresAt: now + 30_000, operatorArmed: true, rearClearanceConfirmed: true };
  assert.equal(BridgeLeaseSchema.safeParse(lease).success, true);
  assert.equal(BridgeLeaseSchema.safeParse({ ...lease, expiresAt: now + 30_001 }).success, false);
});

const examples = JSON.parse(await readFile(new URL('../interfaces/showroom-v1/examples.json', import.meta.url), 'utf8'));

test('accepted studio snapshots are deeply immutable and independent of mutable inputs', () => {
  const original = structuredClone(examples.AcceptedStudioSnapshotSchema);
  const accepted = showroom.parseAcceptedStudioSnapshot(original, {
    sessionId: id, inputRevision: 2, consentId: id,
    ownedAssetIds: ['22222222-2222-4222-8222-222222222222'], availableProductIds: ['toyota-camry'],
  });
  function assertFrozen(value: unknown): void {
    if (value === null || typeof value !== 'object') return;
    assert.equal(Object.isFrozen(value), true);
    Object.values(value).forEach(assertFrozen);
  }
  assertFrozen(accepted);
  original.input.context.signals[0].value = 'Changed later';
  assert.equal(accepted.input.context.signals[0]?.value, 'Coastal drives');
  assert.equal(Reflect.set(accepted.input.selection, 'productId', 'different-car'), false);
});

test('studio acceptance rejects foreign ownership, stale consent/input and invented catalog products', () => {
  const fixture = examples.AcceptedStudioSnapshotSchema;
  const authority = { sessionId: id, inputRevision: 2, consentId: id,
    ownedAssetIds: ['22222222-2222-4222-8222-222222222222'], availableProductIds: ['toyota-camry'] };
  for (const change of [
    { ownedAssetIds: [] }, { availableProductIds: [] }, { sessionId: '22222222-2222-4222-8222-222222222222' },
    { inputRevision: 3 }, { consentId: '22222222-2222-4222-8222-222222222222' },
  ]) assert.throws(() => showroom.parseAcceptedStudioSnapshot(fixture, { ...authority, ...change }), ShowroomContractError);
  for (const change of [
    { providerTransfer: false }, { personalization: false }, { likeness: false }, { capture: false }, { inputRevision: 3 },
  ]) assert.equal(showroom.StudioInputSchema.safeParse({
    ...fixture.input, consent: { ...fixture.input.consent, ...change },
  }).success, false);
  assert.equal(showroom.SessionVisitorSchema.safeParse({ ...fixture.input.visitor, source: 'enrolled' }).success, false);
});

test('capture sets require one to four unique owned references and primary membership', () => {
  const fixture = examples.AcceptedStudioSnapshotSchema.input.captureSet;
  for (const change of [
    { references: [] }, { primaryAssetId: id },
    { references: [fixture.references[0], fixture.references[0]] },
    { references: Array(5).fill(fixture.references[0]) },
  ]) assert.equal(showroom.CaptureSetSchema.safeParse({ ...fixture, ...change }).success, false);
  const views = ['front_face', 'half_body', 'profile', 'three_quarter'];
  const references = views.map((view, index) => ({
    view, assetId: `22222222-2222-4222-8222-22222222222${index}`,
  }));
  assert.equal(showroom.CaptureSetSchema.safeParse({ ...fixture, references, primaryAssetId: references[0]?.assetId }).success, true);
});

test('voice retains bounded SDP exchange and cannot introduce a provider credential', () => {
  assert.equal(showroom.ShowroomVoiceSetupInputSchema.safeParse({ sdp: 'v=0\r\n', generation: 1 }).success, true);
  for (const sdp of ['', 'no-sdp', 'v=1\r\n', 'v=0\r\n' + 'x'.repeat(128 * 1024),
    'v=0\r\n' + '\u00e9'.repeat(70_000)]) {
    assert.equal(showroom.ShowroomVoiceSetupInputSchema.safeParse({ sdp }).success, false);
  }
  assert.equal(showroom.ShowroomVoiceSetupSchema.safeParse({
    ...examples.ShowroomVoiceSetupSchema, clientSecret: 'not-allowed',
  }).success, false);
  assert.equal(showroom.ShowroomReferenceUploadQuerySchema.safeParse({ expectedRevision: 1, eventId: id }).success, true);
  assert.equal(showroom.ShowroomReferenceUploadQuerySchema.safeParse({ expectedRevision: 1 }).success, false);
});

test('bridge credentials separate roles and acknowledgement never claims physical execution', () => {
  assert.equal(bridge.BridgeCredentialSchema.safeParse(examples.OperatorCredentialSchema).success, false);
  assert.equal(bridge.OperatorCredentialSchema.safeParse({
    ...examples.OperatorCredentialSchema, purpose: 'all', bridgeToken: 'not-allowed',
  }).success, false);
  assert.equal(bridge.BridgeAcknowledgementSchema.safeParse({
    ...examples.BridgeAcknowledgementSchema, status: 'executed',
  }).success, false);
  assert.equal(bridge.BridgeServerMessageSchema.safeParse({
    ...examples.BridgeServerMessageSchema, generation: undefined,
  }).success, false);
});

test('motion readback binds stable intent while execution requires a new scoped tracking sample', () => {
  const { tracking, ...command } = examples.BridgeCommandSchema;
  const approval = {
    intent: command.intent, speed: command.speed, pulseMs: command.pulseMs,
    leaseId: command.leaseId, leaseGeneration: command.leaseGeneration,
  };
  assert.equal(bridge.MotionApprovalSchema.safeParse(approval).success, true);
  assert.equal(bridge.MotionApprovalSchema.safeParse({ ...approval, tracking }).success, false);
  const action = { schemaVersion: 1, eventId: id, expectedRevision: 3,
    type: 'motion_execution_requested', payload: { grantId: id, tracking } };
  assert.equal(showroom.ShowroomActionSchema.safeParse(action).success, true);
  assert.equal(showroom.ShowroomActionSchema.safeParse({ ...action, payload: { tracking } }).success, false);
  assert.equal(bridge.MotionIntentSchema.safeParse(approval).success, false);
});

test('exported examples validate against the actual schemas and mirrored artifacts match their hashes', async () => {
  const schemas = new Map<string, z.ZodType>();
  for (const [name, value] of Object.entries({ ...showroom, ...bridge })) {
    if (value instanceof z.ZodType) schemas.set(name, value);
  }
  for (const [name, value] of Object.entries(examples)) {
    const schema = schemas.get(name);
    assert.ok(schema, `Missing executable schema ${name}`);
    assert.equal(schema.safeParse(value).success, true, `Invalid fixture ${name}`);
  }
  const output = new URL('../interfaces/showroom-v1/', import.meta.url);
  const mirror = new URL('../../MoviePart/integration/dwight/showroom-v1/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', output), 'utf8'));
  assert.deepEqual((await readdir(output)).sort(), (await readdir(mirror)).sort());
  for (const file of await readdir(output)) {
    const content = (await readFile(new URL(file, output), 'utf8')).replace(/\r\n/g, '\n');
    assert.equal((await readFile(new URL(file, mirror), 'utf8')).replace(/\r\n/g, '\n'), content);
    if (file !== 'manifest.json') {
      assert.equal(createHash('sha256').update(content).digest('hex'), manifest.generatedFiles[file]);
    }
  }
});
