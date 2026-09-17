import { randomUUID } from "node:crypto";
import { MovieError, getTimeline, getMovieFormat, productionModeOf, type CharacterReference, type MovieJob, type MovieDuration, type RenderLayout, type RenderResult } from "./domain";
import type {
  DirectorService, GenerationContext, MovieConfig, ReferenceService,
  RendererService, StoryboardService, VideoService, MovieCheckpoint,
} from "./domain/services";
import { getTemplate } from "./templates";
import { createOpenAIServices } from "./providers/openai";
import { createVeoService } from "./providers/google";
import { createRenderer, validateRenderInput } from "./render";
import { validateHeroEndpoints, validateRetryAssets } from "./jobs/retry";
import { extractStoryboard } from "./render/extract-storyboard";
import { createOpenAIVideoService } from "./providers/openai/video";
import { generateVideoSequence } from "./video/sequence";
import { activeVideoOperations, activeVideoProvider } from "./domain/video-sequence-state";

export interface PipelineServices {
  references: ReferenceService;
  director: DirectorService;
  storyboard: StoryboardService;
  video: VideoService;
  renderer: RendererService;
  extract?: typeof extractStoryboard;
  sequence?: typeof generateVideoSequence;
}

function requireRenderLayout(result: RenderResult, layout?: RenderLayout, duration: MovieDuration = 15): void {
  if (layout === "video-bookends" && (result.renderLayout !== layout || result.mode !== "hybrid-video" || result.durationSeconds !== duration)) {
    throw new MovieError("RENDER_INVALID_OUTPUT", "The requested video-bookend cut was not produced. An older storyboard-layout movie was not substituted.", 502);
  }
}

