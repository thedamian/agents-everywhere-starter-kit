import ffprobe from "ffprobe-static";
import { MovieError, videoArtifactSchema, type CharacterReference, type MovieJob, type MoviePlan, type StoryboardFrame, type VideoArtifact } from "../domain";
import { savedVideoSegments } from "../domain/video-sequence-state";
import { activeVideoProvider } from "../domain/video-sequence-state";
import { validateHeroEndpoints } from "../jobs/retry";
import type { GenerationContext, MovieCheckpoint, MovieConfig, VideoService } from "../domain/services";
import { createContinuationReference } from "../render/continuation";
import { probeMedia } from "../render/probe";

export interface VideoSequenceDependencies {
  video: VideoService;
  continuation?: typeof createContinuationReference;
  probe?: typeof probeMedia;
}

export async function generateVideoSequence(
  job: MovieJob, plan: MoviePlan, character: CharacterReference, frames: StoryboardFrame[],
  context: GenerationContext, checkpoint: MovieCheckpoint, config: MovieConfig,
  dependencies: VideoSequenceDependencies,
): Promise<VideoArtifact[]> {
  const selectedProvider = activeVideoProvider(job);
  const provider = selectedProvider === "openai-sora" ? "OpenAI Sora" : "Google Veo";
  if (!selectedProvider || plan.videoProvider !== selectedProvider) {
    throw new MovieError("INVALID_VIDEO_PLAN", "A generated animation sequence requires the saved plan's explicit video provider.", 409);
  }
  const segments = savedVideoSegments(job);
  const firstSegment = segments[0];
  const heroEndpoints = selectedProvider === "google-veo" && !firstSegment.clip && !firstSegment.operationId && !firstSegment.submitted
    ? validateHeroEndpoints(job)
    : undefined;
  const checkpointSegments = () => checkpoint({ videoSegments: structuredClone(segments) });
  const validateClip = async (clip: VideoArtifact) => {
    if (!videoArtifactSchema.safeParse(clip).success || clip.provider !== provider || clip.shotId !== plan.heroShotId) {
      throw new MovieError("INVALID_VIDEO_SEGMENT", "The animation segment has the wrong provider or reference shot.", 409);
    }
    const asset = await context.media.getAsset(clip.assetId);
    if (asset.ownerId !== context.ownerId || asset.jobId !== context.jobId || asset.kind !== "video" || asset.mime !== "video/mp4"
      || asset.bytes <= 0 || asset.bytes > 100 * 1024 * 1024) {
      throw new MovieError("SAVED_HERO_UNAVAILABLE", "An animation segment is missing or does not belong to this movie.", 409);
    }
    if ((await context.media.readAsset(clip.assetId)).byteLength !== asset.bytes) {
      throw new MovieError("SAVED_HERO_UNAVAILABLE", "A saved animation segment has changed; no replacement was generated.", 409);
    }
    const media = await (dependencies.probe ?? probeMedia)(config.ffprobePath ?? ffprobe.path, await context.media.assetPath(clip.assetId), context.signal);
    if (media.videoStreamCount !== 1 || !media.video || media.video.codec !== "h264"
      || media.video.durationSeconds === null || media.video.durationSeconds < 8 - 1 / 24 || media.video.durationSeconds > 8.5
      || media.video.width !== 1280 || media.video.height !== 720) {
      throw new MovieError("INVALID_VIDEO_SEGMENT", "Every animation segment must be a usable eight-second 720p video. No still-image padding was substituted.", 409);
    }
  };
  const seen = new Set<string>();
  for (const segment of segments) {
    if (segment.submitted && !segment.operationId && !segment.clip) {
      throw new MovieError("VIDEO_SUBMISSION_UNCERTAIN", `Animation segment ${segment.index + 1} may already have been submitted, but no operation ID was saved. Inspect it before authorizing another paid video.`, 409);
    }
    if (segment.clip) {
      if (seen.has(segment.clip.assetId)) throw new MovieError("INVALID_VIDEO_SEGMENT", "A longer movie cannot repeat an existing clip in place of new animation.", 409);
      seen.add(segment.clip.assetId);
      await validateClip(segment.clip);
    }
  }
  await checkpointSegments();
  for (const segment of segments) {
    context.signal.throwIfAborted();
    if (segment.clip) {
      await context.report({ stage: "GENERATING_HERO", provider, message: `Reusing approved animation ${segment.index + 1} of ${segments.length}; no generation or review charge.` });
      continue;
    }
    let continuation: Parameters<VideoService["generate"]>[0]["continuation"];
    if (segment.index > 0) {
      const previous = segments[segment.index - 1].clip;
      if (!previous) throw new MovieError("INVALID_VIDEO_STATE", "The preceding animation segment must be approved before continuing.", 409);
      if (!segment.startFrameAssetId && !segment.operationId) {
        segment.startFrameAssetId = await (dependencies.continuation ?? createContinuationReference)(config, previous, context);
        await checkpointSegments();
      }
      if (segment.startFrameAssetId) continuation = { assetId: segment.startFrameAssetId, index: segment.index, count: segments.length };
    }
    await context.report({ stage: "GENERATING_HERO", provider, message: `${segment.operationId ? "Resuming" : "Generating"} animation ${segment.index + 1} of ${segments.length}. Approved clips are retained.` });
    const scoped: GenerationContext = {
      ...context,
      beforeVideoSubmission: async () => {
        segment.submitted = true;
        await checkpoint({ videoSegments: structuredClone(segments), ...(segment.index === 0 ? { heroAttempted: true } : {}) });
      },
      recordOperation: async (name, id) => {
        if (name === provider && segments.some(other => other.index !== segment.index && other.operationId === id)) {
          throw new MovieError("INVALID_VIDEO_SEGMENT", "The provider returned an operation already used by another animation segment.", 409);
        }
        await context.recordOperation(name, id);
        if (name === provider) {
          segment.operationId = id;
          await checkpointSegments();
        }
      },
    };
    const clip = await dependencies.video.generate({
      plan, character, product: job.product, frames,
      ...(segment.operationId ? { operationId: segment.operationId } : {}),
      ...(continuation ? { continuation } : {}),
      ...(segment.index === 0 && heroEndpoints ? { heroEndpoints } : {}),
    }, scoped);
    if (!clip) throw new MovieError("ANIMATION_REQUIRED", `Animation segment ${segment.index + 1} is not available. A shorter movie or still-only segment was not substituted.`, 502);
    await validateClip(clip);
    if (seen.has(clip.assetId)) throw new MovieError("INVALID_VIDEO_SEGMENT", "Each animation segment must use its own generated footage.", 409);
    seen.add(clip.assetId);
    segment.clip = clip;
    await checkpoint({ videoSegments: structuredClone(segments), ...(segment.index === 0 ? { hero: clip } : {}) });
  }
  return segments.map(segment => {
    if (!segment.clip) throw new MovieError("ANIMATION_REQUIRED", "Every requested animation segment must be completed before assembly.", 502);
    return segment.clip;
  });
}
