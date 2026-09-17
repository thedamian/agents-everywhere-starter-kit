import React from "react";
import type { JobView } from "../../integration/contracts";
import { getMovieFormat } from "../domain";

export function MovieRecovery({ job, retrying, disabled, onRetry, onMakeMovie, onReplaceClip, onUseImageMotion }: {
  job: JobView; retrying: boolean; disabled: boolean; onRetry: () => void; onMakeMovie?: () => void;
  onReplaceClip?: () => void; onUseImageMotion?: () => void;
}) {
  if (job.status !== "FAILED" || !job.retry?.eligible) return null;
  if (onMakeMovie) return <section className="movie-recovery" aria-label="Finish this movie">
    <h3>{job.result ? "Movie encoded — finish extracting its storyboard" : "Make the movie without the continuity loop"}</h3>
    <p>Keep the saved plan and usable visuals. Generate missing scene visuals once, encode an animated-image movie, then extract its storyboard. No continuity score or approval is required.</p>
    <p>This uses cinematic image motion, not fully generated moving footage. New scene generation may incur API charges; existing visuals are reused.</p>
    <button type="button" className="retry-button" disabled={disabled || retrying} onClick={onMakeMovie}>{retrying ? "Starting…" : job.result ? "Extract storyboard from movie" : "Make movie from this plan"}</button>
  </section>;
  const recovery = job.retry.videoRecovery;
  if (recovery) return <section className="movie-recovery" aria-label="Recover rejected animation">
    <h3>{recovery.replacementAvailable
      ? recovery.rejectedSegment !== undefined ? `Replace animation clip ${recovery.rejectedSegment + 1}` : "Try Veo again"
      : "Choose an explicit fallback"}</h3>
    <p>{recovery.veoSubmissionUncertain
      ? recovery.replacementAvailable
        ? `Veo may have accepted the request, but it returned no operation ID. You may explicitly authorize replacement attempt ${recovery.replacementAttempts + 1} of ${recovery.maxReplacementAttempts}; the prior request may also have been charged.`
        : "Veo may have accepted the request, but it returned no operation ID. Both replacement attempts have been used; no additional provider request will be made."
      : recovery.replacementAvailable
        ? `The retained Veo clip did not pass continuity review. You may explicitly authorize replacement ${recovery.replacementAttempts + 1} of ${recovery.maxReplacementAttempts}.`
        : "Both Veo replacements failed continuity review. No additional video-provider request will be made."}</p>
    {recovery.replacementAvailable ? <>
      <p>Generate one new Veo replacement while keeping the approved storyboard and completed clips. This authorizes another paid provider request. {recovery.veoSubmissionUncertain ? "Because the prior submission returned no operation ID, it may also have been accepted and charged. " : ""}Replacement attempt {recovery.replacementAttempts + 1} of {recovery.maxReplacementAttempts}.</p>
      <button type="button" className="retry-button" disabled={disabled || retrying} onClick={onReplaceClip}>
        {retrying ? "Authorizing replacement…" : "Generate replacement clip"}
      </button>
    </> : !recovery.veoSubmissionUncertain ? <>
      <p>Both replacement attempts have been used. An operator can now finish this saved plan as image motion. No additional Veo request will be submitted, and the result will be labeled as image motion rather than generated footage.</p>
      <button type="button" className="retry-button fallback-button" disabled={disabled || retrying} onClick={onUseImageMotion}>
        {retrying ? "Starting image motion…" : "Use image motion instead"}
      </button>
    </> : <p>The replacement limit is exhausted. Create a new take to request more generated video.</p>}
  </section>;
  const { approvedShots, remainingShots } = job.retry;
  const requiresSora = job.plan?.videoProvider === "openai-sora";
  const requiresAnimation = !!job.plan?.videoProvider;
  const selectingHeroEndpoints = job.error?.code === "HERO_ENDPOINT_SELECTION_REQUIRED";
  const heroEndpointsReady = !!job.heroEndpoints?.startAssetId && !!job.heroEndpoints.endAssetId;
  const requiredClips = job.renderLayout === "video-bookends" ? getMovieFormat(job.movieDurationSeconds).clipCount : 1;
  const readyClips = job.videoClips?.length ?? Number(!!job.hero);
  const animationPending = requiresAnimation && readyClips < requiredClips;
  return <section className="movie-recovery" aria-label="Resume incomplete movie">
    <h3>{selectingHeroEndpoints ? "Choose the Veo hero endpoints" : remainingShots ? "Continue this movie, not a new take" : animationPending ? "Your storyboard is approved; animation is next" : "Your approved storyboard is ready for assembly"}</h3>
    {selectingHeroEndpoints && <p>Select two different approved storyboard images below: one hero start and one hero end. This pause occurs before any paid Veo request. Continue becomes available after both selections are saved.</p>}
    <p id="retry-description">Keep the saved director plan, original references, and {approvedShots} approved {approvedShots === 1 ? "shot" : "shots"}. {remainingShots ? `Retry the ${remainingShots} failed or missing shots with their latest review corrections. Only new generation and review work may incur API charges.` : animationPending ? "Approved storyboard images and the director plan are reused. A missing video endpoint may still need generation or review, which can incur API charges." : "No storyboard images or director plan will be regenerated."}</p>
    <p>Retry uses this movie’s saved settings, not changes in the form. A final movie is produced only when every required shot is approved.</p>
    {requiredClips > 1 && <p>{readyClips} of {requiredClips} animation clips are ready. Completed clips are reused; only unfinished segments can incur new generation or review charges.</p>}
    <p>{requiresSora ? "OpenAI animation is required. A saved video operation resumes by ID; without a completed clip, no slideshow is substituted." : requiresAnimation ? "Google Veo animation is required. Preparation resumes if no video was submitted; a saved video operation resumes by ID. Uncertain paid submissions are never blindly repeated." : "If an optional hero-video step has not run yet, it may still run under the saved settings and incur charges. A previously attempted hero video is not resubmitted."}</p>
    <button type="button" className="retry-button" disabled={disabled || retrying || selectingHeroEndpoints && !heroEndpointsReady} aria-describedby="retry-description" onClick={onRetry}>{retrying ? "Requesting retry…" : selectingHeroEndpoints ? heroEndpointsReady ? "Continue with selected endpoints" : "Select both endpoints below" : (job.reviewRevision ?? 0) > 0 ? "Continue with my selections" : remainingShots ? "Retry failed and remaining shots" : animationPending ? "Resume animation and assembly" : "Retry final assembly"}</button>
  </section>;
}
