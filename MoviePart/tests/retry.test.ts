import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import sharp from "sharp";
import {
  getTimeline, MovieError, type CharacterReference, type MovieJob, type MoviePlan, type RetryRequest,
  type StoryboardFrame,
} from "../src/domain";
import type { GenerationContext, MovieConfig, RendererService } from "../src/domain/services";
import { JobStore } from "../src/jobs/store";
import { MovieWorker } from "../src/jobs/worker";
import { retrySummary, validateRetryAssets } from "../src/jobs/retry";
import { LocalMediaRepository, normalizeImage } from "../src/server/media";
import { createApiHandlers, jobView } from "../src/server/api";
import { executeMovie, type PipelineServices } from "../src/pipeline";
import { createOpenAIServices, type OpenAITransport } from "../src/providers/openai";
import { createRenderer } from "../src/render";
import { mainStoryboardFrames } from "../src/lib/storyboard-view";

const consent = { likeness: true, personalization: true } as const;
const apiToken = "offline-retry-test-machine";
const ownerId = `machine:${createHash("sha256").update(apiToken).digest("hex")}`;
const action = (expected_attempt = 0): RetryRequest => ({ idempotency_key: randomUUID(), expected_attempt });

async function fixture(t: TestContext, approvedCount = 2) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "movie-retry-"));
  const cleanupActions: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const cleanup of cleanupActions.reverse()) await cleanup();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const config: MovieConfig = {
    dataDir: directory, apiToken, openaiKey: "test-only", visionModel: "test-only",
    directorModel: "test-only", imageModel: "gpt-image-2.5-flare", veoModel: "test-only",
  };
  const media = new LocalMediaRepository(directory);
  const store = new JobStore(directory);
  const square = (background: string) => sharp({ create: { width: 32, height: 32, channels: 3, background } }).png().toBuffer();
  const photo = await media.saveCustomer({ ownerId, consent, image: await normalizeImage(await square("blue")) });
  const exterior = await media.saveProduct(await square("red"));
  const interior = await media.saveProduct(await square("black"));
  const job = await store.create(ownerId, {
    schema_version: 1, session_id: "consented-test-session", idempotency_key: randomUUID(),
    customer_reference_asset_ids: [photo.id], primary_reference_asset_id: photo.id, consent,
    product_id: "test-car", personalization_profile: { signals: [] },
    preferred_template: "DREAM_ROUTE", story_format: "six-shot", hero_mode: "LIKENESS",
    enable_hero_video: false,
  }, {
    id: "test-car", version: 1, name: "Synthetic test car", make: null, model: null,
    exteriorColor: "red", interiorColor: "black", appearance: "Test shapes, not a real vehicle",
    approvedClaims: [], usagePermission: "Synthetic automated test",
    referenceImages: [
      { assetId: exterior.id, origin: "original", role: "exterior" },
      { assetId: interior.id, origin: "original", role: "interior" },
    ],
  });
  const character: CharacterReference = {
    id: randomUUID(), version: 1, primaryAssetId: photo.id,
    sourceImages: [{ assetId: photo.id, origin: "original", role: "primary" }], consent,
    attributes: {
      face: null, eyes: null, eyebrows: null, nose: null, mouth: null, hair: null,
      complexion: null, visibleProportions: null, wardrobe: "Blue jacket", accessories: [],
    },
  };
  const timeline = getTimeline("six-shot", "DREAM_ROUTE");
  const plan: MoviePlan = {
    id: randomUUID(), characterId: character.id, productId: job.product.id,
    templateId: "DREAM_ROUTE", templateVersion: 1, referenceVersion: 1,
    storyFormat: "six-shot", heroMode: "LIKENESS", durationSeconds: timeline.durationSeconds,
    aspectRatio: "16:9", heroShotId: timeline.heroShotId, logline: "A coherent test drive",
    wardrobe: "Blue jacket", cinematicStyle: "Warm", worldTransitions: "One continuous route", personalizationUsed: [],
    shots: timeline.shotIds.map((id, index) => ({
      id, durationSeconds: timeline.durations[index], purpose: `Beat ${index + 1}`,
      camera: "Tracking", action: "Continue the journey", environment: "Departure curb", lighting: "Evening",
      personalization: [], imagePrompt: "Use the original references", motionPrompt: "Slow move", audioCues: [],
    })),
  };
  const png = await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#345678" } }).png().toBuffer();
  const frame = async (shotId: string, verdict: "PASS" | "RETRY" = "PASS", reasons: string[] = []): Promise<StoryboardFrame> => {
    const asset = await media.saveAsset({ ownerId, jobId: job.id, kind: "storyboard", mime: "image/png", bytes: png, width: 1280, height: 720 });
    return { shotId, assetId: asset.id, provider: "Offline fixture", model: "test", continuity: { verdict, reasons, confidence: 0.9 } };
  };
  const frames: StoryboardFrame[] = [];
  for (const id of timeline.shotIds.slice(0, approvedCount)) frames.push(await frame(id));
  if (approvedCount < 6) frames.push(await frame(timeline.shotIds[approvedCount], "RETRY", ["Keep the seatbelt at the console-side buckle.", "Retain the departure curb."]));
  await store.update(job.id, current => {
    current.status = "FAILED"; current.character = character; current.plan = plan; current.frames = frames;
    current.error = { code: "CONTINUITY_REJECTED", message: "Saved visual corrections.", stage: "VALIDATING" };
    current.operations.push({ provider: "OpenAI", id: "original-director-response" });
  });
  const handlers = createApiHandlers(config, { media, store, rendererReady: async () => ({ available: true, message: "Test renderer" }) });
  const request = (body: unknown, token = apiToken) => new Request(`http://127.0.0.1:3200/api/movie-jobs/${job.id}/retry`, {
    method: "POST", headers: { host: "127.0.0.1:3200", authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    directory, config, media, store, job: await store.get(job.id), plan, character, frames, frame, png, handlers, request,
    cleanup: (callback: () => Promise<void>) => { cleanupActions.push(callback); },
    retry: (input = action()) => store.retryOwned(job.id, ownerId, input, current => validateRetryAssets(current, media)),
  };
}

function providers(
  config: MovieConfig, png: Buffer,
  edits: { shotId: string; corrections: string[] }[],
  verdict: () => "PASS" | "RETRY" = () => "PASS",
): Omit<PipelineServices, "renderer"> {
  const transport: OpenAITransport = {
    async edit(input) {
      const data = JSON.parse(input.prompt.split("\n").at(-1)!);
      edits.push({ shotId: data.shot.id, corrections: data.correction });
      return { created: 1, data: [{ b64_json: png.toString("base64") }] };
    },
    async respond(input) {
      assert.equal(input.text?.format?.type, "json_schema");
      if (input.text?.format?.type === "json_schema") assert.equal(input.text.format.name, "visual_continuity_assessment");
      return {
        id: `review-${randomUUID()}`, status: "completed",
        output_text: JSON.stringify({ verdict: verdict(), reasons: ["Fix the departure background."], confidence: 0.9 }),
      };
    },
  };
  return {
    references: { extract: async () => assert.fail("Retry must not re-analyze customer photos") },
    director: { plan: async () => assert.fail("Retry must not regenerate the saved director plan") },
    storyboard: createOpenAIServices(config, { transport }).storyboard,
    video: { generate: async () => assert.fail("Retry must not resubmit a previously attempted video") },
  };
}

test("retry endpoint preserves the plan and approved assets, and concurrent duplicate clicks queue only once", async t => {
  const f = await fixture(t);
  const lease = await f.store.acquireWorker();
  f.cleanup(() => f.store.releaseWorker(lease));
  const body = action();
  const replies = await Promise.all([0, 1, 2].map(() => f.handlers.retryJob(f.request(body), f.job.id)));
  for (const reply of replies) {
    assert.equal(reply.status, 202);
    assert.equal((await reply.json()).retry_attempt, 1);
  }
  const saved = await f.store.get(f.job.id);
  assert.equal(saved.status, "RECEIVED");
  assert.equal(saved.retries?.length, 1);
  assert.equal(saved.retries?.[0].previousError?.code, "CONTINUITY_REJECTED");
  assert.equal(saved.result, null);
  assert.equal(saved.error, null);
  assert.deepEqual(saved.plan, f.plan);
  assert.deepEqual(saved.character, f.character);
  assert.deepEqual(saved.request, f.job.request);
  assert.deepEqual(saved.frames, f.frames);
  assert.deepEqual(jobView(saved).retry, { attempt: 1, eligible: false, approvedShots: 2, remainingShots: 4 });
  assert.equal((await f.handlers.retryJob(f.request({ ...body, expected_attempt: 1 }), f.job.id)).status, 409);
  assert.equal((await f.handlers.retryJob(f.request(action()), f.job.id)).status, 409);
  assert.equal((await f.handlers.retryJob(f.request(body, "invalid-token"), f.job.id)).status, 401);
  const browser = await f.handlers.config(new Request("http://127.0.0.1:3200/api/movie-config", { headers: { host: "127.0.0.1:3200" } }));
  const cookie = browser.headers.get("set-cookie")!.split(";")[0];
  const foreign = new Request(f.request(body).url, {
    method: "POST", headers: { host: "127.0.0.1:3200", origin: "http://127.0.0.1:3200", cookie, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await f.handlers.retryJob(foreign, f.job.id)).status, 404);
});

test("terminal Veo rejection disables legacy retry and designer resume without touching approved work", async t => {
  const f = await fixture(t, 6);
  const operation = { provider: "Google Veo", id: "models/veo-3.1-generate-preview/operations/ended" };
  const codes = ["VEO_GENERATION_FAILED", "VEO_CONTENT_FILTERED", "VEO_OPERATION_QUOTA", "VEO_OPERATION_INVALID", "VEO_OPERATION_ACCESS", "VEO_OPERATION_UNAVAILABLE"];
  for (const code of codes) {
    const saved = await f.store.update(f.job.id, job => {
      job.request.enable_hero_video = true;
      job.request.video_provider = "google-veo";
      job.plan!.videoProvider = "google-veo";
      job.heroAttempted = true;
      job.operations = [operation];
      job.error = { stage: "GENERATING_HERO", code, message: "Previous generic failure text." };
    });
    const view = jobView(saved);
    assert.equal(view.retry?.eligible, false);
    assert.equal(view.designerReviewAllowed, false);
    assert.match(view.error!.message, /operation has ended.*retrying it cannot restart generation/);
    const reply = await f.handlers.retryJob(f.request(action()), f.job.id);
    assert.equal(reply.status, 409);
    assert.equal((await reply.json()).code, "VEO_OPERATION_TERMINAL");
    await assert.rejects(f.store.decideFrame(f.job.id, ownerId, saved.frames[0].assetId, {
      idempotency_key: randomUUID(), expected_revision: 0, expected_attempt: 0,
      action: "keep", note: "Continue with approved frames.", resume: true,
    }, async () => assert.fail("Do not review a frame for a terminal video"), async () => assert.fail("Do not requeue")),
    (error: unknown) => error instanceof MovieError && error.code === "VEO_OPERATION_TERMINAL");
    const after = await f.store.get(f.job.id);
    assert.equal(after.retries, undefined);
    assert.deepEqual(after.frames, saved.frames);
    assert.deepEqual(after.plan, saved.plan);
    assert.deepEqual(after.operations, [operation]);
    assert.equal(after.status, "FAILED");
    for (const frame of after.frames) assert.ok((await f.media.readAsset(frame.assetId)).byteLength);
  }
  for (const code of ["VEO_PENDING", "VEO_TIMEOUT", "VEO_WORKFLOW_FAILED", "VEO_CONTINUITY_REJECTED", "OPENAI_CREDITS_EXHAUSTED"]) {
    const pending = await f.store.update(f.job.id, job => {
      job.error = { code, stage: "GENERATING_HERO", message: "Recoverable existing operation." };
    });
    assert.equal(retrySummary(pending).eligible, true, `${code} must still allow recovering an existing operation or saved clip`);
  }
});

test("real worker resumes shots 3-6 with saved corrections and produces a full MP4 without replanning", async t => {
  const f = await fixture(t);
  const edits: { shotId: string; corrections: string[] }[] = [];
  const services: PipelineServices = { ...providers(f.config, f.png, edits), renderer: createRenderer(f.config) };
  const worker = new MovieWorker(f.config, {
    store: f.store, media: f.media, execute: (job, ctx, checkpoint, config) => executeMovie(job, ctx, checkpoint, config, services),
  });
  await worker.start();
  f.cleanup(() => worker.stop());
  const body = action();
  assert.equal((await f.handlers.retryJob(f.request(body), f.job.id)).status, 202);
  assert.equal(await worker.runOnce(), true);
  const done = await f.store.get(f.job.id);
  assert.equal(done.status, "COMPLETED", done.error?.message);
  assert.deepEqual(edits.map(edit => edit.shotId), ["shot_03", "shot_04", "shot_05", "shot_06"]);
  assert.deepEqual(edits[0].corrections, f.frames[2].continuity.reasons);
  assert.deepEqual(edits[1].corrections, []);
  assert.deepEqual(done.plan, f.plan);
  assert.deepEqual(done.character, f.character);
  const approved = mainStoryboardFrames(done.frames, f.plan.shots.map(shot => shot.id));
  assert.equal(approved.length, 6);
  assert.ok(approved.every(frame => frame.continuity.verdict === "PASS"));
  assert.deepEqual(approved.slice(0, 2), f.frames.slice(0, 2));
  assert.equal(done.result?.durationSeconds, 23);
  assert.equal(done.result?.mode, "storyboard-motion");
  const bytes = await f.media.readAsset(done.result!.assetId);
  assert.equal(Buffer.from(bytes).toString("ascii", 4, 8), "ftyp");
  assert.equal((await f.handlers.retryJob(f.request(body), f.job.id)).status, 202);
  assert.equal((await f.handlers.retryJob(f.request(action(1)), f.job.id)).status, 409);
  assert.equal(await worker.runOnce(), false);
  assert.equal(edits.length, 4);
});

test("another failed retry retains approvals and latest corrections, and never assembles an incomplete movie", async t => {
  const f = await fixture(t);
  const edits: { shotId: string; corrections: string[] }[] = [];
  let renderCalls = 0;
  const services: PipelineServices = {
    ...providers(f.config, f.png, edits, () => "RETRY"),
    renderer: {
      ready: async () => ({ available: true, message: "Test" }),
      render: async () => { renderCalls++; assert.fail("Partial movies must not render"); },
    },
  };
  const worker = new MovieWorker(f.config, { store: f.store, media: f.media, execute: (job, ctx, checkpoint, config) => executeMovie(job, ctx, checkpoint, config, services) });
  await worker.start();
  f.cleanup(() => worker.stop());
  const body = action();
  await f.retry(body);
  await worker.runOnce();
  const failed = await f.store.get(f.job.id);
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.error?.code, "CONTINUITY_REJECTED");
  assert.equal(failed.result, null);
  assert.equal(renderCalls, 0);
  assert.deepEqual(edits.map(edit => edit.shotId), ["shot_03", "shot_03"]);
  assert.deepEqual(edits[1].corrections.slice(0, 1), ["Fix the departure background."]);
  assert.equal(edits[1].corrections.length, 2);
  assert.ok(edits[1].corrections[1].length > 0);
  assert.equal(failed.frames.length, 5);
  assert.deepEqual(failed.frames.slice(0, 2), f.frames.slice(0, 2));
  assert.equal((await f.retry(body)).attempt, 1);
  assert.equal(await worker.runOnce(), false);
  await assert.rejects(f.retry(action()), (error: unknown) => error instanceof MovieError && error.code === "STALE_RETRY");
  await f.retry(action(1));
  await worker.runOnce();
  assert.equal(edits.length, 4);
  assert.deepEqual(edits[2].corrections, ["Fix the departure background."]);
  assert.equal((await f.store.get(f.job.id)).retries?.length, 2);
});

test("retry preflight rejects missing/corrupt approved files without charging to regenerate them", async t => {
  const f = await fixture(t);
  const filename = await f.media.assetPath(f.frames[0].assetId);
  await writeFile(filename, "corrupt");
  await assert.rejects(f.retry(), (error: unknown) => error instanceof MovieError && error.code === "SAVED_FRAME_UNAVAILABLE");
  let saved = await f.store.get(f.job.id);
  assert.equal(saved.status, "FAILED");
  assert.equal(saved.retries, undefined);
  await writeFile(filename, f.png);
  const outside = await f.media.saveAsset({ ownerId: "different", jobId: f.job.id, kind: "storyboard", mime: "image/png", bytes: f.png });
  await f.store.update(f.job.id, current => { current.frames[0].assetId = outside.id; });
  await assert.rejects(f.retry(), /does not belong/);
  saved = await f.store.get(f.job.id);
  assert.equal(saved.retries, undefined);
});

test("approvals gained during a retry are retained when a later shot fails", async t => {
  const f = await fixture(t);
  const edits: { shotId: string; corrections: string[] }[] = [];
  let rejectFifth = true;
  const services: PipelineServices = {
    ...providers(f.config, f.png, edits, () => rejectFifth && edits.at(-1)?.shotId === "shot_05" ? "RETRY" : "PASS"),
    renderer: {
      ready: async () => ({ available: true, message: "Test" }),
      render: async input => {
        assert.equal(input.frames.length, 6);
        const asset = await f.media.saveAsset({ ownerId, jobId: f.job.id, kind: "video", mime: "video/mp4", bytes: new Uint8Array([1]) });
        return { assetId: asset.id, durationSeconds: 23, mode: "storyboard-motion", hasAudio: false };
      },
    },
  };
  const worker = new MovieWorker(f.config, { store: f.store, media: f.media, execute: (job, ctx, checkpoint, config) => executeMovie(job, ctx, checkpoint, config, services) });
  await worker.start();
  f.cleanup(() => worker.stop());
  await f.retry();
  await worker.runOnce();
  const failed = await f.store.get(f.job.id);
  assert.equal(failed.status, "FAILED");
  assert.equal(retrySummary(failed).approvedShots, 4);
  const kept = mainStoryboardFrames(failed.frames, f.plan.shots.map(shot => shot.id)).slice(0, 4);
  rejectFifth = false;
  edits.length = 0;
  await f.retry(action(1));
  await worker.runOnce();
  const done = await f.store.get(f.job.id);
  assert.equal(done.status, "COMPLETED");
  assert.deepEqual(edits.map(edit => edit.shotId), ["shot_05", "shot_06"]);
  assert.deepEqual(edits[0].corrections, ["Fix the departure background."]);
  assert.deepEqual(mainStoryboardFrames(done.frames, f.plan.shots.map(shot => shot.id)).slice(0, 4), kept);
});

test("active, plan-less, tampered, and differently owned jobs cannot be requeued", async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.retryOwned(f.job.id, "other-owner", action(), async () => {}), /not found/);
  await f.store.update(f.job.id, current => { current.status = "STORYBOARDING"; });
  await assert.rejects(f.retry(), /Only a failed movie/);
  await f.store.update(f.job.id, current => { current.status = "FAILED"; current.plan = null; });
  await assert.rejects(f.retry(), /Only a failed movie/);
  await f.store.update(f.job.id, current => { current.plan = { ...f.plan, characterId: randomUUID() }; });
  await assert.rejects(f.retry(), /immutable references/);
  await f.store.update(f.job.id, current => { current.plan = f.plan; });
  const lease = await f.store.acquireWorker();
  f.cleanup(() => f.store.releaseWorker(lease));
  await f.store.update(f.job.id, current => { current.status = "RECEIVED"; });
  await f.store.claim(lease);
  await f.store.update(f.job.id, current => { current.status = "FAILED"; });
  await assert.rejects(f.retry(), /previous worker is still finishing/);
});

