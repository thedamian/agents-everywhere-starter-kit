import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import sharp from "sharp";
import { getTimeline, MovieError, type CharacterReference, type FrameDecisionRequest, type MoviePlan, type StoryboardFrame } from "../src/domain";
import { isFrameApproved, selectStoryboardFrames } from "../src/domain/storyboard-state";
import { JobStore } from "../src/jobs/store";
import { MovieWorker } from "../src/jobs/worker";
import { retrySummary, validateApprovedFrame, validateHeroEndpoints } from "../src/jobs/retry";
import { LocalMediaRepository, normalizeImage } from "../src/server/media";
import { createApiHandlers, jobView } from "../src/server/api";
import { SessionAuth } from "../src/server/auth";
import type { MovieConfig } from "../src/domain/services";

const consent = { likeness: true, personalization: true } as const;
function decision(action: "keep" | "regenerate" = "keep"): FrameDecisionRequest {
  return { action, note: "Image 2 is fine; continue to image 3.", idempotency_key: randomUUID(), expected_revision: 0, expected_attempt: 0, resume: false };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "movie-design-"));
  const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const media = new LocalMediaRepository(directory);
  const store = new JobStore(directory);
  const config: MovieConfig = { dataDir: directory, imageModel: "test", veoModel: "test", openaiKey: "test", visionModel: "test", directorModel: "test" };
  const handlers = createApiHandlers(config, { media, store, rendererReady: async () => ({ available: true, message: "Test renderer" }) });
  const initial = await handlers.config(new Request("http://localhost:3200/api/movie-config", { headers: { host: "localhost:3200" } }));
  const cookie = initial.headers.get("set-cookie")!.split(";")[0];
  const { ownerId } = await new SessionAuth(config).authenticate(new Request("http://localhost:3200/", { headers: { host: "localhost:3200", cookie } }));
  const png = await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#446688" } }).png().toBuffer();
  const photo = await media.saveCustomer({ ownerId, consent, image: await normalizeImage(png) });
  const products = await Promise.all(["red", "black"].map(async color => media.saveProduct(await sharp({ create: { width: 32, height: 32, channels: 3, background: color } }).png().toBuffer())));
  const job = await store.create(ownerId, {
    schema_version: 1, session_id: "test-session", idempotency_key: randomUUID(),
    customer_reference_asset_ids: [photo.id], primary_reference_asset_id: photo.id, consent,
    product_id: "car", personalization_profile: { signals: [] }, preferred_template: "DREAM_ROUTE", enable_hero_video: false,
  }, {
    id: "car", version: 1, name: "Test car", make: null, model: null, exteriorColor: "red", interiorColor: "black",
    appearance: "Synthetic test", usagePermission: "Synthetic test", approvedClaims: [],
    referenceImages: products.map((asset, index) => ({ assetId: asset.id, role: index ? "interior" : "exterior", origin: "original" })),
  });
  const character: CharacterReference = {
    id: randomUUID(), version: 1, primaryAssetId: photo.id, sourceImages: [{ assetId: photo.id, role: "primary", origin: "original" }], consent,
    attributes: { face: null, eyes: null, eyebrows: null, nose: null, mouth: null, hair: null, complexion: null, visibleProportions: null, wardrobe: "Source outfit", accessories: [] },
  };
  const timeline = getTimeline();
  const plan: MoviePlan = {
    id: randomUUID(), characterId: character.id, productId: "car", templateId: "DREAM_ROUTE", templateVersion: 1, referenceVersion: 1,
    durationSeconds: 18, aspectRatio: "16:9", heroShotId: "shot_03", logline: "Test story", wardrobe: "Source outfit", cinematicStyle: "Warm", worldTransitions: "None", personalizationUsed: [],
    shots: timeline.shotIds.map((id, i) => ({
      id, durationSeconds: timeline.durations[i], purpose: "Story beat", camera: "Medium", action: "Drive", environment: "Road",
      lighting: "Day", personalization: [], imagePrompt: "References", motionPrompt: "Movement", audioCues: [],
    })),
  };
  const frames: StoryboardFrame[] = [];
  for (const [index, shotId] of timeline.shotIds.entries()) {
    const asset = await media.saveAsset({ ownerId, jobId: job.id, kind: "storyboard", mime: "image/png", bytes: png, width: 1280, height: 720 });
    frames.push({ shotId, assetId: asset.id, provider: "test", model: "test", continuity: { verdict: index === 1 ? "RETRY" : "PASS", reasons: index === 1 ? ["Small clothing texture difference"] : [], confidence: 0.8 } });
  }
  await store.update(job.id, current => {
    current.character = character; current.plan = plan; current.frames = frames; current.status = "FAILED";
    current.error = { code: "CONTINUITY_REJECTED", stage: "VALIDATING", message: "Image 2 rejected by critic" };
  });
  const request = (input: unknown, requestCookie = cookie) => new Request(`http://localhost:3200/api/movie-jobs/${job.id}/frames/${frames[1].assetId}/decision`, {
    method: "POST", headers: { host: "localhost:3200", origin: "http://localhost:3200", cookie: requestCookie, "content-type": "application/json" }, body: JSON.stringify(input),
  });
  return { directory, media, store, job, frames, plan, character, handlers, config, ownerId, request,
    cleanup: (fn: () => Promise<void>) => { cleanups.push(fn); } };
}

