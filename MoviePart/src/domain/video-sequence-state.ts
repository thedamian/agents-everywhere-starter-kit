import { getMovieFormat, MovieError, type MovieJob, type VideoSegment } from "./index";

export function activeVideoProvider(job: MovieJob): "google-veo" | "openai-sora" | undefined {
  return job.videoRecoveries?.some(item => item.action === "use-sora") ? "openai-sora" : job.request.video_provider;
}

export function activeVideoOperations(job: MovieJob, provider: "Google Veo" | "OpenAI Sora") {
  const superseded = new Set((job.videoRecoveries ?? []).flatMap(item =>
    item.supersededOperationId ? [item.supersededOperationId] : []));
  return job.operations.filter(item => item.provider === provider && !superseded.has(item.id));
}

export function videoClipCount(job: MovieJob): 1 | 2 | 3 {
  return job.request.render_layout === "video-bookends" ? getMovieFormat(job.request.movie_duration_seconds).clipCount : 1;
}

export function savedVideoSegments(job: MovieJob): VideoSegment[] {
  const count = videoClipCount(job);
  const provider = activeVideoProvider(job) === "openai-sora" ? "OpenAI Sora" : "Google Veo";
  const operations = activeVideoOperations(job, provider);
  const saved = new Map<number, VideoSegment>();
  for (const segment of job.videoSegments ?? []) {
    if (saved.has(segment.index) || segment.index >= count) {
      throw new MovieError("INVALID_VIDEO_STATE", "The saved animation sequence does not match the requested movie length.", 409);
    }
    saved.set(segment.index, segment);
  }
  const operationIds = new Set<string>();
  const unclaimedOperations = operations.filter(operation =>
    !(job.videoSegments ?? []).some(segment => segment.operationId === operation.id));
  return Array.from({ length: count }, (_, index) => {
    const previous = saved.get(index);
    const operation = previous?.operationId
      ? undefined
      : job.videoSegments
      ? previous?.submitted ? unclaimedOperations.shift() : undefined
      : count === 1 ? operations.at(-1) : operations[index];
    if (previous?.operationId && operation && previous.operationId !== operation.id) {
      throw new MovieError("INVALID_VIDEO_STATE", "The saved animation operation does not match its segment.", 409);
    }
    if (index === 0 && previous?.clip && job.hero && previous.clip.assetId !== job.hero.assetId) {
      throw new MovieError("INVALID_VIDEO_STATE", "The first animation segment does not match the saved hero clip.", 409);
    }
    const operationId = previous?.operationId ?? operation?.id;
    if (operationId) {
      if (operationIds.has(operationId)) throw new MovieError("INVALID_VIDEO_STATE", "The same video operation cannot fill multiple animation segments.", 409);
      operationIds.add(operationId);
    }
    return {
      index, submitted: previous?.submitted ?? (index === 0 ? !!job.heroAttempted : false),
      ...(previous?.startFrameAssetId ? { startFrameAssetId: previous.startFrameAssetId } : {}),
      ...(previous?.clip ? { clip: previous.clip } : index === 0 && job.hero ? { clip: job.hero } : {}),
      ...(operationId ? { operationId } : {}),
    };
  });
}

export function hasUncertainVideoSegment(job: MovieJob): boolean {
  return !!job.videoSegments && savedVideoSegments(job).some(segment => segment.submitted && !segment.operationId && !segment.clip);
}
