import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getTimeline, MovieError, type JobRequest, type ProductReference } from "../src/domain";
import type { MovieConfig } from "../src/domain/services";
import { JobStore } from "../src/jobs/store";
import { MovieWorker } from "../src/jobs/worker";
import { LocalMediaRepository, normalizeImage } from "../src/server/media";
import sharp from "sharp";
import { withDiskLock } from "../src/server/files";

const consent = { likeness: true as const, personalization: true as const };
function request(assetId: string = randomUUID()): JobRequest {
  return {
    schema_version: 1, session_id: "robot-conversation", customer_reference_asset_ids: [assetId], primary_reference_asset_id: assetId,
    consent, product_id: "demo", personalization_profile: { signals: [] }, preferred_template: "DREAM_ROUTE",
    enable_hero_video: false, idempotency_key: randomUUID(),
  };
}
function product(): ProductReference {
  return {
    id: "demo", version: 1, name: "Test fixture", make: null, model: null, exteriorColor: "red", interiorColor: null,
    appearance: "Fixture only", approvedClaims: [], usagePermission: "Synthetic test fixture",
    referenceImages: [{ assetId: randomUUID(), role: "exterior", origin: "original" }, { assetId: randomUUID(), role: "interior", origin: "original" }],
  };
}
async function fixture(t: TestContext) {
  const directory = path.resolve(".movie-data", "tests", `jobs-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const config: MovieConfig = { dataDir: directory, imageModel: "test", veoModel: "test" };
  return { directory, config, store: new JobStore(directory), media: new LocalMediaRepository(directory) };
}

test("a heartbeat failure rejects the worker run instead of reporting a successful exit", async t => {
  const { config, store } = await fixture(t);
  store.heartbeat = async () => { throw new MovieError("WORKER_LOCK_LOST", "The worker no longer owns the queue.", 409); };
  const worker = new MovieWorker(config, { store });
  t.after(() => worker.stop());
  await assert.rejects(worker.run(AbortSignal.timeout(10_000)),
    (error: unknown) => error instanceof MovieError && error.code === "WORKER_LOCK_LOST");
  assert.equal((await store.workerReadiness()).available, false);
});

test("unexpected heartbeat errors are surfaced without private filesystem details or credentials", async t => {
  const { config, store } = await fixture(t);
  store.heartbeat = async () => { throw new Error("private filesystem path and secret-api-key"); };
  const worker = new MovieWorker(config, { store });
  t.after(() => worker.stop());
  await assert.rejects(worker.run(AbortSignal.timeout(10_000)), (error: unknown) => {
    assert.ok(error instanceof MovieError);
    assert.equal(error.code, "WORKER_HEARTBEAT_FAILED");
    assert.doesNotMatch(error.message, /private filesystem path|secret-api-key/);
    return true;
  });
});

test("heartbeat shutdown retains the active job's operation and records the actual lease error", async t => {
  const { config, store } = await fixture(t);
  const queued = await store.create("owner", request(), product());
  store.heartbeat = async () => { throw new MovieError("WORKER_LOCK_LOST", "The worker no longer owns the queue.", 409); };
  const worker = new MovieWorker(config, { store, execute: async (_job, context) => {
    await context.report({ stage: "GENERATING_HERO", message: "Existing video operation", provider: "test" });
    await context.recordOperation("test", "saved-operation");
    return new Promise<never>((_resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      context.signal.throwIfAborted();
    });
  } });
  t.after(() => worker.stop());
  await assert.rejects(worker.run(AbortSignal.timeout(10_000)),
    (error: unknown) => error instanceof MovieError && error.code === "WORKER_LOCK_LOST");
  const failed = await store.get(queued.id);
  assert.equal(failed.error?.code, "WORKER_LOCK_LOST");
  assert.equal(failed.error?.stage, "GENERATING_HERO");
  assert.deepEqual(failed.operations, [{ provider: "test", id: "saved-operation" }]);
  assert.equal(failed.result, null);
});

test("idempotency is owner-scoped and concurrent submissions atomically produce one durable job", async t => {
  const { store, directory } = await fixture(t);
  const input = request();
  const reference = product();
  const jobs = await Promise.all(Array.from({ length: 8 }, () => new JobStore(directory).create("a", input, reference)));
  assert.equal(new Set(jobs.map(job => job.id)).size, 1);
  assert.equal((await new JobStore(directory).get(jobs[0].id)).status, "RECEIVED");
  await assert.rejects(store.create("a", { ...input, session_id: "different" }, reference), /different request/);
  assert.notEqual((await store.create("b", input, reference)).id, jobs[0].id);
  await assert.rejects(store.getOwned(jobs[0].id, "b"), /Job not found/);
  await assert.rejects(store.get("..\\private"), /Job not found/);
});

test("movie duration is part of request idempotency and immutable retry settings", async t => {
  const { store } = await fixture(t);
  const input: JobRequest = {
    ...request(), enable_hero_video: true, video_provider: "google-veo",
    render_layout: "video-bookends", movie_duration_seconds: 28,
  };
  const job = await store.create("owner", input, product());
  assert.equal((await store.get(job.id)).request.movie_duration_seconds, 28);
  assert.equal((await store.create("owner", input, product())).id, job.id);
  await assert.rejects(store.create("owner", { ...input, movie_duration_seconds: 23 }, product()),
    (error: unknown) => error instanceof MovieError && error.code === "IDEMPOTENCY_CONFLICT");
});

test("worker persists all animation segment checkpoints and the requested output length", async t => {
  const { store, media, config, directory } = await fixture(t);
  const queued = await store.create("owner", {
    ...request(), enable_hero_video: true, video_provider: "google-veo",
    render_layout: "video-bookends", movie_duration_seconds: 28,
  }, product());
  const worker = new MovieWorker(config, { store, media, execute: async (job, context, checkpoint) => {
    const segments: NonNullable<typeof job.videoSegments> = [];
    for (let index = 0; index < 3; index++) {
      const operationId = `models/veo/operations/offline-${index}`;
      await context.recordOperation("Google Veo", operationId);
      const asset = await media.saveAsset({
        ownerId: job.ownerId, jobId: job.id, kind: "video", mime: "video/mp4", bytes: new Uint8Array([index]),
      });

      const clip = { assetId: asset.id, shotId: "shot_03" as const, provider: "Google Veo" as const, model: "offline-test" };
      segments.push({ index, submitted: true, operationId, clip });
      await checkpoint({ videoSegments: [...segments], ...(index === 0 ? { hero: clip, heroAttempted: true } : {}) });
    }
    const result = await media.saveAsset({
      ownerId: job.ownerId, jobId: job.id, kind: "video", mime: "video/mp4", bytes: new Uint8Array([9]),
    });
    return { assetId: result.id, durationSeconds: 28, hasAudio: false, mode: "hybrid-video", renderLayout: "video-bookends" };
  } });
  await worker.start();
  try {
    await worker.runOnce();
    const saved = await new JobStore(directory).get(queued.id);
    assert.equal(saved.status, "COMPLETED");
    assert.equal(saved.videoSegments?.length, 3);
    assert.equal(saved.hero?.assetId, saved.videoSegments?.[0].clip?.assetId);
    assert.equal(saved.result?.durationSeconds, 28);
    assert.equal(saved.operations.length, 3);
  } finally { await worker.stop(); }
});

test("worker stops after an uncertain Veo submission without queuing a replacement", async t => {
  const { store, media, config } = await fixture(t);
  const input: JobRequest = {
    ...request(), enable_hero_video: true, video_provider: "google-veo",
    render_layout: "video-bookends", movie_duration_seconds: 13,
  };
  const queued = await store.create("owner", input, product());
  const timeline = getTimeline();
  let retryCalls = 0;
  store.retryOwned = async (id, ownerId, recovery) => {
    retryCalls++;
    return { job: await store.get(id), attempt: 1 };
  };
  const worker = new MovieWorker(config, { store, media, execute: async (job, _context, checkpoint) => {
    const character = {
      id: randomUUID(), version: 1 as const, primaryAssetId: job.request.primary_reference_asset_id,
      sourceImages: [{ assetId: job.request.customer_reference_asset_ids[0], origin: "original" as const, role: "primary" }],
      consent, attributes: {
        face: null, eyes: null, eyebrows: null, nose: null, mouth: null, hair: null,
        complexion: null, visibleProportions: null, wardrobe: null, accessories: [],
      },
    };
    const plan = {
      id: randomUUID(), characterId: character.id, productId: job.product.id,
      templateId: "DREAM_ROUTE" as const, templateVersion: 1 as const, referenceVersion: 1 as const,
      durationSeconds: timeline.durationSeconds, aspectRatio: "16:9" as const,
      heroShotId: timeline.heroShotId, heroMode: "LIKENESS" as const, videoProvider: "google-veo" as const,
      wardrobe: "Unknown", logline: "Test", cinematicStyle: "Test", worldTransitions: "Test",
      personalizationUsed: [],
      shots: timeline.shotIds.map((id, index) => ({
        id, durationSeconds: timeline.durations[index], purpose: "Test", camera: "Test",
        action: "Test", environment: "Road", lighting: "Daylight", personalization: [],
        imagePrompt: "Test", motionPrompt: "Test", audioCues: [],
      })),
    };
    await checkpoint({ character, plan, heroAttempted: true });
    throw new MovieError("VEO_WORKFLOW_FAILED", "The Google Veo workflow could not finish submission.", 502);
  } });
  await worker.start();
  try {
    assert.equal(await worker.runOnce(), true);
    assert.equal(retryCalls, 0);
    const failed = await store.get(queued.id);
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.error?.code, "VEO_WORKFLOW_FAILED");
    assert.equal(failed.retries, undefined);
  } finally {
    await worker.stop();
  }
});

test("worker lease and claim exclude a second worker and preserve live locks", async t => {
  const { store, directory } = await fixture(t);
  const token = await store.acquireWorker();
  assert.equal((await store.workerReadiness()).available, true);
  await assert.rejects(new JobStore(directory).acquireWorker(), /Another local/);
  await store.releaseWorker(randomUUID());
  assert.equal((await store.workerReadiness()).available, true);
  const one = await store.create("owner", request(), product());
  await store.create("owner", request(), product());
  const claims = await Promise.all([store.claim(token), store.claim(token)]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(claims.find(Boolean)?.id, one.id);
  await store.releaseWorker(token);
  assert.equal((await store.workerReadiness()).available, false);
});

test("restart fails interrupted claimed work without repeating paid generation and leaves pending jobs", async t => {
  const { store, directory } = await fixture(t);
  const first = await store.create("owner", request(), product());
  const second = await store.create("owner", request(), product());
  const token = await store.acquireWorker();
  await store.claim(token);
  await store.update(first.id, job => { job.operations.push({ provider: "Veo", id: "paid-operation-1" }); });
  await store.releaseWorker(token);
  const restarted = new JobStore(directory);
  const lease = await restarted.acquireWorker();
  await restarted.recoverInterrupted(lease);
  const failed = await restarted.get(first.id);
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.error?.code, "WORKER_INTERRUPTED");
  assert.equal(failed.operations[0].id, "paid-operation-1");
  assert.equal((await restarted.get(second.id)).status, "RECEIVED");
  assert.equal((await restarted.claim(lease))?.id, second.id);
  await restarted.releaseWorker(lease);
});

test("stale dead worker locks are recovered but stale live workers are never stolen", async t => {
  const { store, directory } = await fixture(t);
  await mkdir(store.directory, { recursive: true });
  const workerFile = path.join(directory, "jobs", "worker.json");
  await writeFile(workerFile, JSON.stringify({ token: randomUUID(), pid: 2147483647, heartbeatAt: "2000-01-01T00:00:00.000Z" }));
  const token = await store.acquireWorker();
  await store.releaseWorker(token);
  await writeFile(workerFile, JSON.stringify({ token: randomUUID(), pid: process.pid, heartbeatAt: "2000-01-01T00:00:00.000Z" }));
  assert.equal((await store.workerReadiness()).available, false);
  await assert.rejects(store.acquireWorker(), /Another local/);
});

test("short disk transactions recover a dead process lock and interrupted recovery guard", async t => {
  const { directory } = await fixture(t);
  const lockDirectory = path.join(directory, "transaction-fixture");
  await mkdir(lockDirectory);
  const dead = JSON.stringify({ token: randomUUID(), pid: 2147483647 });
  await writeFile(path.join(lockDirectory, ".transaction-lock"), dead);
  await writeFile(path.join(lockDirectory, ".transaction-lock.recovery"), dead);
  assert.equal(await withDiskLock(lockDirectory, async () => "recovered"), "recovered");
  assert.equal(await withDiskLock(lockDirectory, async () => "released"), "released");
});

test("claim repairs a manifest committed before pending queue publication", async t => {
  const { store, directory } = await fixture(t);
  const job = await store.create("owner", request(), product());
  await rm(path.join(directory, "jobs", "pending", `${job.id}.json`));
  const token = await store.acquireWorker();
  try { assert.equal((await store.claim(token))?.id, job.id); } finally { await store.releaseWorker(token); }
});

test("worker persists concurrent stages, warnings, frames, operations and completed video", async t => {
  const { store, media, config } = await fixture(t);
  const queued = await store.create("owner", request(), product());
  const worker = new MovieWorker(config, { store, media, execute: async (job, context) => {
    await context.report({ stage: "STORYBOARDING", message: "Making frames", provider: "test" });
    await Promise.all(Array.from({ length: 8 }, (_, index) => context.warn(`warning-${index}`)));
    await Promise.all([
      context.recordOperation("test", "one"), context.recordOperation("test", "two"), context.recordOperation("test", "one"),
    ]);
    const frame = await media.saveAsset({ ownerId: job.ownerId, jobId: job.id, kind: "storyboard", mime: "image/jpeg", bytes: new Uint8Array([1]) });
    await context.saveFrame({ shotId: "shot_01", assetId: frame.id, continuity: { verdict: "PASS", reasons: [], confidence: 1 }, provider: "test", model: "test" });
    const video = await media.saveAsset({ ownerId: job.ownerId, jobId: job.id, kind: "video", mime: "video/mp4", bytes: new Uint8Array([1, 2]) });
    return { assetId: video.id, durationSeconds: 18, hasAudio: false, mode: "storyboard-motion" };
  } });
  await worker.start();
  try {
    assert.equal(await worker.runOnce(), true);
    const done = await store.get(queued.id);
    assert.equal(done.status, "COMPLETED");
    assert.equal(done.warnings.length, 8);
    assert.equal(done.operations.length, 2);
    assert.equal(done.frames.length, 1);
    assert.ok(done.result?.assetId);
    assert.equal(await worker.runOnce(), false);
  } finally { await worker.stop(); }
});

test("worker failure preserves artifacts and stage with a sanitized useful error", async t => {
  const { store, media, config } = await fixture(t);
  const job = await store.create("owner", request(), product());
  const worker = new MovieWorker({ ...config, openaiKey: "secret-key" }, { store, media, execute: async (_, context) => {
    await context.report({ stage: "VALIDATING", message: "Reviewing frame" });
    await context.recordOperation("test", "retain-me");
    throw new MovieError("CONTINUITY_REJECTED", "Continuity failed; secret-key must not leak");
  } });
  await worker.start();
  try {
    await worker.runOnce();
    const failed = await store.get(job.id);
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.error?.stage, "VALIDATING");
    assert.equal(failed.error?.code, "CONTINUITY_REJECTED");
    assert.doesNotMatch(failed.error!.message, /secret-key/);
    assert.equal(failed.operations[0].id, "retain-me");
  } finally { await worker.stop(); }
});

test("frame checkpoints update each asset verdict without discarding rejected retries or hero end images", async t => {
  const { store, media, config } = await fixture(t);
  const queued = await store.create("owner", request(), product());
  const worker = new MovieWorker(config, { store, media, execute: async (job, context) => {
    for (const [index, shotId] of ["shot_03", "shot_03", "shot_03_end"].entries()) {
      const asset = await media.saveAsset({
        ownerId: job.ownerId, jobId: job.id, kind: "storyboard", mime: "image/jpeg", bytes: new Uint8Array([index]),
      });
      const frame = {
        shotId, assetId: asset.id, provider: "test", model: "test",
        continuity: { verdict: "REJECT" as const, reasons: ["Not yet reviewed"], confidence: 0 },
      };
      await context.saveFrame(frame);
      await context.saveFrame({
        ...frame,
        continuity: { verdict: index === 0 ? "REJECT" : "PASS", reasons: index === 0 ? ["Rejected first attempt"] : [], confidence: 0.9 },
      });
    }
    throw new MovieError("TEST_STOP", "Retain reviewed and rejected frames for inspection.");
  } });
  await worker.start();
  try {
    await worker.runOnce();
    const saved = await store.get(queued.id);
    assert.equal(saved.frames.length, 3);
    assert.deepEqual(saved.frames.map(frame => frame.shotId), ["shot_03", "shot_03", "shot_03_end"]);
    assert.deepEqual(saved.frames.map(frame => frame.continuity.verdict), ["REJECT", "PASS", "PASS"]);
    assert.deepEqual(saved.frames[0].continuity.reasons, ["Rejected first attempt"]);
    for (const frame of saved.frames) assert.ok(await media.readAsset(frame.assetId));
  } finally { await worker.stop(); }
});

test("explicit worker shutdown aborts active work before releasing its lock", async t => {
  const { store, media, config } = await fixture(t);
  const job = await store.create("owner", request(), product());
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const worker = new MovieWorker(config, { store, media, execute: async (_, context) => {
    entered();
    await new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    throw new Error("unreachable");
  } });
  await worker.start();
  const run = worker.runOnce();
  await ready;
  await worker.stop();
  await run;
  assert.equal((await store.get(job.id)).error?.code, "WORKER_ABORTED");
  assert.equal((await store.workerReadiness()).available, false);
});

test("deletion requires terminal ownership, removes derivatives and preserves sources shared by another job", async t => {
  const { store, media } = await fixture(t);
  const image = await normalizeImage(await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer());
  const source = await media.saveCustomer({ ownerId: "owner", image, consent });
  const first = await store.create("owner", request(source.id), product());
  const second = await store.create("owner", request(source.id), product());
  const derivative = await media.saveAsset({ ownerId: "owner", jobId: first.id, kind: "video", mime: "video/mp4", bytes: new Uint8Array([1]) });
  await assert.rejects(store.deleteOwned(first.id, "other", media), /not found/);
  await assert.rejects(store.deleteOwned(first.id, "owner", media), /Only completed/);
  await store.update(first.id, job => { job.status = "FAILED"; });
  await store.deleteOwned(first.id, "owner", media);
  assert.equal((await media.getAsset(source.id)).id, source.id);
  await assert.rejects(media.getAsset(derivative.id), /not found/);
  assert.ok(await store.get(second.id));
  await store.update(second.id, job => { job.status = "FAILED"; });
  await store.deleteOwned(second.id, "owner", media);
  await assert.rejects(media.getAsset(source.id), /not found/);
  await assert.rejects(store.create("owner", first.request, first.product), (error: unknown) => error instanceof MovieError && error.code === "JOB_DELETED");
});
