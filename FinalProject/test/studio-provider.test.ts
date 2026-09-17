import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AcceptedStudioSnapshotSchema } from '../src/contracts/showroom.js';
import { createStudioProvider } from '../src/providers/studio.js';
import { ProviderFailure } from '../src/providers/http-client.js';
import { validateStudioVideo } from '../src/providers/studio-video.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

async function fixture(t: TestContext, behavior: {
  lostUpload?: boolean; lostSubmit?: boolean; cleanupPending?: number; badFingerprint?: boolean; badVideo?: boolean;
  abortOnSubmit?: AbortController;
} = {}) {
  await mkdir(resolve('.runtime', 'tests'), { recursive: true });
  const directory = await mkdtemp(resolve('.runtime', 'tests', 'studio-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const sessionId = randomUUID(), photoId = randomUUID(), consentId = randomUUID(), snapshotId = randomUUID();
  const snapshot = AcceptedStudioSnapshotSchema.parse({
    schemaVersion: 1, snapshotId, acceptedAt: Date.now(), acceptedRevision: 10,
    pendingActionId: randomUUID(), confirmationFingerprint: 'a'.repeat(64),
    input: {
      mode: 'studio', sessionId, inputRevision: 5,
      visitor: { visitorId: randomUUID(), sessionId, source: 'self_reported', displayName: 'Test visitor' },
      consent: { consentId, inputRevision: 5, recordedAt: Date.now(), policyVersion: 'showroom-v1',
        personalization: true, capture: true, likeness: true, providerTransfer: true, calendar: false, motion: false },
      context: { signals: [{ value: 'hiking', source: 'manual', visualUseAllowed: true, confidence: null }] },
      selection: { productId: 'toyota-camry', templateId: 'DREAM_ROUTE', heroMode: 'LIKENESS',
        productionMode: 'reviewed-storyboard', enableHeroVideo: true, videoProvider: 'google-veo',
        storyFormat: 'four-shot', renderLayout: 'video-bookends', movieDurationSeconds: 15 },
      captureSet: { captureSetId: randomUUID(), sessionId, consentId, inputRevision: 5,
        references: [{ assetId: photoId, view: 'front_face' }], primaryAssetId: photoId },
    },
  });
  const remotePhotoId = randomUUID(), jobId = randomUUID(), videoId = randomUUID();
  let uploaded = false, submitted = false, jobDeleted = false, batchDeleted = false;
  let uploadPosts = 0, jobPosts = 0, cleanupCalls = 0, validations = 0;
  let requestFingerprint = '';
  const paths: string[] = [];
  const response = (body: unknown, status = 200) => Response.json(body, { status });
  const uploadReceipt = () => ({ key: snapshotId, fingerprint: 'b'.repeat(64),
    state: batchDeleted ? 'cancelled' : 'uploaded', assetIds: [remotePhotoId], assetsDeleted: batchDeleted });
  const fakeFetch: typeof fetch = async (target, init = {}) => {
    const url = new URL(target instanceof Request ? target.url : String(target));
    const route = url.pathname;
    paths.push(`${init.method ?? 'GET'} ${route}`);
    assert.equal(url.origin, 'http://127.0.0.1:3200');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), 'Bearer fake-studio-token');
    assert.equal(init.redirect, 'error');
    if (route !== '/api/movie-config') assert.equal(headers.get('x-movie-session-id'), sessionId);
    if (route === '/api/movie-config') return response({
      products: [{ id: 'toyota-camry', name: 'Toyota Camry', ready: true }],
      templates: [{ id: 'DREAM_ROUTE', name: 'Dream Route' }],
      providers: { openai: { available: true }, veo: { available: true }, openaiVideo: { available: false } },
      worker: { available: true }, renderer: { available: true },
    });
    if (route === '/api/movie-assets' && init.method === 'POST') {
      uploadPosts++;
      assert.equal(headers.get('idempotency-key'), snapshotId);
      assert.ok(init.body instanceof FormData);
      assert.equal(init.body.getAll('photos').length, 1);
      uploaded = true;
      if (behavior.lostUpload) throw new Error('Simulated lost upload response');
      return response({ receipt: uploadReceipt(), assets: [{ id: remotePhotoId, mime: 'image/jpeg', width: 10, height: 10 }] }, 201);
    }
    if (route === `/api/movie-upload-batches/${snapshotId}`) {
      if (init.method === 'DELETE') { assert.equal(init.signal?.aborted, false); batchDeleted = jobDeleted; return response({ receipt: uploadReceipt() }, batchDeleted ? 200 : 202); }
      return uploaded ? response({ receipt: uploadReceipt() }) : response({}, 404);
    }
    if (route === '/api/movie-jobs' && init.method === 'POST') {
      jobPosts++;
      const input: Record<string, unknown> = JSON.parse(String(init.body));
      assert.equal(input.session_id, sessionId); assert.equal(input.idempotency_key, snapshotId);
      assert.equal(input.primary_reference_asset_id, remotePhotoId);
      assert.deepEqual(input.customer_reference_asset_ids, [remotePhotoId]);
      assert.equal(input.video_provider, 'google-veo'); assert.equal(input.render_layout, 'video-bookends');
      assert.deepEqual(input.personalization_profile, snapshot.input.context);
      requestFingerprint = behavior.badFingerprint ? 'f'.repeat(64) : hash(input);
      submitted = true;
      if (behavior.abortOnSubmit) { behavior.abortOnSubmit.abort(); throw new Error('Simulated cancelled submission'); }
      if (behavior.lostSubmit) throw new Error('Simulated lost accepted response');
      return response({ job_id: jobId, status: 'RECEIVED', status_url: `/api/movie-jobs/${jobId}` }, 202);
    }
    if (route === `/api/movie-job-requests/${snapshotId}`) {
      if (init.method === 'DELETE') {
        assert.equal(init.signal?.aborted, false);
        jobDeleted = ++cleanupCalls > (behavior.cleanupPending ?? 0);
        return response({ receipt: { jobId: submitted ? jobId : null, fingerprint: submitted ? requestFingerprint : null,
          cancelledAt: new Date().toISOString(), assetsDeleted: jobDeleted } }, jobDeleted ? 200 : 202);
      }
      return submitted ? response({ receipt: { jobId, fingerprint: requestFingerprint } }) : response({}, 404);
    }
    if (route === `/api/movie-jobs/${jobId}`) return response({ job: {
      id: jobId, sessionId, status: 'COMPLETED', productionMode: 'reviewed-storyboard',
      events: [{ stage: 'COMPLETED', message: 'Explicit fake result' }], hero: { provider: 'Google Veo' }, error: null,
      result: { assetId: videoId, durationSeconds: 15, mode: 'hybrid-video', renderLayout: 'video-bookends' },
    } });
    if (route === `/api/movie-assets/${videoId}`) return new Response(new Uint8Array(32), { headers: { 'content-type': 'video/mp4' } });
    throw new Error(`Unexpected fake route ${route}`);
  };
  const provider = createStudioProvider({
    baseUrl: 'http://127.0.0.1:3200', token: 'fake-studio-token', directory,
    fetch: fakeFetch, pollMs: 1, cleanupAttempts: 3,
    validateVideo: behavior.badVideo ? validateStudioVideo : async (_bytes, duration) => { assert.equal(duration, 15); validations++; },
  });
  return {
    provider, snapshot, directory, paths, fakeFetch,
    photos: [{ assetId: photoId, bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' }],
    counts: () => ({ uploadPosts, jobPosts, cleanupCalls, validations, jobDeleted, batchDeleted }),
  };
}

test('full studio adapter maps accepted originals/intent and reconciles lost upload and job responses once', async t => {
  const f = await fixture(t, { lostUpload: true, lostSubmit: true });
  const stages: string[] = [];
  const output = await f.provider.generate(f.snapshot, f.photos, new AbortController().signal, stage => stages.push(stage));
  assert.equal(output.provenance, 'generated');
  assert.equal(output.renderMode, 'hybrid-video');
  assert.deepEqual(stages, ['completed']);
  assert.deepEqual(f.counts(), { uploadPosts: 1, jobPosts: 1, cleanupCalls: 1, validations: 1, jobDeleted: true, batchDeleted: true });
  const receipt = JSON.parse(await readFile(resolve(f.directory, `${f.snapshot.snapshotId}.json`), 'utf8'));
  assert.equal(receipt.cleanupRequired, false);
  await assert.rejects(f.provider.generate(f.snapshot, f.photos, new AbortController().signal, () => {}), /already settled/);
  assert.equal(f.paths.some(path => path.includes('/jobs/by-key/') || path.includes('/capabilities')), false);
});

test('pending worker cleanup delays readiness until BOTH job and batch acknowledge deletion', async t => {
  const f = await fixture(t, { cleanupPending: 2 });
  await f.provider.generate(f.snapshot, f.photos, new AbortController().signal, () => {});
  assert.equal(f.counts().cleanupCalls, 3);
  assert.equal(f.counts().batchDeleted, true);
});

test('persistent cleanup uncertainty never returns a movie and startup recovers the same keys without another submit', async t => {
  const behavior = { cleanupPending: 10 };
  const f = await fixture(t, behavior);
  await assert.rejects(f.provider.generate(f.snapshot, f.photos, new AbortController().signal, () => {}),
    error => error instanceof ProviderFailure && error.code === 'STUDIO_CLEANUP_PENDING');
  assert.equal(JSON.parse(await readFile(resolve(f.directory, `${f.snapshot.snapshotId}.json`), 'utf8')).cleanupRequired, true);
  behavior.cleanupPending = 0;
  const restarted = createStudioProvider({ baseUrl: 'http://127.0.0.1:3200', token: 'fake-studio-token', directory: f.directory, fetch: f.fakeFetch, pollMs: 1 });
  await restarted.recoverCleanup();
  assert.equal(f.counts().jobPosts, 1);
  assert.equal(JSON.parse(await readFile(resolve(f.directory, `${f.snapshot.snapshotId}.json`), 'utf8')).cleanupRequired, false);
});

test('a revoked submission still uses a live independent cleanup signal and fences its uncertain job', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { abortOnSubmit: controller });
  await assert.rejects(f.provider.generate(f.snapshot, f.photos, controller.signal, () => {}));
  assert.equal(f.counts().jobPosts, 1);
  assert.equal(f.counts().jobDeleted, true);
  assert.equal(f.counts().batchDeleted, true);
});

