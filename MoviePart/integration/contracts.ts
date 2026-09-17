/**
 * Movie Magic's transport contract for Dwight and Damian.
 * This file has no framework, provider, Zod, or Node.js dependency.
 * Copy this folder into a consumer project; do not import MoviePart internals.
 */
export type TemplateId = "VELOCITY" | "TOMORROW_DRIVE" | "DREAM_ROUTE" | "HERO_OF_THE_DAY";
export type ProductionMode = "reviewed-storyboard" | "movie-first";
export type RenderLayout = "storyboard" | "video-bookends";
export type MovieDuration = 13 | 15 | 18 | 23 | 28;
export type VideoProviderId = "openai-sora" | "google-veo";
export type StoryFormat = "four-shot" | "six-shot";
export type HeroMode = "LIKENESS" | "POV" | "PERSONALIZED";
export type ShotId = "shot_01" | "shot_02" | "shot_03" | "shot_04" | "shot_05" | "shot_06";
export type JobStatus =
  | "RECEIVED" | "BUILDING_REFERENCES" | "DIRECTING" | "STORYBOARDING"
  | "VALIDATING" | "GENERATING_HERO" | "ASSEMBLING" | "EXTRACTING_STORYBOARD" | "COMPLETED" | "FAILED";

export interface Consent {
  likeness: true;
  personalization: true;
}

export interface PersonalizationSignal {
  value: string;
  source: "manual" | "approved-research";
  visualUseAllowed: true;
  /** Use null for manually provided facts; do not manufacture confidence. */
  confidence: number | null;
}

export interface PersonalizationProfile {
  /** Zero to three approved signals. */
  signals: PersonalizationSignal[];
  /** Optional, explicitly approved details; first name max 80, city max 120 characters. */
  customerFirstName?: string;
  city?: string;
}

export interface MovieJobRequest {
  schema_version: 1;
  production_mode?: ProductionMode;
  /** Two zoomed still bookends around genuine generated footage. Requires video_provider. */
  render_layout?: RenderLayout;
  /** Requires video-bookends; defaults to 15. Longer formats generate additional eight-second clips. */
  movie_duration_seconds?: MovieDuration;
  /** Opaque robot/conversation identifier, echoed as JobView.sessionId. */
  session_id: string;
  /** Upload photos first; these are server-issued IDs, never paths or URLs. */
  customer_reference_asset_ids: string[];
  /** Required but nullable. LIKENESS requires a primary ID and one to four photos. */
  primary_reference_asset_id: string | null;
  consent: Consent;
  product_id: string;
  personalization_profile: PersonalizationProfile;
  /** Defaults to DREAM_ROUTE when omitted. */
  preferred_template?: TemplateId;
  /** Reference-plan format, independent of movie_duration_seconds. Legacy output stays 18/23/24 seconds. */
  story_format?: StoryFormat;
  /** Defaults to LIKENESS. POV/PERSONALIZED never send customer photos to providers. */
  hero_mode?: HeroMode;
  /** Defaults to false. A failure of this enhancement uses storyboard motion. */
  enable_hero_video?: boolean;
  /** Sora requires a real animated car-only clip, never a still-only fallback. */
  video_provider?: VideoProviderId;
  /** Reuse for a transport retry of the same request; change for a new movie. */
  idempotency_key: string;
}

export interface MovieJobAccepted {
  job_id: string;
  status: JobStatus;
  status_url: string;
}

export interface AssetView {
  id: string;
  mime: string;
  width: number | null;
  height: number | null;
}

export interface UploadResponse {
  /** Same order as the multipart photos fields. */
  assets: AssetView[];
}

export interface SceneTemplate {
  id: TemplateId;
  version: 1;
  name: string;
  description: string;
  tone: string;
  camera: string;
  worldTransition: string;
  beats: string[];
  sound: string;
  storyFormat?: StoryFormat;
  source?: { author: string; files: string[]; adaptation: string };
  sourceBeats?: {
    beat: string; name: string; goal: string; default_duration: number;
    camera_hint: string; sound_hint: string; personalization_slot: string | null; product_visible: boolean;
  }[];
  directorPersonality?: { tone: string[]; avoid: string[] };
  cinematography?: { pacing: string; camera: string; lighting: string; style: string; color_palette: string };
  soundDesign?: { music_style: string; tempo_bpm: number; energy_arc: string };
  personalizationSlots?: string[];
}

export interface Readiness {
  available: boolean;
  message: string;
}

export interface ConfigView {
  templates: SceneTemplate[];
  products: { id: string; name: string; ready: boolean }[];
  providers: { openai: Readiness; veo: Readiness; openaiVideo?: Readiness };
  worker: Readiness;
  renderer: Readiness;
}

export interface ReferenceImage {
  assetId: string;
  role: string;
  origin: "original" | "generated";
}

export interface CharacterAttributes {
  face: string | null;
  eyes: string | null;
  eyebrows: string | null;
  nose: string | null;
  mouth: string | null;
  hair: string | null;
  complexion: string | null;
  visibleProportions: string | null;
  wardrobe: string | null;
  accessories: string[];
}

