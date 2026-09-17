import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { executeMovie, type PipelineServices } from "../src/pipeline";
import { retrySummary } from "../src/jobs/retry";
import {
  type CharacterReference, type MovieJob, type MoviePlan, type StoryboardFrame,
  type JobStatus, type RenderResult, MovieError,
} from "../src/domain";
import type { GenerationContext } from "../src/domain/services";

function fixture(enableHero = false) {
  const photoId = randomUUID();
  const jobId = randomUUID();
  const character: CharacterReference = {
    id: randomUUID(), version: 1, sourceImages: [{ assetId: photoId, role: "front", origin: "original" }],
    primaryAssetId: photoId, consent: { likeness: true, personalization: true },
    attributes: { face: null, eyes: null, eyebrows: null, nose: null, mouth: null, hair: null, complexion: null, visibleProportions: null, wardrobe: "Source outfit", accessories: [] },
  };
  const plan: MoviePlan = {
    id: randomUUID(), characterId: character.id, productId: "demo", templateId: "DREAM_ROUTE",
    templateVersion: 1, referenceVersion: 1, durationSeconds: 18, aspectRatio: "16:9", heroShotId: "shot_03",
    logline: "A scenic drive", wardrobe: "Source outfit", cinematicStyle: "Warm", worldTransitions: "None", personalizationUsed: [],
    shots: (["shot_01", "shot_02", "shot_03", "shot_04"] as const).map((id, index) => ({
      id, durationSeconds: [3, 3, 8, 4][index], purpose: "Journey", camera: "Tracking",
      action: "Driving", environment: "Coast", lighting: "Day", personalization: [],
      imagePrompt: "References", motionPrompt: "Slow", audioCues: [],
    })),
  };
  const frames: StoryboardFrame[] = plan.shots.map(shot => ({
    shotId: shot.id, assetId: randomUUID(), continuity: { verdict: "PASS", reasons: [], confidence: 0.9 },
    provider: "Explicit test double", model: "test",
  }));
  const job: MovieJob = {
    id: jobId, ownerId: "test", request: {
      schema_version: 1, session_id: "robot-session", customer_reference_asset_ids: [photoId], primary_reference_asset_id: photoId,
      consent: { likeness: true, personalization: true }, product_id: "demo", personalization_profile: { signals: [] },
      preferred_template: "DREAM_ROUTE", enable_hero_video: enableHero, idempotency_key: randomUUID(),
    },
    product: {
      id: "demo", version: 1, name: "Synthetic test car", make: null, model: null, exteriorColor: "red",
      interiorColor: null, appearance: "Test shape", approvedClaims: [], usagePermission: "Generated test data",
      referenceImages: [0, 1].map(() => ({ assetId: randomUUID(), role: "exterior", origin: "original" })),
    },
    status: "RECEIVED", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    events: [], warnings: [], error: null, character: null, plan: null, frames: [], hero: null, result: null, operations: [],
  };
  const stages: JobStatus[] = [];
  const warnings: string[] = [];
  const checkpoints: object[] = [];
  const context: GenerationContext = {
    jobId, ownerId: "test", signal: new AbortController().signal,
    media: {
      getAsset: async () => { throw new Error("Unexpected media read in orchestration test"); },
      readAsset: async () => { throw new Error("Unexpected media read in orchestration test"); },
      assetPath: async () => { throw new Error("Unexpected media read in orchestration test"); },
      saveAsset: async () => { throw new Error("Unexpected media write in orchestration test"); },
    },
    report: async update => { stages.push(update.stage); },
    warn: async warning => { warnings.push(warning); },
    recordOperation: async () => {},
    saveFrame: async () => {},
  };
  let videoCalls = 0;
  const result: RenderResult = { assetId: randomUUID(), mode: "storyboard-motion", durationSeconds: 18, hasAudio: false };
  const services: PipelineServices = {
    references: { extract: async input => { assert.equal(input.primaryAssetId, photoId); return character; } },
    director: { plan: async input => { assert.equal(input.character.id, character.id); return plan; } },
    storyboard: { generate: async input => { assert.equal(input.plan.id, plan.id); return frames; } },
    video: { generate: async (_input, ctx) => { videoCalls++; await ctx.warn("Optional video unavailable; using approved still."); return null; } },
    renderer: {
      ready: async () => ({ available: true, message: "Test renderer" }),
      render: async input => { assert.equal(input.frames.length, 4); assert.equal(input.hero, null); return result; },
    },
  };
  return {
    services, stages, warnings, checkpoints, result, job, plan, frames, get videoCalls() { return videoCalls; },
    selectHeroEndpoints: () => {
      job.heroEndpoints = { startAssetId: frames[0].assetId, endAssetId: frames.at(-1)!.assetId };
    },
    run: () => executeMovie(job, context, async patch => { checkpoints.push(patch); },
      { dataDir: "unused", imageModel: "test", veoModel: "test" }, services),
  };
}

