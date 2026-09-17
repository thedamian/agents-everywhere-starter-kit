import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getMovieFormat, getTimeline, MovieError, type AssetRecord, type MovieDuration, type MovieJob, type MoviePlan, type VideoArtifact } from "../src/domain";
import type { GenerationContext, MovieCheckpoint, MovieConfig } from "../src/domain/services";
import { savedVideoSegments } from "../src/domain/video-sequence-state";
import { retrySummary } from "../src/jobs/retry";
import { generateVideoSequence, type VideoSequenceDependencies } from "../src/video/sequence";

function fixture(duration: MovieDuration = 28) {
  const id = randomUUID();
  const characterId = randomUUID();
  const timeline = getTimeline();
  const plan: MoviePlan = {
    id: randomUUID(), characterId, productId: "test-car", templateId: "DREAM_ROUTE", templateVersion: 1,
    referenceVersion: 1, durationSeconds: 18, aspectRatio: "16:9", heroShotId: "shot_03", heroMode: "POV",
    videoProvider: "google-veo", wardrobe: "Not visible", logline: "Synthetic driving", cinematicStyle: "Simple",
    worldTransitions: "Continuous", personalizationUsed: [],
    shots: timeline.shotIds.map((shot, index) => ({
      id: shot, durationSeconds: timeline.durations[index], purpose: "Drive", camera: "Tracking", action: "Driving",
      environment: "Road", lighting: "Day", personalization: [], imagePrompt: "Synthetic image", motionPrompt: "Continue", audioCues: [],
    })),
  };
  const job: MovieJob = {
    id, ownerId: "offline-owner", status: "FAILED", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    request: {
      schema_version: 1, session_id: "offline-session", customer_reference_asset_ids: [], primary_reference_asset_id: null,
      consent: { likeness: true, personalization: true }, product_id: "test-car", personalization_profile: { signals: [] },
      preferred_template: "DREAM_ROUTE", hero_mode: "POV", enable_hero_video: true, video_provider: "google-veo",
      render_layout: "video-bookends", movie_duration_seconds: duration, idempotency_key: randomUUID(),
    },
    product: {
      id: "test-car", version: 1, name: "Synthetic car", make: null, model: null, exteriorColor: "blue", interiorColor: null,
      appearance: "Synthetic geometry", approvedClaims: [], usagePermission: "Offline test", referenceImages: [],
    },
    character: {
      id: characterId, version: 1, primaryAssetId: null, sourceImages: [], consent: { likeness: true, personalization: true },
      attributes: { face: null, eyes: null, eyebrows: null, nose: null, mouth: null, hair: null, complexion: null, wardrobe: null, visibleProportions: null, accessories: [] },
    },
    plan, frames: timeline.shotIds.map(shotId => ({
      shotId, assetId: randomUUID(), continuity: { verdict: "PASS", confidence: 1, reasons: [] }, provider: "offline", model: "offline",
    })),
    events: [], warnings: [], error: null, hero: null, result: null, operations: [],
  };
  job.heroEndpoints = {
    startAssetId: job.frames[0].assetId,
    endAssetId: job.frames.at(-1)!.assetId,
  };
  const assets = new Map<string, { record: AssetRecord; bytes: Uint8Array }>();
  const submissions: number[] = [];
  const resumed: number[] = [];
  const continuationSources: string[] = [];
  let failAfterOperation: number | undefined;
  let failBeforeOperation: number | undefined;
  let failCheckpoint = false;
  let repeatClip = false;
  const checkpoint: MovieCheckpoint = async patch => {
    if (failCheckpoint && patch.videoSegments?.[1]?.operationId) {
      failCheckpoint = false;
      throw new MovieError("STORE_BUSY", "Simulated checkpoint failure after recording the operation.");
    }
    Object.assign(job, structuredClone(patch));
  };
  const context: GenerationContext = {
    jobId: id, ownerId: job.ownerId, signal: new AbortController().signal,
    report: async () => {}, warn: async message => { job.warnings.push(message); }, saveFrame: async () => assert.fail("Do not regenerate the approved storyboard"),
    recordOperation: async (provider, operationId) => {
      if (!job.operations.some(value => value.id === operationId)) job.operations.push({ provider, id: operationId });
    },
    media: {
      getAsset: async assetId => {
        const asset = assets.get(assetId);
        if (!asset) throw new MovieError("ASSET_NOT_FOUND", "Missing saved clip.", 404);
        return asset.record;
      },
      readAsset: async assetId => {
        const asset = assets.get(assetId);
        if (!asset) throw new MovieError("ASSET_NOT_FOUND", "Missing saved clip.", 404);
        return asset.bytes;
      },
      assetPath: async assetId => `C:\\offline-fixture\\${assetId}.mp4`,
      saveAsset: async input => {
        const assetId = randomUUID();
        const record: AssetRecord = {
          id: assetId, ownerId: input.ownerId, jobId: input.jobId, kind: input.kind, mime: input.mime,
          filename: `${assetId}.media`, bytes: input.bytes.length, width: input.width ?? null, height: input.height ?? null,
          createdAt: new Date().toISOString(),
        };
        assets.set(assetId, { record, bytes: input.bytes });
        return record;
      },
    },
  };
  const dependencies: VideoSequenceDependencies = {
    probe: async () => ({
      videoStreamCount: 1, audioStreamCount: 0, durationSeconds: 8, formatName: "mov,mp4", audio: null,
      video: { codec: "h264", width: 1280, height: 720, durationSeconds: 8, frameCount: 192, frameRate: 24, pixelFormat: "yuv420p", sampleAspectRatio: "1:1" },
    }),
    continuation: async (_config, clip, ctx) => {
      continuationSources.push(clip.assetId);
      return (await ctx.media.saveAsset({ ownerId: ctx.ownerId, jobId: ctx.jobId, kind: "storyboard", mime: "image/png", bytes: new Uint8Array([1]) })).id;
    },
    video: { generate: async (input, ctx) => {
      const index = input.continuation?.index ?? Number(input.operationId?.split("clip-").at(-1) ?? 0);
      if (input.operationId) resumed.push(index);
      else {
        assert.ok(ctx.beforeVideoSubmission);
        await ctx.beforeVideoSubmission();
        submissions.push(index);
        if (failBeforeOperation === index) throw new MovieError("VEO_TIMEOUT", "Unknown acceptance.");
        await ctx.recordOperation("Google Veo", `models/veo-3.1-generate-preview/operations/clip-${index}`);
      }
      if (failAfterOperation === index) {
        failAfterOperation = undefined;
        throw new MovieError("VEO_PENDING", "Existing operation not yet complete.");
      }
      if (repeatClip && index > 0) return job.hero!;
      const asset = await ctx.media.saveAsset({
        ownerId: ctx.ownerId, jobId: ctx.jobId, kind: "video", mime: "video/mp4", bytes: new Uint8Array([index, 2, 3]),
      });
      const clip: VideoArtifact = { assetId: asset.id, shotId: "shot_03", provider: "Google Veo", model: "veo-3.1-generate-preview" };
      return clip;
    } },
  };
  const config: MovieConfig = { dataDir: "unused", imageModel: "offline", veoModel: "veo-3.1-generate-preview" };
  return {
    job, assets, submissions, resumed, continuationSources, dependencies,
    failAfter: (index: number) => { failAfterOperation = index; },
    failBefore: (index: number) => { failBeforeOperation = index; },
    failOperationCheckpoint: () => { failCheckpoint = true; },
    repeat: () => { repeatClip = true; },
    run: () => generateVideoSequence(job, plan, job.character!, job.frames, context, checkpoint, config, dependencies),
  };
}