export interface CharacterReference {
  id: string;
  version: 1;
  sourceImages: ReferenceImage[];
  primaryAssetId: string | null;
  attributes: CharacterAttributes;
  consent: Consent;
}

export interface ShotPlan {
  id: ShotId;
  durationSeconds: number;
  purpose: string;
  camera: string;
  action: string;
  environment: string;
  lighting: string;
  personalization: string[];
  imagePrompt: string;
  motionPrompt: string;
  audioCues: string[];
}

export interface MoviePlan {
  id: string;
  characterId: string;
  productId: string;
  templateId: TemplateId;
  templateVersion: 1;
  referenceVersion: 1;
  storyFormat?: StoryFormat;
  heroMode?: HeroMode;
  durationSeconds: number;
  aspectRatio: "16:9";
  heroShotId: "shot_03" | "shot_04";
  videoProvider?: VideoProviderId;
  logline: string;
  wardrobe: string;
  cinematicStyle: string;
  worldTransitions: string;
  personalizationUsed: string[];
  shots: ShotPlan[];
}

export interface ContinuityResult {
  verdict: "PASS" | "RETRY" | "REJECT";
  reasons: string[];
  confidence: number;
}

export interface StoryboardFrame {
  shotId: string;
  assetId: string;
  continuity: Omit<ContinuityResult, "verdict"> & { verdict: ContinuityResult["verdict"] | "NOT_REVIEWED" };
  provider: string;
  model: string;
  source?: "generated" | "extracted";
  extractedAtSeconds?: number;
  designerDecision?: { action: "keep" | "regenerate"; note: string; at: string };
}

export interface VideoArtifact {
  assetId: string;
  shotId: "shot_03" | "shot_04";
  provider: "Google Veo" | "OpenAI Sora";
  model: string;
  operationId?: string;
}

export interface RenderResult {
  assetId: string;
  mode: "storyboard-motion" | "hybrid-video" | "image-motion";
  durationSeconds: number;
  hasAudio: boolean;
  renderLayout?: RenderLayout;
}

export interface JobEvent {
  at: string;
  stage: JobStatus;
  message: string;
  provider: string | null;
  shotId: string | null;
}

export interface MovieRetryRequest {
  /** Reuse this key and expected_attempt when retrying an uncertain HTTP response. */
  idempotency_key: string;
  /** Number of retries already accepted, from JobView.retry.attempt. */
  expected_attempt: number;
  /** Explicitly switch a failed reviewed job to movie-first production. */
  production_mode?: "movie-first";
  /**
   * Explicit operator recovery for a continuity-rejected Google Veo clip.
   * Replacement may create one additional paid request. Image motion is
   * available only after the bounded replacement attempts are exhausted.
   */
  video_recovery_action?: "replace-rejected-clip" | "use-image-motion";
}
export interface MovieRetryAccepted extends MovieJobAccepted {
  retry_attempt: number;
}
export interface MovieRetrySummary {
  attempt: number;
  eligible: boolean;
  approvedShots: number;
  remainingShots: number;
  videoRecovery?: {
    replacementAttempts: number;
    maxReplacementAttempts: number;
    rejectedSegment?: number;
    veoSubmissionUncertain: boolean;
    replacementAvailable: boolean;
    imageMotionAvailable: boolean;
  };
}

export interface FrameDecisionRequest {
  action: "keep" | "regenerate";
  note?: string;
  idempotency_key: string;
  expected_revision: number;
  expected_attempt: number;
  resume?: boolean;
}

export interface HeroEndpointSelectionRequest {
  role: "start" | "end";
  asset_id: string;
  idempotency_key: string;
  expected_revision: number;
  expected_attempt: number;
}

export interface JobView {
  id: string;
  sessionId: string;
  status: JobStatus;
  productionMode?: ProductionMode;
  renderLayout?: RenderLayout;
  movieDurationSeconds?: MovieDuration;
  createdAt: string;
  updatedAt: string;
  events: JobEvent[];
  warnings: string[];
  error: { code: string; message: string; stage: JobStatus } | null;
  character: CharacterReference | null;
  plan: MoviePlan | null;
  frames: StoryboardFrame[];
  hero: VideoArtifact | null;
  /** Approved sequence clips, in playback order; the first is also available as hero. */
  videoClips?: VideoArtifact[];
  /** Available only after the output file was successfully rendered and probed. */
  result: RenderResult | null;
  /** Explicit recovery uses the saved plan and approved assets, never edited form inputs. */
  retry?: MovieRetrySummary;
  reviewRevision?: number;
  designerReviewAllowed?: boolean;
  heroEndpoints?: { startAssetId?: string; endAssetId?: string };
  heroEndpointRevision?: number;
  heroEndpointSelectionAllowed?: boolean;
}

export interface JobResponse { job: JobView }
export interface ErrorResponse { error: string; code: string }

/** Reserved payload shape for a future event transport; webhooks are not implemented. */
export interface MovieCompletionEvent {
  schema_version: 1;
  type: "movie.completed" | "movie.failed";
  session_id: string;
  job_id: string;
  result: RenderResult | null;
  error: JobView["error"];
}