test("designer keeps image 2 without rewriting the AI verdict and resumes atomically", async t => {
  const f = await fixture(t);
  const token = await f.store.acquireWorker();
  f.cleanup(() => f.store.releaseWorker(token));
  const input = { ...decision(), resume: true };
  const response = await f.handlers.decideFrame(f.request(input), f.job.id, f.frames[1].assetId);
  assert.equal(response.status, 200);
  const { job } = await response.json();
  assert.equal(job.status, "RECEIVED");
  assert.equal(job.reviewRevision, 1);
  assert.equal(job.retry.attempt, 1);
  const saved = await f.store.get(f.job.id);
  assert.deepEqual(saved.plan, f.plan);
  assert.equal(saved.frames[1].continuity.verdict, "RETRY");
  assert.equal(saved.frames[1].designerDecision?.action, "keep");
  assert.equal(saved.frames[1].designerDecision?.note, input.note);
  assert.equal(isFrameApproved(saved.frames[1]), true);
  assert.equal(retrySummary(saved).remainingShots, 0);
  assert.equal(saved.designerDecisions?.length, 1);
  const replay = await f.handlers.decideFrame(f.request(input), f.job.id, f.frames[1].assetId);
  assert.equal(replay.status, 200);
  assert.equal((await f.store.get(f.job.id)).retries?.length, 1);
  const changed = await f.handlers.decideFrame(f.request({ ...input, note: "Different decision" }), f.job.id, f.frames[1].assetId);
  assert.equal(changed.status, 409);
});

test("regenerate preserves evidence but invalidates earlier approvals and retains the designer prompt", async t => {
  const f = await fixture(t);
  const second = { ...f.frames[1], continuity: { verdict: "PASS" as const, reasons: [], confidence: 1 } };
  await f.store.update(f.job.id, job => { job.frames[1] = second; });
  const input = { ...decision("regenerate"), note: "Use a wider camera angle." };
  assert.equal((await f.handlers.decideFrame(f.request(input), f.job.id, second.assetId)).status, 200);
  const updated = await f.store.get(f.job.id);
  assert.equal(updated.frames[1].continuity.verdict, "PASS");
  assert.equal(isFrameApproved(updated.frames[1]), false);
  assert.equal(updated.frames[1].designerDecision?.note, input.note);
  assert.equal(updated.status, "FAILED");
  assert.equal(updated.retries, undefined);
  assert.equal(retrySummary(updated).remainingShots, 1);
});

test("active designer keep is not overwritten by late AI review and finalization locks edits", async t => {
  const f = await fixture(t);
  await f.store.update(f.job.id, job => { job.status = "RECEIVED"; job.error = null; });
  const worker = new MovieWorker(f.config, {
    store: f.store, media: f.media,
    execute: async (_job, context) => {
      await context.report({ stage: "VALIDATING", message: "AI review in flight" });
      const kept = await f.handlers.decideFrame(f.request({ ...decision(), resume: true }), f.job.id, f.frames[1].assetId);
      assert.equal(kept.status, 200);
      assert.equal((await f.store.get(f.job.id)).retries, undefined);
      await context.saveFrame({ ...f.frames[1], continuity: { verdict: "RETRY", reasons: ["Late AI criticism"], confidence: 0.9 } });
      const current = await context.getFrames!();
      assert.equal(current[1].designerDecision?.action, "keep");
      assert.equal(current[1].continuity.verdict, "RETRY");
      const approved = await context.finalizeStoryboard!();
      assert.equal(approved.length, 4);
      assert.ok(approved.every(isFrameApproved));
      const locked = await f.handlers.decideFrame(f.request({ ...decision("regenerate"), expected_revision: 1 }), f.job.id, f.frames[1].assetId);
      assert.equal(locked.status, 409);
      const video = await f.media.saveAsset({ ownerId: f.ownerId, jobId: f.job.id, kind: "video", mime: "video/mp4", bytes: new Uint8Array([1]) });
      return { assetId: video.id, mode: "storyboard-motion", durationSeconds: 18, hasAudio: false };
    },
  });
  await worker.start();
  f.cleanup(() => worker.stop());
  await worker.runOnce();
  const saved = await f.store.get(f.job.id);
  assert.equal(saved.status, "COMPLETED", saved.error?.message);
  assert.equal(saved.storyboardLocked, true);
  assert.equal(jobView(saved).designerReviewAllowed, false);
});