test("orchestrator persists references and plan and renders baseline without calling video", async () => {
  const sample = fixture();
  assert.deepEqual(await sample.run(), sample.result);
  assert.equal(sample.videoCalls, 0);
  assert.equal(sample.checkpoints.length, 2);
  assert.deepEqual(sample.stages, ["BUILDING_REFERENCES", "DIRECTING", "ASSEMBLING"]);
});
test("optional video failure still renders a truthful baseline", async () => {
  const sample = fixture(true);
  assert.equal((await sample.run()).mode, "storyboard-motion");
  assert.equal(sample.videoCalls, 1);
  assert.equal(sample.warnings.length, 1);
  assert.deepEqual(sample.checkpoints.at(-1), { hero: null });
});
test("required Veo pauses after storyboard approval until distinct hero endpoints are selected", async () => {
  const sample = fixture(true);
  sample.job.request.video_provider = "google-veo";
  sample.job.request.render_layout = "video-bookends";
  sample.job.request.movie_duration_seconds = 15;
  sample.plan.videoProvider = "google-veo";
  await assert.rejects(sample.run(), (error: unknown) =>
    error instanceof MovieError && error.code === "HERO_ENDPOINT_SELECTION_REQUIRED");
  assert.equal(sample.videoCalls, 0, "endpoint selection pauses before the paid video provider");
});
test("renderer preflight fails before a paid reference service runs", async () => {
  const sample = fixture();
  sample.services.renderer.ready = async () => ({ available: false, message: "FFmpeg missing" });
  sample.services.references.extract = async () => { assert.fail("Must not make a paid call"); };
  await assert.rejects(sample.run(), (error: unknown) => error instanceof MovieError && error.code === "RENDERER_UNAVAILABLE");
});

test("OpenAI hybrid requires a genuine Sora clip and cannot fall back to still-image motion", async () => {
  const sample = fixture(true);
  sample.job.request.video_provider = "openai-sora";
  sample.plan.videoProvider = "openai-sora";
  let rendered = false;
  sample.services.renderer.render = async () => { rendered = true; return sample.result; };
  await assert.rejects(sample.run(), (error: unknown) => error instanceof MovieError && error.code === "ANIMATION_REQUIRED");
  assert.equal(rendered, false);
});

test("approved stills and the Sora animation are both required in the final hybrid output", async () => {
  const sample = fixture(true);
  sample.job.request.video_provider = "openai-sora";
  sample.plan.videoProvider = "openai-sora";
  const clip = { assetId: randomUUID(), shotId: "shot_03" as const, provider: "OpenAI Sora" as const, model: "sora-2", operationId: "video_test" };
  sample.services.video.generate = async input => {
    assert.ok(input.frames.every(frame => frame.continuity.verdict === "PASS"));
    assert.equal(input.plan.videoProvider, "openai-sora");
    return clip;
  };
  sample.services.renderer.render = async input => {
    assert.equal(input.frames.length, 4);
    assert.deepEqual(input.hero, clip);
    return { ...sample.result, mode: "hybrid-video" };
  };
  assert.equal((await sample.run()).mode, "hybrid-video");
  assert.deepEqual(sample.checkpoints.at(-1), { hero: clip });
});