test("accepted retry receipt survives missing queue marker, restart and failure without extra paid attempts", async t => {
  const f = await fixture(t);
  const body = action();
  await f.retry(body);
  await rm(path.join(f.directory, "jobs", "pending", `${f.job.id}.json`));
  const restarted = new JobStore(f.directory);
  let lease = await restarted.acquireWorker();
  await restarted.recoverInterrupted(lease);
  const resumed = await restarted.claim(lease);
  assert.equal(resumed?.id, f.job.id);
  assert.deepEqual(resumed?.plan, f.plan);
  await restarted.releaseWorker(lease);
  lease = await restarted.acquireWorker();
  try {
    await restarted.recoverInterrupted(lease);
    assert.equal((await restarted.get(f.job.id)).status, "FAILED");
    assert.equal((await restarted.findRetry(f.job.id, ownerId, body))?.attempt, 1);
    assert.equal(await restarted.claim(lease), null);
    await restarted.deleteOwned(f.job.id, ownerId, f.media);
    await assert.rejects(restarted.retryOwned(f.job.id, ownerId, body, async () => {}), /not found/);
  } finally { await restarted.releaseWorker(lease); }
});

test("all-approved recovery skips every image request and does not repeat optional video after assembly failure", async t => {
  const f = await fixture(t, 6);
  await f.store.update(f.job.id, current => {
    current.request.enable_hero_video = true;
    current.heroAttempted = true;
    current.error = { code: "RENDER_FAILED", stage: "ASSEMBLING", message: "Encoding failed" };
  });
  const edits: { shotId: string; corrections: string[] }[] = [];
  let rendered = false;
  const renderer: RendererService = {
    ready: async () => ({ available: true, message: "Test" }),
    render: async input => {
      rendered = true;
      assert.equal(input.frames.length, 6);
      assert.deepEqual(input.frames, f.frames);
      assert.equal(input.hero, null);
      const video = await f.media.saveAsset({ ownerId, jobId: f.job.id, kind: "video", mime: "video/mp4", bytes: new Uint8Array([1]) });
      return { assetId: video.id, durationSeconds: 23, mode: "storyboard-motion", hasAudio: false };
    },
  };
  const worker = new MovieWorker(f.config, { store: f.store, media: f.media, execute: (job, ctx, checkpoint, config) =>
    executeMovie(job, ctx, checkpoint, config, { ...providers(config, f.png, edits), renderer }) });
  await worker.start();
  f.cleanup(() => worker.stop());
  await f.retry();
  await worker.runOnce();
  assert.equal(rendered, true);
  assert.deepEqual(edits, []);
  assert.equal((await f.store.get(f.job.id)).warnings.some(message => message.includes("not resubmitted")), true);
});

