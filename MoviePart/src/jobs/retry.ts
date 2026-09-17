import { stat } from "node:fs/promises";
import sharp from "sharp";
import { MAX_VIDEO_REPLACEMENTS, MovieError, productionModeOf, resolveHeroMode, resolveStoryFormat, validatePlan, type MovieJob, type RetryRequest } from "../domain";
import { isFrameApproved, selectStoryboardFrames } from "../domain/storyboard-state";
import type { MediaRepository } from "../domain/services";
import { getWardrobeLock, readImage } from "../references";
import type { GenerationContext } from "../domain/services";
import type { MovieRetrySummary } from "../../integration/contracts";
import { hasUncertainVideoSegment, savedVideoSegments } from "../domain/video-sequence-state";
import { terminalVeoMessage } from "../domain/veo-failure";

export function retrySummary(job: MovieJob): MovieRetrySummary {
  const frames = selectStoryboardFrames(job.frames, job.plan?.shots.map(shot => shot.id) ?? []);
  const approvedShots = frames.filter(isFrameApproved).length;
  const usable = selectStoryboardFrames([...job.frames, ...(job.sceneFrames ?? [])].filter(frame => frame.source !== "extracted"), job.plan?.shots.map(shot => shot.id) ?? [])
    .filter(frame => isFrameApproved(frame) || frame.designerDecision?.action !== "regenerate" && frame.continuity.verdict !== "REJECT").length;
  const uncertainVeoSubmission = !!(job.request.video_provider === "google-veo" && job.heroAttempted && !job.hero
    && !job.operations.some(operation => operation.provider === "Google Veo"));
  const rejectedSegments = job.error?.code === "VEO_CONTINUITY_REJECTED"
    ? savedVideoSegments(job).filter(segment => !segment.clip && !!segment.operationId) : [];
  const replacementAttempts = job.videoRecoveries?.filter(item => item.action === "replace-rejected-clip").length ?? 0;
  const canSwitchUncertainVeo = uncertainVeoSubmission
    && ["VEO_WORKFLOW_FAILED", "VEO_TIMEOUT"].includes(job.error?.code ?? "");
  const videoRecovery = job.request.video_provider === "google-veo" && (rejectedSegments.length === 1 || canSwitchUncertainVeo)
    ? {
        replacementAttempts,
        maxReplacementAttempts: MAX_VIDEO_REPLACEMENTS,
        ...(rejectedSegments[0] ? { rejectedSegment: rejectedSegments[0].index } : {}),
        veoSubmissionUncertain: canSwitchUncertainVeo,
        replacementAvailable: replacementAttempts < MAX_VIDEO_REPLACEMENTS,
        imageMotionAvailable: rejectedSegments.length === 1 && replacementAttempts >= MAX_VIDEO_REPLACEMENTS,
      }
    : undefined;
  const ordinarilyEligible = !uncertainVeoSubmission && !hasUncertainVideoSegment(job);
  return {
    attempt: job.retries?.length ?? 0,
    eligible: job.status === "FAILED" && job.error?.code !== "JOB_CANCELLED" && !terminalVeoMessage(job.error?.code)
      && !!job.plan && !!job.character && (ordinarilyEligible || !!videoRecovery)
      && (!job.result || productionModeOf(job) === "movie-first"),
    approvedShots,
    remainingShots: (job.plan?.shots.length ?? 0) - (productionModeOf(job) === "movie-first" ? usable : approvedShots),
    ...(videoRecovery ? { videoRecovery } : {}),
  };
}

export function validateSavedPlan(job: MovieJob): void {
  if (!job.plan || !job.character) {
    throw new MovieError("RETRY_UNAVAILABLE", "Retry requires a saved director plan and character reference. Create a new movie if planning never completed.", 409);
  }
  validatePlan(job.plan, job.request.personalization_profile);
  const mode = resolveHeroMode(job.request.hero_mode);
  if (job.plan.characterId !== job.character.id || job.plan.productId !== job.product.id ||
      job.product.id !== job.request.product_id || job.plan.templateId !== job.request.preferred_template ||
      resolveStoryFormat(job.plan.storyFormat) !== resolveStoryFormat(job.request.story_format) ||
      resolveHeroMode(job.plan.heroMode) !== mode ||
      job.plan.videoProvider !== job.request.video_provider ||
      job.plan.referenceVersion !== job.character.version || job.plan.referenceVersion !== job.product.version ||
      job.plan.wardrobe !== getWardrobeLock(job.character, mode)) {
    throw new MovieError("INVALID_SAVED_PLAN", "The saved plan no longer matches this movie's immutable references. It cannot be silently replanned.", 409);
  }
  if (mode === "LIKENESS") {
    const originals = job.character.sourceImages.filter(image => image.origin === "original").map(image => image.assetId);
    if (job.character.primaryAssetId !== job.request.primary_reference_asset_id ||
        originals.length !== job.request.customer_reference_asset_ids.length ||
        new Set(originals).size !== originals.length ||
        originals.some(id => !job.request.customer_reference_asset_ids.includes(id))) {
      throw new MovieError("INVALID_SAVED_PLAN", "Saved customer references do not match the original consented request.", 409);
    }
  }
}