test("an existing Sora operation is resumed, while uncertain untracked submissions fail closed", async () => {
  const sample = fixture(true);
  sample.job.request.video_provider = "openai-sora";
  sample.plan.videoProvider = "openai-sora";
  sample.job.heroAttempted = true;
  sample.services.video.generate = async () => assert.fail("Untracked submissions must not be repeated");
  await assert.rejects(sample.run(), (error: unknown) => error instanceof MovieError && error.code === "SORA_SUBMISSION_UNCERTAIN");
  sample.job.operations.push({ provider: "OpenAI Sora", id: "video_existing" });
  sample.services.video.generate = async input => {
    assert.equal(input.operationId, "video_existing");
    throw new MovieError("SORA_PENDING", "Existing operation still running");
  };
  await assert.rejects(sample.run(), (error: unknown) => error instanceof MovieError && error.code === "SORA_PENDING");
});

test("explicit Veo selection fails rather than completing a slideshow when animation is unavailable", async () => {
  const sample = fixture(true);
  sample.job.request.video_provider = "google-veo";
  sample.plan.videoProvider = "google-veo";
  sample.selectHeroEndpoints();
  sample.services.renderer.render = async () => assert.fail("Required animation must not fall back to stills");
  await assert.rejects(sample.run(), (error: unknown) => error instanceof MovieError && error.code === "ANIMATION_REQUIRED");
});

test("explicit Veo selection combines an actual provider clip with approved stills", async () => {
  const sample = fixture(true);
  sample.job.request.video_provider = "google-veo";
  sample.plan.videoProvider = "google-veo";
  sample.selectHeroEndpoints();
  const clip = { assetId: randomUUID(), shotId: "shot_03" as const, provider: "Google Veo" as const, model: "veo-3.1-generate-preview" };
  sample.services.video.generate = async () => clip;
  sample.services.renderer.render = async input => {
    assert.deepEqual(input.hero, clip);
    assert.equal(input.frames.length, 4);
    return { ...sample.result, mode: "hybrid-video" };
  };
  assert.equal((await sample.run()).mode, "hybrid-video");
});

test("required Veo recovery resumes its existing operation and propagates validation failures", async () => {
  const sample = fixture(true);
  sample.job.request.video_provider = "google-veo";
  sample.plan.videoProvider = "google-veo";
  sample.job.heroAttempted = true;
  const operationId = "models/veo-3.1-generate-preview/operations/existing";
  sample.job.operations.push({ provider: "Google Veo", id: operationId });
  sample.services.video.generate = async input => {
    assert.equal(input.operationId, operationId);
    throw new MovieError("OPENAI_RATE_LIMITED", "Review was rate limited.");
  };
  sample.services.renderer.render = async () => assert.fail("Review must succeed before rendering");
  await assert.rejects(sample.run(), (error: unknown) => error instanceof MovieError && error.code === "OPENAI_RATE_LIMITED");
  assert.equal(sample.stages.at(-1), "GENERATING_HERO");
});

test("both video providers pass the explicit bookend layout to final assembly", async () => {
  for (const provider of ["google-veo", "openai-sora"] as const) {
    const sample = fixture(true);
    sample.job.request.video_provider = provider;
    sample.job.request.render_layout = "video-bookends";
    sample.plan.videoProvider = provider;
    if (provider === "google-veo") sample.selectHeroEndpoints();
    sample.services.video.generate = async () => ({
      assetId: randomUUID(), shotId: "shot_03", provider: provider === "google-veo" ? "Google Veo" : "OpenAI Sora",
      model: "offline-test",
    });

    sample.services.renderer.render = async input => {
      assert.equal(input.renderLayout, "video-bookends");
      assert.equal(input.frames.length, 4, "Keep every approved reference even though only bookends become still segments");
      return { ...sample.result, mode: "hybrid-video", durationSeconds: 15, renderLayout: input.renderLayout };
    };
    const result = await sample.run();
    assert.equal(result.durationSeconds, 15);
    assert.equal(result.renderLayout, "video-bookends");
  }
});

test("bookend requests cannot silently receive the older storyboard-layout movie", async () => {
  const sample = fixture(true);
  sample.job.request.video_provider = "google-veo";
  sample.job.request.render_layout = "video-bookends";
  sample.plan.videoProvider = "google-veo";
  sample.selectHeroEndpoints();
  sample.services.video.generate = async () => ({ assetId: randomUUID(), shotId: "shot_03", provider: "Google Veo", model: "offline-test" });
  sample.services.renderer.render = async () => ({ ...sample.result, mode: "hybrid-video" });
  await assert.rejects(sample.run(), (error: unknown) => error instanceof MovieError && error.code === "RENDER_INVALID_OUTPUT");
});