test("pipeline and public view withhold completion even when a faulty storyboard adapter returns partial approvals", async t => {
  const f = await fixture(t);
  const config = f.config;
  const updated = (await f.retry()).job;
  const context: GenerationContext = {
    jobId: f.job.id, ownerId, media: f.media, signal: new AbortController().signal,
    report: async () => {}, warn: async () => {}, recordOperation: async () => {}, saveFrame: async () => {},
  };
  await assert.rejects(executeMovie(updated, context, async () => {}, config, {
    ...providers(config, f.png, []),
    storyboard: { generate: async () => f.frames.slice(0, 2) },
    renderer: { ready: async () => ({ available: true, message: "Test" }), render: async () => assert.fail("Incomplete renderer called") },
  }), /one approved storyboard frame per planned shot/);
  const malformed: MovieJob = {
    ...updated, status: "FAILED", result: { assetId: randomUUID(), durationSeconds: 23, mode: "storyboard-motion", hasAudio: false },
  };
  assert.equal(jobView(malformed).result, null);
  assert.equal(jobView({ ...malformed, status: "COMPLETED" }).result, null);
  assert.equal(retrySummary(malformed).eligible, false);
});

test("retry HTTP rejects malformed commands and unavailable worker before queuing generation", async t => {
  const f = await fixture(t);
  assert.equal((await f.handlers.retryJob(f.request(action()), f.job.id)).status, 503);
  for (const body of [{}, { ...action(), plan: f.plan }, { ...action(), expected_attempt: -1 }]) {
    assert.equal((await f.handlers.retryJob(f.request(body), f.job.id)).status, 400);
  }
  const bad = new Request(f.request(action()).url, {
    method: "POST", headers: { host: "127.0.0.1:3200", authorization: `Bearer ${apiToken}`, "content-type": "application/json" }, body: "{",
  });
  assert.equal((await f.handlers.retryJob(bad, f.job.id)).status, 400);
  assert.equal((await f.store.get(f.job.id)).status, "FAILED");
  assert.equal((await f.store.get(f.job.id)).retries, undefined);
});