test('wrong request fingerprints and non-MP4 output fail honestly and still reclaim owned transfers', async t => {
  const mismatch = await fixture(t, { badFingerprint: true });
  await assert.rejects(mismatch.provider.generate(mismatch.snapshot, mismatch.photos, new AbortController().signal, () => {}), /fingerprint/);
  assert.equal(mismatch.counts().jobDeleted, true);
  const invalid = await fixture(t, { badVideo: true });
  await assert.rejects(invalid.provider.generate(invalid.snapshot, invalid.photos, new AbortController().signal, () => {}), /not an MP4/);
  assert.equal(invalid.counts().jobDeleted, true);
});

test('studio credentials cannot be sent to a browser-selected or remote destination', () => {
  for (const baseUrl of ['https://example.test', 'http://127.0.0.1:3200/path', 'http://user@127.0.0.1:3200', 'http://127.0.0.1:3200/?token=x']) {
    assert.throws(() => createStudioProvider({ baseUrl, token: 'fake' }), /loopback origin/);
  }
});

test('staged MP4 validation decodes the exact real 720p timeline and rejects a different promised duration', async t => {
  await mkdir(resolve('.runtime', 'tests'), { recursive: true });
  const directory = await mkdtemp(resolve('.runtime', 'tests', 'studio-video-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const bytes = new Uint8Array(await readFile(new URL('../fixtures/media/default-demo.mp4', import.meta.url)));
  await validateStudioVideo(bytes, 10, new AbortController().signal, { directory: resolve(directory, 'validation') });
  await assert.rejects(validateStudioVideo(bytes, 15, new AbortController().signal, { directory: resolve(directory, 'validation') }), /promised 720p/);
});

test('pending cleanup cannot move to a different credential or studio origin after restart', async t => {
  const behavior = { cleanupPending: 10 };
  const f = await fixture(t, behavior);
  await assert.rejects(f.provider.generate(f.snapshot, f.photos, new AbortController().signal, () => {}), /deletion is not confirmed/);
  const filename = resolve(f.directory, `${f.snapshot.snapshotId}.json`);
  const original = await readFile(filename, 'utf8');
  const receipt = JSON.parse(original);
  assert.match(receipt.ownerFingerprint, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(original, /fake-studio-token/);
  for (const changed of [
    { baseUrl: 'http://127.0.0.1:3200', token: 'rotated-studio-token' },
    { baseUrl: 'http://127.0.0.1:3299', token: 'fake-studio-token' },
  ]) {
    let calls = 0;
    const restarted = createStudioProvider({
      ...changed, directory: f.directory, fetch: async () => {
        calls++; return Response.json({ receipt: { jobId: null, fingerprint: null, assetsDeleted: true } });
      },
    });
    await assert.rejects(restarted.recoverCleanup(), error =>
      error instanceof ProviderFailure && error.code === 'STUDIO_CLEANUP_OWNER_MISMATCH' && error.acceptanceUncertain);
    assert.equal(calls, 0);
    assert.equal(await readFile(filename, 'utf8'), original);
  }
  behavior.cleanupPending = 0;
  await f.provider.recoverCleanup();
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).cleanupRequired, false);
  assert.equal(f.counts().jobPosts, 1);
});

test('legacy unbound pending receipts fail closed rather than trusting empty-owner tombstones', async t => {
  const f = await fixture(t, { cleanupPending: 10 });
  await assert.rejects(f.provider.generate(f.snapshot, f.photos, new AbortController().signal, () => {}), /deletion is not confirmed/);
  const filename = resolve(f.directory, `${f.snapshot.snapshotId}.json`);
  const receipt = JSON.parse(await readFile(filename, 'utf8'));
  delete receipt.ownerFingerprint;
  await writeFile(filename, JSON.stringify(receipt));
  let calls = 0;
  const restarted = createStudioProvider({
    baseUrl: 'http://127.0.0.1:3200', token: 'fake-studio-token', directory: f.directory,
    fetch: async () => { calls++; throw new Error('An unbound pending receipt must not send cleanup requests.'); },
  });
  await assert.rejects(restarted.recoverCleanup(), error => error instanceof ProviderFailure && error.code === 'STUDIO_CLEANUP_OWNER_MISMATCH');
  assert.equal(calls, 0);
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).cleanupRequired, true);
  await writeFile(filename, JSON.stringify({ ...receipt, cleanupRequired: false }));
  await restarted.recoverCleanup();
  assert.equal(calls, 0);
});