test("ownership, stale decisions, extracted frames and invalid media cannot be bypassed by a keep note", async t => {
  const f = await fixture(t);
  const forged = await f.handlers.decideFrame(f.request(decision(), "movie_session=wrong"), f.job.id, f.frames[1].assetId);
  assert.equal(forged.status, 401);
  assert.equal((await f.handlers.decideFrame(f.request({ ...decision(), expected_revision: 1 }), f.job.id, f.frames[1].assetId)).status, 409);
  assert.equal((await f.handlers.decideFrame(f.request({ ...decision(), action: "override-safety" }), f.job.id, f.frames[1].assetId)).status, 400);
  await f.store.update(f.job.id, job => { job.frames[1].source = "extracted"; });
  assert.equal((await f.handlers.decideFrame(f.request(decision()), f.job.id, f.frames[1].assetId)).status, 404);
  await f.store.update(f.job.id, job => { delete job.frames[1].source; });
  const outside = await f.media.saveAsset({ ownerId: "someone-else", jobId: f.job.id, kind: "storyboard", mime: "image/png", bytes: new Uint8Array([1]) });
  await f.store.update(f.job.id, job => { job.frames[1].assetId = outside.id; });
  assert.equal((await f.handlers.decideFrame(f.request(decision()), f.job.id, outside.id)).status, 409);
});

test("selected older candidate is authoritative while other candidates and AI verdicts stay inspectable", async t => {
  const f = await fixture(t);
  const newer = await f.media.saveAsset({ ownerId: f.ownerId, jobId: f.job.id, kind: "storyboard", mime: "image/png", bytes: await f.media.readAsset(f.frames[1].assetId), width: 1280, height: 720 });
  await f.store.update(f.job.id, job => { job.frames.push({ ...f.frames[1], assetId: newer.id, continuity: { verdict: "PASS", reasons: [], confidence: 1 } }); });
  assert.equal((await f.handlers.decideFrame(f.request(decision()), f.job.id, f.frames[1].assetId)).status, 200);
  const saved = await f.store.get(f.job.id);
  assert.equal(selectStoryboardFrames(saved.frames, ["shot_02"])[0].assetId, f.frames[1].assetId);
  assert.equal(saved.frames.at(-1)?.continuity.verdict, "PASS");
  assert.equal(saved.frames.at(-1)?.designerDecision?.action, "regenerate");
  await validateApprovedFrame(saved.frames[1], {
    ownerId: f.ownerId, jobId: f.job.id, media: f.media, signal: new AbortController().signal,
  });

  test("designer selects distinct approved Veo start and end frames with durable revision checks", async t => {
    const f = await fixture(t);
    await f.store.update(f.job.id, job => {
      job.request.enable_hero_video = true;
      job.request.video_provider = "google-veo";
      job.request.render_layout = "video-bookends";
      job.request.movie_duration_seconds = 15;
      job.plan!.videoProvider = "google-veo";
      job.error = {
        code: "HERO_ENDPOINT_SELECTION_REQUIRED", stage: "VALIDATING",
        message: "Choose approved storyboard endpoints.",
      };
    });
    const awaitingEndpoints = await f.store.get(f.job.id);
    assert.throws(() => validateHeroEndpoints(awaitingEndpoints), (error: unknown) =>
      error instanceof MovieError && error.code === "HERO_ENDPOINT_SELECTION_REQUIRED");
    const request = (body: unknown) => new Request(`http://localhost:3200/api/movie-jobs/${f.job.id}/hero-endpoints`, {
      method: "POST",
      headers: { host: "localhost:3200", origin: "http://localhost:3200", cookie: f.request(decision()).headers.get("cookie")!, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const start = {
      role: "start" as const, asset_id: f.frames[0].assetId, idempotency_key: randomUUID(),
      expected_revision: 0, expected_attempt: 0,
    };
    const first = await f.handlers.selectHeroEndpoint(request(start), f.job.id);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).job.heroEndpoints.startAssetId, f.frames[0].assetId);
    const identical = await f.handlers.selectHeroEndpoint(request({
      role: "end", asset_id: f.frames[0].assetId, idempotency_key: randomUUID(),
      expected_revision: 1, expected_attempt: 0,
    }), f.job.id);
    assert.equal(identical.status, 409);
    const end = {
      role: "end" as const, asset_id: f.frames[2].assetId, idempotency_key: randomUUID(),
      expected_revision: 1, expected_attempt: 0,
    };
    const second = await f.handlers.selectHeroEndpoint(request(end), f.job.id);
    assert.equal(second.status, 200);
    const view = (await second.json()).job;
    assert.deepEqual(view.heroEndpoints, { startAssetId: f.frames[0].assetId, endAssetId: f.frames[2].assetId });
    assert.deepEqual(validateHeroEndpoints(await f.store.get(f.job.id)), {
      startAssetId: f.frames[0].assetId, endAssetId: f.frames[2].assetId,
    });
    assert.equal(view.heroEndpointRevision, 2);
    assert.equal(view.heroEndpointSelectionAllowed, true);
    assert.equal((await f.handlers.selectHeroEndpoint(request(start), f.job.id)).status, 200, "idempotent replay");
    assert.equal((await f.handlers.selectHeroEndpoint(request({
      ...end, asset_id: f.frames[3].assetId, idempotency_key: randomUUID(), expected_revision: 1,
    }), f.job.id)).status, 409, "stale endpoint revision");
  });
});