test("explicit movie-first conversion preserves input identity and deduplicates mode changes", async t => {
  const f = await fixture(t, 0);
  const original = await f.store.get(f.job.id);
  const request = { ...action(), production_mode: "movie-first" as const };
  const converted = await f.retry(request);
  assert.equal(converted.job.productionMode, "movie-first");
  assert.deepEqual(converted.job.plan, original.plan);
  assert.deepEqual(converted.job.request, original.request);
  assert.deepEqual(converted.job.frames, original.frames);
  assert.equal((await f.retry(request)).attempt, 1);
  await assert.rejects(f.retry({ idempotency_key: request.idempotency_key, expected_attempt: 0 }), /different attempt/);
  assert.equal((await f.store.get(f.job.id)).retries?.length, 1);
});

test("continuity recovery replaces only the rejected Veo segment twice, then permits explicit image motion", async t => {
  const f = await fixture(t, 6);
  const clip = async (index: number) => ({
    assetId: (await f.media.saveAsset({
      ownerId, jobId: f.job.id, kind: "video", mime: "video/mp4", bytes: new Uint8Array([index + 1]),
    })).id, shotId: f.plan.heroShotId,
    provider: "Google Veo" as const, model: "veo-3.1-generate-preview", operationId: `operation-${index}`,
  });
  const first = await clip(0);
  const second = await clip(1);
  await f.store.update(f.job.id, job => {
    job.request.enable_hero_video = true;
    job.request.video_provider = "google-veo";
    job.request.render_layout = "video-bookends";
    job.request.movie_duration_seconds = 28;
    job.plan!.videoProvider = "google-veo";
    job.hero = first;
    job.heroAttempted = true;
    job.operations = [0, 1, 2].map(index => ({ provider: "Google Veo", id: `operation-${index}` }));
    job.videoSegments = [
      { index: 0, submitted: true, operationId: "operation-0", clip: first },
      { index: 1, submitted: true, operationId: "operation-1", clip: second, startFrameAssetId: randomUUID() },
      { index: 2, submitted: true, operationId: "operation-2", startFrameAssetId: randomUUID() },
    ];
    job.error = { code: "VEO_CONTINUITY_REJECTED", message: "Retained rejection.", stage: "GENERATING_HERO" };
  });
  const verifyNothing = async () => {};
  const ordinary = action();
  await assert.rejects(
    f.store.retryOwned(f.job.id, ownerId, ordinary, verifyNothing),
    (error: unknown) => error instanceof MovieError && error.code === "VIDEO_RECOVERY_REQUIRED",
  );

  const replaceOne: RetryRequest = { ...action(), video_recovery_action: "replace-rejected-clip" };
  const accepted = await f.store.retryOwned(f.job.id, ownerId, replaceOne, verifyNothing);
  assert.equal((await f.store.retryOwned(f.job.id, ownerId, replaceOne, verifyNothing)).attempt, accepted.attempt);
  let saved = await f.store.get(f.job.id);
  assert.deepEqual(saved.videoSegments?.slice(0, 2), [
    { index: 0, submitted: true, operationId: "operation-0", clip: first },
    { index: 1, submitted: true, operationId: "operation-1", clip: second, startFrameAssetId: saved.videoSegments![1].startFrameAssetId },
  ]);
  assert.deepEqual(saved.videoSegments?.[2], {
    index: 2, submitted: false, startFrameAssetId: saved.videoSegments![2].startFrameAssetId,
  });
  assert.equal(saved.videoRecoveries?.[0].supersededOperationId, "operation-2");
  assert.equal(saved.operations.some(operation => operation.id === "operation-2"), true, "superseded operation stays in provenance");

  saved = await f.store.update(f.job.id, job => {
    job.status = "FAILED";
    job.error = { code: "VEO_CONTINUITY_REJECTED", message: "First replacement rejected.", stage: "GENERATING_HERO" };
    job.operations.push({ provider: "Google Veo", id: "replacement-1" });
    job.videoSegments![2] = { ...job.videoSegments![2], submitted: true, operationId: "replacement-1" };
  });
  assert.equal(retrySummary(saved).videoRecovery?.replacementAttempts, 1);
  const replaceTwo: RetryRequest = { ...action(1), video_recovery_action: "replace-rejected-clip" };
  await f.store.retryOwned(f.job.id, ownerId, replaceTwo, verifyNothing);

  saved = await f.store.update(f.job.id, job => {
    job.status = "FAILED";
    job.error = { code: "VEO_CONTINUITY_REJECTED", message: "Second replacement rejected.", stage: "GENERATING_HERO" };
    job.operations.push({ provider: "Google Veo", id: "replacement-2" });
    job.videoSegments![2] = { ...job.videoSegments![2], submitted: true, operationId: "replacement-2" };
  });
  assert.deepEqual(retrySummary(saved).videoRecovery, {
    replacementAttempts: 2, maxReplacementAttempts: 2, rejectedSegment: 2,
    veoSubmissionUncertain: false, replacementAvailable: false, imageMotionAvailable: true,
  });
  await assert.rejects(
    f.store.retryOwned(f.job.id, ownerId, { ...action(2), video_recovery_action: "replace-rejected-clip" }, verifyNothing),
    (error: unknown) => error instanceof MovieError && error.code === "VIDEO_REPLACEMENT_LIMIT",
  );
  const fallback = await f.store.retryOwned(f.job.id, ownerId, {
    ...action(2), video_recovery_action: "use-image-motion",
  }, verifyNothing);
  assert.equal(fallback.job.productionMode, "movie-first");
  assert.equal(fallback.job.videoRecoveries?.at(-1)?.action, "use-image-motion");
  assert.equal(fallback.job.request.video_provider, "google-veo", "accepted input remains immutable");
  assert.match(fallback.job.events.at(-1)!.message, /Operator-approved image-motion fallback/);

  let rendered = false;
  const context: GenerationContext = {
    jobId: f.job.id, ownerId, media: f.media, signal: new AbortController().signal,
    report: async () => {}, warn: async () => {}, recordOperation: async () => {},
    saveFrame: async () => {}, saveSceneFrame: async () => {},
  };
  const result = await executeMovie(fallback.job, context, async patch => { Object.assign(fallback.job, patch); }, f.config, {
    references: { extract: async () => assert.fail("Fallback must reuse the saved character") },
    director: { plan: async () => assert.fail("Fallback must reuse the saved plan") },
    storyboard: {
      generate: async input => {
        assert.equal(input.productionMode, "movie-first");
        assert.equal(input.plan.videoProvider, undefined);
        assert.deepEqual(input.existingFrames, f.frames);
        return f.frames;
      },
    },
    video: { generate: async () => assert.fail("Fallback must not submit another video") },
    renderer: {
      ready: async () => ({ available: true, message: "Offline renderer" }),
      render: async input => {
        rendered = true;
        assert.equal(input.productionMode, "movie-first");
        assert.equal(input.plan.videoProvider, undefined);
        assert.equal(input.hero, null);
        assert.equal(input.renderLayout, undefined);
        const output = await f.media.saveAsset({
          ownerId, jobId: f.job.id, kind: "video", mime: "video/mp4", bytes: new Uint8Array([9]),
        });
        return { assetId: output.id, mode: "image-motion", durationSeconds: 23, hasAudio: false };
      },
    },
    extract: async () => f.frames,
  });
  assert.equal(rendered, true);
  assert.equal(result.mode, "image-motion");
  const publicView = jobView({ ...fallback.job, status: "COMPLETED", result });
  assert.equal(publicView.result?.mode, "image-motion");
  assert.equal(publicView.renderLayout, "storyboard");
});