export async function executeMovie(
  job: MovieJob,
  context: GenerationContext,
  checkpoint: MovieCheckpoint,
  config: MovieConfig,
  services?: PipelineServices,
): Promise<RenderResult> {
  const renderer = services?.renderer ?? createRenderer(config);
  const readiness = await renderer.ready();
  if (!readiness.available) throw new MovieError("RENDERER_UNAVAILABLE", readiness.message, 503);
  const { references, director, storyboard } = services ?? createOpenAIServices(config);
  const heroMode = job.request.hero_mode ?? "LIKENESS";
  const storyFormat = job.request.story_format ?? "four-shot";
  const timeline = getTimeline(storyFormat, job.request.preferred_template);
  const resuming = !!job.retries?.length;
  const movieFirst = productionModeOf(job) === "movie-first";
  if (resuming) await validateRetryAssets(job, context.media, context.signal);
  let character: CharacterReference;
  if (job.character) {
    character = job.character;
  } else if (heroMode === "LIKENESS") {
    if (!job.request.primary_reference_asset_id) throw new MovieError("INVALID_REFERENCE", "Likeness mode requires a primary customer photo.", 400);
    await context.report({ stage: "BUILDING_REFERENCES", message: "Reading the approved customer photos.", provider: "OpenAI" });
    character = await references.extract({
      assetIds: job.request.customer_reference_asset_ids,
      primaryAssetId: job.request.primary_reference_asset_id,
      consent: job.request.consent,
    }, context);
  } else {
    await context.report({ stage: "BUILDING_REFERENCES", message: `${heroMode === "POV" ? "First-person" : "Generic-driver"} mode: no customer photos are sent to generation providers.` });
    character = {
      id: randomUUID(), version: 1, primaryAssetId: null, sourceImages: [], consent: job.request.consent,
      attributes: {
        face: null, eyes: null, eyebrows: null, nose: null, mouth: null, hair: null, complexion: null,
        visibleProportions: null, wardrobe: null, accessories: [],
      },
    };
  }
  if (!job.character) await checkpoint({ character });
  let plan = job.plan;
  if (plan) {
    await context.report({ stage: "STORYBOARDING", message: "Reusing the saved director plan and customer reference; no re-analysis or replanning." });
  } else {
    if (resuming) throw new MovieError("RETRY_UNAVAILABLE", "The saved plan is missing. Retry cannot create a replacement plan.", 409);
    await context.report({ stage: "DIRECTING", message: `Planning ${timeline.shotIds.length} shots from your selected template.`, provider: "OpenAI" });
    plan = await director.plan({
      character,
      product: job.product,
      profile: job.request.personalization_profile,
      template: getTemplate(job.request.preferred_template, storyFormat),
      storyFormat,
      heroMode,
      videoProvider: job.request.video_provider,
    }, context);
    await checkpoint({ plan });
  }
  const selectedVideoProvider = activeVideoProvider(job);
  const renderPlan = selectedVideoProvider && plan.videoProvider !== selectedVideoProvider
    ? { ...plan, videoProvider: selectedVideoProvider } : plan;
  if (movieFirst) {
    if (!context.saveSceneFrame) throw new MovieError("SCENE_STORE_UNAVAILABLE", "Movie-first rendering requires private scene checkpoints.");
    const movieFirstPlan = job.videoRecoveries?.some(item => item.action === "use-image-motion")
      ? { ...renderPlan, videoProvider: undefined } : renderPlan;
    let movie = job.result;
    if (!movie) {
      await context.warn("Movie-first output uses cinematic motion from generated visuals, not fully generated moving footage. Continuity scoring does not block this mode.");
      const sceneContext: GenerationContext = { ...context, saveFrame: context.saveSceneFrame };
      const frames = await storyboard.generate({
        plan: movieFirstPlan, character, product: job.product,
        existingFrames: [...job.frames, ...(job.sceneFrames ?? [])].filter(frame => frame.source !== "extracted"),
        productionMode: "movie-first",
      }, sceneContext);
      validateRenderInput({ plan: movieFirstPlan, frames, hero: null, productionMode: "movie-first" }, job.id);
      await context.report({ stage: "ASSEMBLING", message: "Making the movie before extracting its storyboard.", provider: "FFmpeg" });
      movie = await renderer.render({ plan: movieFirstPlan, frames, hero: null, productionMode: "movie-first" }, context);
      await checkpoint({ result: movie });
    }
    await context.report({ stage: "EXTRACTING_STORYBOARD", message: "Movie encoded. Extracting storyboard images from its actual frames.", provider: "FFmpeg" });
    await (services?.extract ?? extractStoryboard)(config, movieFirstPlan, movie, context);
    return movie;
  }
  let frames = await storyboard.generate({ plan: renderPlan, character, product: job.product, existingFrames: job.frames }, context);
  if (context.finalizeStoryboard) frames = await context.finalizeStoryboard();
  let hero = job.hero;
  validateRenderInput({ plan: renderPlan, frames, hero }, job.id);
  const veoOperation = selectedVideoProvider === "google-veo" ? activeVideoOperations(job, "Google Veo").at(-1)?.id : undefined;
  const heroPreviouslyAttempted = job.heroAttempted || !!veoOperation;
  const heroEndpoints = selectedVideoProvider === "google-veo" && job.request.enable_hero_video && !hero && !heroPreviouslyAttempted
    ? validateHeroEndpoints(job, frames)
    : undefined;
  if (job.request.render_layout === "video-bookends" && getMovieFormat(job.request.movie_duration_seconds).clipCount > 1) {
    const video = services?.video ?? (selectedVideoProvider === "openai-sora" ? createOpenAIVideoService(config) : createVeoService(config));
    const videoClips = await (services?.sequence ?? generateVideoSequence)(job, renderPlan, character, frames, context, checkpoint, config, { video });
    const result = await renderer.render({
      plan: renderPlan, frames, hero: videoClips[0], videoClips,
      renderLayout: job.request.render_layout, movieDurationSeconds: job.request.movie_duration_seconds,
    }, context);
    requireRenderLayout(result, job.request.render_layout, job.request.movie_duration_seconds);
    return result;
  }
  if (selectedVideoProvider === "openai-sora") {
    if (renderPlan.videoProvider !== "openai-sora") throw new MovieError("INVALID_VIDEO_PLAN", "Create a reviewed, car-only Sora hero plan before generating animation.");
    const operation = job.operations.filter(item => item.provider === "OpenAI Sora").at(-1)?.id;
    if (!hero) {
      if (job.heroAttempted && !operation) {
        throw new MovieError("SORA_SUBMISSION_UNCERTAIN", "The previous video attempt has no recoverable operation ID. Inspect it before authorizing a new take; a second paid render was not submitted.");
      }
      await checkpoint({ heroAttempted: true });
      await context.report({
        stage: "GENERATING_HERO", provider: "OpenAI Sora",
        message: operation ? "Resuming the existing OpenAI video operation without submitting another render." : "Generating the required car-only animation with OpenAI Sora 2 Pro.",
      });
      hero = await (services?.video ?? createOpenAIVideoService(config)).generate({
        plan: renderPlan, character, product: job.product, frames, ...(operation ? { operationId: operation } : {}),
      }, context);
      if (!hero) throw new MovieError("ANIMATION_REQUIRED", "The OpenAI animated clip is not available. A still-only movie was not substituted.");
      await checkpoint({ hero });
    }
    if (hero.provider !== "OpenAI Sora") throw new MovieError("ANIMATION_REQUIRED", "This movie requires a genuine OpenAI Sora clip.");
    await context.report({ stage: "ASSEMBLING", provider: "FFmpeg", message: "Mixing approved still shots with the generated OpenAI animation." });
    const result = await renderer.render({ plan: renderPlan, frames, hero, renderLayout: job.request.render_layout, movieDurationSeconds: job.request.movie_duration_seconds }, context);
    requireRenderLayout(result, job.request.render_layout, job.request.movie_duration_seconds);
    if (result.mode !== "hybrid-video") throw new MovieError("ANIMATION_REQUIRED", "The final output did not include the required generated animation.");
    return result;
  }
  if (selectedVideoProvider === "google-veo" && !hero && job.heroAttempted && !veoOperation) {
    throw new MovieError("VEO_SUBMISSION_UNCERTAIN", "A previous Veo submission was marked as started, but no operation ID was saved. Inspect that submission before authorizing a replacement; retry will not submit another paid video blindly.", 409);
  }
  if (job.request.enable_hero_video && !hero && (!heroPreviouslyAttempted || (selectedVideoProvider === "google-veo" && veoOperation))) {
    await context.report({ stage: "GENERATING_HERO", message: veoOperation
      ? "Resuming the saved Veo animation without another video submission."
      : "Preparing the hero-video animation." });
    hero = await (services?.video ?? createVeoService(config)).generate({
      plan: renderPlan, character, product: job.product, frames, ...(veoOperation ? { operationId: veoOperation } : {}),
      ...(heroEndpoints ? { heroEndpoints } : {}),
    }, { ...context, beforeVideoSubmission: () => checkpoint({ heroAttempted: true }) });
    await checkpoint({ hero });
  } else if (job.request.enable_hero_video && !hero && heroPreviouslyAttempted) {
    await context.warn(selectedVideoProvider === "google-veo"
      ? "The previously attempted Veo operation was not blindly resubmitted. This movie still requires a completed animation clip."
      : "The previously attempted optional hero video was not resubmitted. Keeping the approved storyboard-motion segment.");
  }
  if (selectedVideoProvider === "google-veo" && hero?.provider !== "Google Veo") {
    throw new MovieError("ANIMATION_REQUIRED", "The required Google Veo animation was not completed. No still-only movie was substituted. Check the saved provider warnings before another attempt.", 502);
  }
  await context.report({ stage: "ASSEMBLING", message: `Assembling the ${timeline.shotIds.length}-shot advertisement.`, provider: "FFmpeg" });
  const result = await renderer.render({ plan: renderPlan, frames, hero, renderLayout: job.request.render_layout, movieDurationSeconds: job.request.movie_duration_seconds }, context);
  requireRenderLayout(result, job.request.render_layout, job.request.movie_duration_seconds);
  if (selectedVideoProvider === "google-veo" && result.mode !== "hybrid-video") {
    throw new MovieError("ANIMATION_REQUIRED", "The final output did not include the required Veo animation.");
  }
  return result;
}