test("endpoint preparation failure does not mark Veo as submitted, but the provider's submission hook does", async () => {
  const sample = fixture(true);
  sample.job.request.video_provider = "google-veo";
  sample.plan.videoProvider = "google-veo";
  sample.selectHeroEndpoints();
  sample.services.video.generate = async (_input, context) => {
    assert.ok(context.beforeVideoSubmission);
    throw new MovieError("CONTINUITY_REJECTED", "Missing end frame.");
  };
  await assert.rejects(sample.run(), (error: unknown) => error instanceof MovieError && error.code === "CONTINUITY_REJECTED");
  assert.equal(sample.checkpoints.some(patch => "heroAttempted" in patch), false);
  sample.services.video.generate = async (_input, context) => {
    assert.ok(context.beforeVideoSubmission);
    await context.beforeVideoSubmission();
    throw new MovieError("VEO_TIMEOUT", "The submission outcome is uncertain.");
  };
  await assert.rejects(sample.run(), (error: unknown) => error instanceof MovieError && error.code === "VEO_TIMEOUT");
  assert.deepEqual(sample.checkpoints.at(-1), { heroAttempted: true });
});

test("an uncertain untracked Veo submission cannot be retried until an operation is recovered", async () => {
  const sample = fixture(true);
  await sample.run();
  Object.assign(sample.job, ...sample.checkpoints);
  sample.job.status = "FAILED";
  sample.job.request.video_provider = "google-veo";
  sample.plan.videoProvider = "google-veo";
  sample.job.heroAttempted = true;
  sample.services.video.generate = async () => assert.fail("Do not repeat an uncertain paid request");
  assert.equal(retrySummary(sample.job).eligible, false);
  await assert.rejects(sample.run(), (error: unknown) => error instanceof MovieError && error.code === "VEO_SUBMISSION_UNCERTAIN");
  sample.job.operations.push({ provider: "Google Veo", id: "models/veo-3.1-generate-preview/operations/recovered" });
  assert.equal(retrySummary(sample.job).eligible, true);
});

test("longer movie lengths route through a complete animation sequence, not stretched stills", async () => {
  for (const duration of [18, 23, 28] as const) {
    const sample = fixture(true);
    sample.job.request.video_provider = "google-veo";
    sample.job.request.render_layout = "video-bookends";
    sample.job.request.movie_duration_seconds = duration;
    sample.plan.videoProvider = "google-veo";
    sample.selectHeroEndpoints();
    const clips = Array.from({ length: duration === 28 ? 3 : 2 }, () => ({
      assetId: randomUUID(), shotId: "shot_03" as const, provider: "Google Veo" as const, model: "offline-test",
    }));
    sample.services.sequence = async job => {
      assert.equal(job.request.movie_duration_seconds, duration);
      return clips;
    };
    sample.services.video.generate = async () => assert.fail("Use the sequence path for longer movies");
    sample.services.renderer.render = async input => {
      assert.deepEqual(input.videoClips, clips);
      assert.deepEqual(input.hero, clips[0]);
      assert.equal(input.movieDurationSeconds, duration);
      return { ...sample.result, mode: "hybrid-video", durationSeconds: duration, renderLayout: "video-bookends" };
    };
    assert.equal((await sample.run()).durationSeconds, duration);
  }
});

test("the 13-second preset retains a full single eight-second clip", async () => {
  const sample = fixture(true);
  sample.job.request.video_provider = "google-veo";
  sample.job.request.render_layout = "video-bookends";
  sample.job.request.movie_duration_seconds = 13;
  sample.plan.videoProvider = "google-veo";
  sample.selectHeroEndpoints();
  sample.services.video.generate = async () => ({ assetId: randomUUID(), shotId: "shot_03", provider: "Google Veo", model: "offline-test" });
  sample.services.renderer.render = async input => {
    assert.equal(input.movieDurationSeconds, 13);
    assert.ok(input.hero);
    return { ...sample.result, mode: "hybrid-video", durationSeconds: 13, renderLayout: "video-bookends" };
  };
  assert.equal((await sample.run()).durationSeconds, 13);
});