test("uncertain Veo submission requires explicit bounded replacement authorization", async t => {
  const f = await fixture(t, 6);
  const failed = await f.store.update(f.job.id, job => {
    job.request.enable_hero_video = true;
    job.request.video_provider = "google-veo";
    job.request.render_layout = "video-bookends";
    job.request.movie_duration_seconds = 13;
    job.plan!.videoProvider = "google-veo";
    job.heroAttempted = true;
    job.hero = null;
    job.operations = job.operations.filter(operation => operation.provider !== "Google Veo");
    job.videoSegments = undefined;
    job.error = {
      code: "VEO_WORKFLOW_FAILED", stage: "GENERATING_HERO",
      message: "The Google Veo workflow could not finish submission.",
    };
  });
  assert.deepEqual(retrySummary(failed).videoRecovery, {
    replacementAttempts: 0, maxReplacementAttempts: 2,
    veoSubmissionUncertain: true, replacementAvailable: true, imageMotionAvailable: false,
  });
  assert.equal(retrySummary(failed).eligible, true);
  await assert.rejects(
    f.store.retryOwned(f.job.id, ownerId, action(), async () => {}),
    (error: unknown) => error instanceof MovieError && error.code === "VIDEO_SUBMISSION_UNCERTAIN",
  );
  const first = await f.store.retryOwned(f.job.id, ownerId, {
    ...action(), video_recovery_action: "replace-rejected-clip",
  }, async () => {});
  assert.equal(first.job.heroAttempted, false);
  assert.equal(first.job.videoRecoveries?.length, 1);

  const failedAgain = await f.store.update(f.job.id, job => {
    job.status = "FAILED";
    job.heroAttempted = true;
    job.error = {
      code: "VEO_WORKFLOW_FAILED", stage: "GENERATING_HERO",
      message: "The replacement returned no operation ID.",
    };
  });
  assert.equal(retrySummary(failedAgain).videoRecovery?.replacementAvailable, true);
  const second = await f.store.retryOwned(f.job.id, ownerId, {
    ...action(1), video_recovery_action: "replace-rejected-clip",
  }, async () => {});
  assert.equal(second.job.videoRecoveries?.length, 2);

  const failedTwice = await f.store.update(f.job.id, job => {
    job.status = "FAILED";
    job.heroAttempted = true;
    job.error = {
      code: "VEO_WORKFLOW_FAILED", stage: "GENERATING_HERO",
      message: "The second replacement returned no operation ID.",
    };
  });
  assert.equal(retrySummary(failedTwice).videoRecovery?.replacementAvailable, false);
  await assert.rejects(
    f.store.retryOwned(f.job.id, ownerId, { ...action(2), video_recovery_action: "replace-rejected-clip" }, async () => {}),
    (error: unknown) => error instanceof MovieError && error.code === "VIDEO_REPLACEMENT_LIMIT",
  );
});