export function validateHeroEndpoints(job: MovieJob, frames = job.frames): { startAssetId: string; endAssetId: string } {
  const startAssetId = job.heroEndpoints?.startAssetId;
  const endAssetId = job.heroEndpoints?.endAssetId;
  if (!startAssetId || !endAssetId) {
    throw new MovieError("HERO_ENDPOINT_SELECTION_REQUIRED",
      "Choose one approved storyboard image as the Veo hero start and a different approved image as the hero end before continuing.", 409);
  }
  if (startAssetId === endAssetId) {
    throw new MovieError("HERO_ENDPOINTS_IDENTICAL", "The Veo hero start and end must be different approved storyboard images.", 409);
  }
  const selected = [startAssetId, endAssetId].map(assetId => frames.find(frame => frame.assetId === assetId));
  if (selected.some(frame => !frame || frame.source === "extracted" || !isFrameApproved(frame))) {
    throw new MovieError("HERO_ENDPOINT_UNAVAILABLE", "A selected Veo hero endpoint is no longer an approved storyboard image.", 409);
  }
  return { startAssetId, endAssetId };
}

export async function validateApprovedFrame(
  frame: ReturnType<typeof selectStoryboardFrames>[number],
  context: Pick<GenerationContext, "jobId" | "ownerId" | "media" | "signal">,
  requireApproval = true,
): Promise<void> {
  context.signal.throwIfAborted();
  const asset = await context.media.getAsset(frame.assetId);
  if ((requireApproval && !isFrameApproved(frame)) || asset.kind !== "storyboard" ||
      asset.ownerId !== context.ownerId || asset.jobId !== context.jobId || !asset.mime.startsWith("image/")) {
    throw new MovieError("SAVED_FRAME_UNAVAILABLE", `The approved ${frame.shotId} does not belong to this movie. No replacement was generated automatically.`, 409);
  }
  try {
    const bytes = await context.media.readAsset(frame.assetId);
    if (bytes.length !== asset.bytes || bytes.length > 10 * 1024 * 1024) throw new Error("Size mismatch");
    const { info } = await sharp(bytes, { limitInputPixels: 25_000_000, failOn: "warning" }).raw().toBuffer({ resolveWithObject: true });
    if (info.width !== 1280 || info.height !== 720) throw new Error("Invalid frame dimensions");
  } catch {
    throw new MovieError("SAVED_FRAME_UNAVAILABLE", `The approved ${frame.shotId} file is missing or invalid. Restore it before retrying; approved shots are not silently regenerated.`, 409);
  }
  context.signal.throwIfAborted();
}

/** Read-only preflight, repeated by the worker before any new provider call. */
export async function validateRetryAssets(job: MovieJob, media: MediaRepository, signal = new AbortController().signal): Promise<void> {
  validateSavedPlan(job);
  const context = { jobId: job.id, ownerId: job.ownerId, media, signal };
  if (productionModeOf(job) === "movie-first" && job.result) {
    const asset = await media.getAsset(job.result.assetId);
    const file = await stat(await media.assetPath(asset.id));
    if (asset.ownerId !== job.ownerId || asset.jobId !== job.id || asset.kind !== "video" || file.size !== asset.bytes) {
      throw new MovieError("SAVED_MOVIE_UNAVAILABLE", "The encoded movie is unavailable. Restore it before extracting its storyboard.", 409);
    }
    return;
  }
  if (resolveHeroMode(job.request.hero_mode) === "LIKENESS") {
    for (const id of job.request.customer_reference_asset_ids) await readImage(id, "customer", "Saved original", context);
  }
  for (const image of job.product.referenceImages) {
    const asset = await media.getAsset(image.assetId);
    if (asset.ownerId !== "shared:catalog") throw new MovieError("INVALID_REFERENCE", "Saved product reference is not a catalog asset.", 409);
    await readImage(image.assetId, "product", image.role, context);
  }
  const movieFirst = productionModeOf(job) === "movie-first";
  const saved = selectStoryboardFrames([...job.frames, ...(job.sceneFrames ?? [])].filter(frame => frame.source !== "extracted"), job.plan!.shots.map(shot => shot.id))
    .filter(frame => movieFirst ? isFrameApproved(frame) || frame.designerDecision?.action !== "regenerate" && frame.continuity.verdict !== "REJECT" : isFrameApproved(frame));
  for (const frame of saved) await validateApprovedFrame(frame, context, !movieFirst);
  const videos = [job.hero, ...(job.videoSegments ?? []).map(segment => segment.clip)].filter(video => video !== null && video !== undefined);
  for (const video of new Map(videos.map(video => [video.assetId, video])).values()) {
    const asset = await media.getAsset(video.assetId);
    const file = await stat(await media.assetPath(asset.id));
    if (asset.ownerId !== job.ownerId || asset.jobId !== job.id || asset.kind !== "video" ||
        asset.mime !== "video/mp4" || file.size !== asset.bytes || video.shotId !== job.plan!.heroShotId) {
      throw new MovieError("SAVED_HERO_UNAVAILABLE", "The saved hero clip is not available for this movie. No new video was submitted.", 409);
    }
  }
}