test("selected durations generate exactly the required distinct clips and preserve the reference plan", async () => {
  for (const duration of [13, 15, 18, 23, 28] as const) {
    const f = fixture(duration);
    const original = JSON.stringify({ plan: f.job.plan, frames: f.job.frames });
    const result = await f.run();
    assert.equal(result.length, getMovieFormat(duration).clipCount);
    assert.equal(new Set(result.map(clip => clip.assetId)).size, result.length);
    assert.equal(f.submissions.length, result.length);
    assert.deepEqual(f.continuationSources, result.slice(0, -1).map(clip => clip.assetId));
    assert.equal(JSON.stringify({ plan: f.job.plan, frames: f.job.frames }), original);
    assert.deepEqual(await f.run(), result);
    assert.equal(f.submissions.length, result.length, "An approved sequence never regenerates its clips");
  }
});

test("retry resumes an interrupted middle operation and keeps completed clips", async () => {
  const f = fixture();
  f.failAfter(1);
  await assert.rejects(f.run(), (error: unknown) => error instanceof MovieError && error.code === "VEO_PENDING");
  const first = f.job.hero!.assetId;
  assert.equal(retrySummary(f.job).eligible, true);
  const result = await f.run();
  assert.equal(result[0].assetId, first);
  assert.deepEqual(f.submissions, [0, 1, 2]);
  assert.deepEqual(f.resumed, [1]);
});

test("a lost segment checkpoint recovers the durably recorded operation without another submission", async () => {
  const f = fixture(23);
  f.failOperationCheckpoint();
  await assert.rejects(f.run(), (error: unknown) => error instanceof MovieError && error.code === "STORE_BUSY");
  assert.equal(f.job.videoSegments?.[1].operationId, undefined);
  assert.ok(savedVideoSegments(f.job)[1].operationId);
  assert.equal(retrySummary(f.job).eligible, true);
  assert.equal((await f.run()).length, 2);
  assert.deepEqual(f.submissions, [0, 1]);
  assert.deepEqual(f.resumed, [1]);
});

test("uncertain middle submissions fail closed instead of charging again", async () => {
  const f = fixture();
  f.failBefore(1);
  await assert.rejects(f.run(), (error: unknown) => error instanceof MovieError && error.code === "VEO_TIMEOUT");
  assert.equal(retrySummary(f.job).eligible, false);
  await assert.rejects(f.run(), (error: unknown) => error instanceof MovieError && error.code === "VIDEO_SUBMISSION_UNCERTAIN");
  assert.deepEqual(f.submissions, [0, 1]);
});

test("missing saved clips and repeated footage cannot complete a longer movie", async () => {
  const missing = fixture(23);
  const clips = await missing.run();
  missing.assets.delete(clips[0].assetId);
  await assert.rejects(missing.run(), (error: unknown) => error instanceof MovieError && error.code === "ASSET_NOT_FOUND");
  assert.deepEqual(missing.submissions, [0, 1]);
  const repeated = fixture(23);
  repeated.repeat();
  await assert.rejects(repeated.run(), (error: unknown) => error instanceof MovieError && error.code === "INVALID_VIDEO_SEGMENT");
});
