import { z } from "zod";

export const templateIdSchema = z.enum(["VELOCITY", "TOMORROW_DRIVE", "DREAM_ROUTE", "HERO_OF_THE_DAY"]);
export type TemplateId = z.infer<typeof templateIdSchema>;
export const storyFormatSchema = z.enum(["four-shot", "six-shot"]);
export type StoryFormat = z.infer<typeof storyFormatSchema>;
export const heroModeSchema = z.enum(["LIKENESS", "POV", "PERSONALIZED"]);
export type HeroMode = z.infer<typeof heroModeSchema>;
export const productionModeSchema = z.enum(["reviewed-storyboard", "movie-first"]);
export type ProductionMode = z.infer<typeof productionModeSchema>;
export const renderLayoutSchema = z.enum(["storyboard", "video-bookends"]);
export type RenderLayout = z.infer<typeof renderLayoutSchema>;
export const MOVIE_DURATIONS = [13, 15, 18, 23, 28] as const;
export const movieDurationSchema = z.union(MOVIE_DURATIONS.map(value => z.literal(value)));
export type MovieDuration = z.infer<typeof movieDurationSchema>;
const movieFormats: Record<MovieDuration, { openingSeconds: number; closingSeconds: number; clipCount: 1 | 2 | 3 }> = {
  13: { openingSeconds: 2, clipCount: 1, closingSeconds: 3 },
  15: { openingSeconds: 3, clipCount: 1, closingSeconds: 4 },
  18: { openingSeconds: 1, clipCount: 2, closingSeconds: 1 },
  23: { openingSeconds: 3, clipCount: 2, closingSeconds: 4 },
  28: { openingSeconds: 2, clipCount: 3, closingSeconds: 2 },
};
export function getMovieFormat(duration: MovieDuration = 15) {
  return movieFormats[movieDurationSchema.parse(duration)];
}
export const videoProviderSchema = z.enum(["openai-sora", "google-veo"]);
export type VideoProviderId = z.infer<typeof videoProviderSchema>;
export const isOpenAIHero = (plan: { videoProvider?: VideoProviderId; heroShotId: string }, shotId: string) =>
  plan.videoProvider === "openai-sora" && plan.heroShotId === shotId;
export const productionModeOf = (job: { productionMode?: ProductionMode; request: { production_mode?: ProductionMode } }): ProductionMode =>
  job.productionMode ?? job.request.production_mode ?? "reviewed-storyboard";
export const shotIdSchema = z.enum(["shot_01", "shot_02", "shot_03", "shot_04", "shot_05", "shot_06"]);
export type ShotId = z.infer<typeof shotIdSchema>;
export const resolveStoryFormat = (format?: StoryFormat): StoryFormat => format ?? "four-shot";
export const resolveHeroMode = (mode?: HeroMode): HeroMode => mode ?? "LIKENESS";

export function getTimeline(format?: StoryFormat, templateId?: TemplateId): {
  shotIds: ShotId[]; durations: number[]; heroShotId: "shot_03" | "shot_04"; durationSeconds: number;
} {
  const six = resolveStoryFormat(format) === "six-shot";
  const durations = six ? [3, 3, templateId === "HERO_OF_THE_DAY" ? 3 : 2, 8, 3, 4] : [3, 3, 8, 4];
  return {
    shotIds: shotIdSchema.options.slice(0, durations.length),
    durations, heroShotId: six ? "shot_04" : "shot_03",
    durationSeconds: durations.reduce((sum, value) => sum + value, 0),
  };
}

export function getRenderTimeline(format?: StoryFormat, templateId?: TemplateId, layout?: RenderLayout, duration: MovieDuration = 15): ReturnType<typeof getTimeline> {
  const timeline = getTimeline(format, templateId);
  if (layout !== "video-bookends") return timeline;
  const selected = getMovieFormat(duration);
  return {
    shotIds: [timeline.shotIds[0], ...Array.from({ length: selected.clipCount }, () => timeline.heroShotId), timeline.shotIds[timeline.shotIds.length - 1]],
    durations: [selected.openingSeconds, ...Array.from({ length: selected.clipCount }, () => 8), selected.closingSeconds],
    heroShotId: timeline.heroShotId, durationSeconds: duration,
  };
}
export const imageMimeSchema = z.enum(["image/jpeg", "image/png", "image/webp"]);
export const consentSchema = z.object({
  likeness: z.literal(true),
  personalization: z.literal(true),
}).strict();
export type Consent = z.infer<typeof consentSchema>;

export const signalSchema = z.object({
  value: z.string().trim().min(1).max(100),
  source: z.enum(["manual", "approved-research"]),
  visualUseAllowed: z.literal(true),
  confidence: z.number().min(0).max(1).nullable(),
}).strict();
export const profileSchema = z.object({
  signals: z.array(signalSchema).max(3),
  customerFirstName: z.string().trim().min(1).max(80).optional(),
  city: z.string().trim().min(1).max(120).optional(),
}).strict();
export type PersonalizationProfile = z.infer<typeof profileSchema>;

export const assetSchema = z.object({
  id: z.uuid(),
  ownerId: z.string().min(1),
  jobId: z.uuid().nullable(),
  kind: z.enum(["customer", "product", "storyboard", "video", "audio", "reference"]),
  mime: z.string(),
  filename: z.string(),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  createdAt: z.iso.datetime(),
}).strict();
export type AssetRecord = z.infer<typeof assetSchema>;
export const referenceImageSchema = z.object({
  assetId: z.uuid(),
  role: z.string().min(1).max(80),
  origin: z.enum(["original", "generated"]),
}).strict();
export type ReferenceImage = z.infer<typeof referenceImageSchema>;

// Null means not visible, not a request for the model to invent the attribute.
export const characterAttributesSchema = z.object({
  face: z.string().nullable(),
  eyes: z.string().nullable(),
  eyebrows: z.string().nullable(),
  nose: z.string().nullable(),
  mouth: z.string().nullable(),
  hair: z.string().nullable(),
  complexion: z.string().nullable(),
  visibleProportions: z.string().nullable(),
  wardrobe: z.string().nullable(),
  accessories: z.array(z.string()),
}).strict();
export type CharacterAttributes = z.infer<typeof characterAttributesSchema>;
export const characterSchema = z.object({
  id: z.uuid(),
  version: z.literal(1),
  sourceImages: z.array(referenceImageSchema).max(4),
  primaryAssetId: z.uuid().nullable(),
  attributes: characterAttributesSchema,
  consent: consentSchema,
}).strict();
export type CharacterReference = z.infer<typeof characterSchema>;

export const productSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  version: z.literal(1),
  name: z.string().min(1),
  make: z.string().nullable(),
  model: z.string().nullable(),
  exteriorColor: z.string().min(1),
  interiorColor: z.string().nullable(),
  appearance: z.string().min(1),
  approvedClaims: z.array(z.string()),
  referenceImages: z.array(referenceImageSchema).min(2).max(8),
  usagePermission: z.string().min(1),
}).strict();
export type ProductReference = z.infer<typeof productSchema>;

export const sourceBeatSchema = z.object({
  beat: z.string(), name: z.string(), goal: z.string(), default_duration: z.number().positive(),
  camera_hint: z.string(), sound_hint: z.string(), personalization_slot: z.string().nullable(), product_visible: z.boolean(),
}).strict();
export const templateSchema = z.object({
  id: templateIdSchema,
  version: z.literal(1),
  name: z.string(),
  description: z.string(),
  tone: z.string(),
  camera: z.string(),
  worldTransition: z.string(),
  storyFormat: storyFormatSchema.optional(),
  beats: z.array(z.string()).min(4).max(6),
  sound: z.string(),
  source: z.object({ author: z.string(), files: z.array(z.string()), adaptation: z.string() }).strict().optional(),
  sourceBeats: z.array(sourceBeatSchema).length(6).optional(),
  directorPersonality: z.object({ tone: z.array(z.string()), avoid: z.array(z.string()) }).strict().optional(),
  cinematography: z.object({
    pacing: z.string(), camera: z.string(), lighting: z.string(), style: z.string(), color_palette: z.string(),
  }).strict().optional(),
  soundDesign: z.object({ music_style: z.string(), tempo_bpm: z.number(), energy_arc: z.string() }).strict().optional(),
  personalizationSlots: z.array(z.string()).optional(),
}).strict().superRefine((template, ctx) => {
  if (template.beats.length !== getTimeline(template.storyFormat, template.id).shotIds.length) {
    ctx.addIssue({ code: "custom", message: "Template beats must match the selected story format." });
  }
});
export type SceneTemplate = z.infer<typeof templateSchema>;

export const shotSchema = z.object({
  id: shotIdSchema,
  durationSeconds: z.number().int().positive(),
  purpose: z.string().min(1),
  camera: z.string().min(1),
  action: z.string().min(1),
  environment: z.string().min(1),
  lighting: z.string().min(1),
  personalization: z.array(z.string()).max(5),
  imagePrompt: z.string().min(1),
  motionPrompt: z.string().min(1),
  audioCues: z.array(z.string()),
}).strict();
export type ShotPlan = z.infer<typeof shotSchema>;
export const directorOutputSchema = z.object({
  logline: z.string().min(1),
  wardrobe: z.string().min(1),
  cinematicStyle: z.string().min(1),
  worldTransitions: z.string(),
  personalizationUsed: z.array(z.string()).max(5),
  shots: z.array(shotSchema).min(4).max(6),
}).strict();
export type DirectorOutput = z.infer<typeof directorOutputSchema>;
export function getDirectorOutputSchema(format?: StoryFormat, templateId?: TemplateId) {
  const timeline = getTimeline(format, templateId);
  return directorOutputSchema.extend({
    shots: z.array(shotSchema.extend({
      id: z.enum(timeline.shotIds as [ShotId, ...ShotId[]]),
      durationSeconds: z.union([...new Set(timeline.durations)].map(value => z.literal(value))),
    }).strict()).length(timeline.shotIds.length),
  }).strict();
}
export const moviePlanSchema = directorOutputSchema.extend({
  id: z.uuid(),
  characterId: z.uuid(),
  productId: z.string(),
  templateId: templateIdSchema,
  templateVersion: z.literal(1),
  referenceVersion: z.literal(1),
  storyFormat: storyFormatSchema.optional(),
  heroMode: heroModeSchema.optional(),
  durationSeconds: z.number().int().positive(),
  aspectRatio: z.literal("16:9"),
  heroShotId: z.enum(["shot_03", "shot_04"]),
  videoProvider: videoProviderSchema.optional(),
}).strict().superRefine((plan, ctx) => {
  const timeline = getTimeline(plan.storyFormat, plan.templateId);
  if (plan.durationSeconds !== timeline.durationSeconds || plan.heroShotId !== timeline.heroShotId ||
      plan.shots.length !== timeline.shotIds.length ||
      plan.shots.some((shot, index) => shot.id !== timeline.shotIds[index] || shot.durationSeconds !== timeline.durations[index])) {
    ctx.addIssue({ code: "custom", message: `The director must produce ${timeline.shotIds.length === 4 ? "four" : "six"} ordered shots lasting ${timeline.durations.join(", ")} seconds with the correct hero and total duration.` });
  }
});
export type MoviePlan = z.infer<typeof moviePlanSchema>;

export const continuitySchema = z.object({
  verdict: z.enum(["PASS", "RETRY", "REJECT"]),
  reasons: z.array(z.string()),
  confidence: z.number().min(0).max(1),
}).strict();
export type ContinuityResult = z.infer<typeof continuitySchema>;
export const designerDecisionSchema = z.object({
  action: z.enum(["keep", "regenerate"]),
  note: z.string().max(1000),
  at: z.iso.datetime(),
}).strict();
export const frameDecisionRequestSchema = z.object({
  action: z.enum(["keep", "regenerate"]),
  note: z.string().trim().max(1000).default(""),
  idempotency_key: z.string().min(8).max(120),
  expected_revision: z.number().int().nonnegative(),
  expected_attempt: z.number().int().nonnegative(),
  resume: z.boolean().default(false),
}).strict();
export type FrameDecisionRequest = z.infer<typeof frameDecisionRequestSchema>;
export const heroEndpointRoleSchema = z.enum(["start", "end"]);
export type HeroEndpointRole = z.infer<typeof heroEndpointRoleSchema>;
export const heroEndpointSelectionRequestSchema = z.object({
  role: heroEndpointRoleSchema,
  asset_id: z.uuid(),
  idempotency_key: z.string().min(8).max(120),
  expected_revision: z.number().int().nonnegative(),
  expected_attempt: z.number().int().nonnegative(),
}).strict();
export type HeroEndpointSelectionRequest = z.infer<typeof heroEndpointSelectionRequestSchema>;
export const storyboardFrameSchema = z.object({
  shotId: z.string(),
  assetId: z.uuid(),
  continuity: continuitySchema.extend({ verdict: z.enum(["PASS", "RETRY", "REJECT", "NOT_REVIEWED"]) }).strict(),
  provider: z.string(),
  model: z.string(),
  source: z.enum(["generated", "extracted"]).optional(),
  extractedAtSeconds: z.number().nonnegative().optional(),
  designerDecision: designerDecisionSchema.optional(),
}).strict();
export type StoryboardFrame = z.infer<typeof storyboardFrameSchema>;
export const videoArtifactSchema = z.object({
  assetId: z.uuid(),
  shotId: z.enum(["shot_03", "shot_04"]),
  provider: z.enum(["Google Veo", "OpenAI Sora"]),
  model: z.string(),
  operationId: z.string().optional(),
}).strict();
export type VideoArtifact = z.infer<typeof videoArtifactSchema>;
export const videoSegmentSchema = z.object({
  index: z.number().int().min(0).max(2),
  submitted: z.boolean(),
  operationId: z.string().min(1).optional(),
  startFrameAssetId: z.uuid().optional(),
  clip: videoArtifactSchema.optional(),
}).strict();
export type VideoSegment = z.infer<typeof videoSegmentSchema>;
export const renderResultSchema = z.object({
  assetId: z.uuid(),
  mode: z.enum(["storyboard-motion", "hybrid-video", "image-motion"]),
  durationSeconds: z.number(),
  hasAudio: z.boolean(),
  renderLayout: renderLayoutSchema.optional(),
}).strict();
export type RenderResult = z.infer<typeof renderResultSchema>;

export const jobRequestSchema = z.object({
  schema_version: z.literal(1),
  session_id: z.string().trim().min(1).max(120),
  customer_reference_asset_ids: z.array(z.uuid()).max(4),
  primary_reference_asset_id: z.uuid().nullable(),
  consent: consentSchema,
  product_id: z.string().regex(/^[a-z0-9_-]+$/),
  personalization_profile: profileSchema,
  preferred_template: templateIdSchema.default("DREAM_ROUTE"),
  story_format: storyFormatSchema.optional(),
  hero_mode: heroModeSchema.optional(),
  production_mode: productionModeSchema.optional(),
  render_layout: renderLayoutSchema.optional(),
  movie_duration_seconds: movieDurationSchema.optional(),
  enable_hero_video: z.boolean().default(false),
  video_provider: videoProviderSchema.optional(),
  idempotency_key: z.string().min(8).max(120),
}).strict().superRefine((value, ctx) => {
  if (value.movie_duration_seconds !== undefined && value.render_layout !== "video-bookends") {
    ctx.addIssue({ code: "custom", message: "Selectable movie duration requires the video-bookends layout; legacy storyboard timelines are unchanged." });
  }
  if (value.render_layout === "video-bookends" && (!value.enable_hero_video || !value.video_provider || value.production_mode === "movie-first")) {
    ctx.addIssue({ code: "custom", message: "Video bookends require reviewed storyboards and an explicitly selected video provider." });
  }
  if (value.video_provider && (!value.enable_hero_video || value.production_mode === "movie-first")) {
    ctx.addIssue({ code: "custom", message: "A selected video provider requires reviewed storyboards and an enabled hero video." });
  }
  if (new Set(value.customer_reference_asset_ids).size !== value.customer_reference_asset_ids.length) {
    ctx.addIssue({ code: "custom", message: "Customer photos must be unique." });
  }
  if (resolveHeroMode(value.hero_mode) === "LIKENESS" &&
      (value.customer_reference_asset_ids.length === 0 || value.primary_reference_asset_id === null)) {
    ctx.addIssue({ code: "custom", message: "LIKENESS requires one to four original photos and a primary photo." });
  }
  if (value.primary_reference_asset_id !== null && !value.customer_reference_asset_ids.includes(value.primary_reference_asset_id)) {
    ctx.addIssue({ code: "custom", message: "Primary photo must belong to the submitted references." });
  }
});
export type JobRequest = z.infer<typeof jobRequestSchema>;
export const jobStatusSchema = z.enum([
  "RECEIVED", "BUILDING_REFERENCES", "DIRECTING", "STORYBOARDING",
  "VALIDATING", "GENERATING_HERO", "ASSEMBLING", "EXTRACTING_STORYBOARD", "COMPLETED", "FAILED",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;
export const jobErrorSchema = z.object({ code: z.string(), message: z.string(), stage: jobStatusSchema }).strict();
export const retryRequestSchema = z.object({
  idempotency_key: z.string().min(8).max(120),
  expected_attempt: z.number().int().min(0).max(1_000_000),
  production_mode: z.literal("movie-first").optional(),
  video_recovery_action: z.enum(["replace-rejected-clip", "use-image-motion"]).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.production_mode && value.video_recovery_action) {
    ctx.addIssue({ code: "custom", message: "Choose one recovery action." });
  }
});
export type RetryRequest = z.infer<typeof retryRequestSchema>;
export const retryRecordSchema = z.object({
  idempotencyKey: z.string(),
  expectedAttempt: z.number().int().nonnegative(),
  requestedAt: z.iso.datetime(),
  previousError: jobErrorSchema.nullable(),
  productionMode: productionModeSchema.optional(),
  videoRecoveryAction: z.enum(["replace-rejected-clip", "use-sora", "use-image-motion"]).optional(),
}).strict();
export const MAX_VIDEO_REPLACEMENTS = 2;
export const videoRecoveryRecordSchema = z.object({
  action: z.enum(["replace-rejected-clip", "use-sora", "use-image-motion"]),
  at: z.iso.datetime(),
  segmentIndex: z.number().int().min(0).max(2).optional(),
  supersededOperationId: z.string().min(1).optional(),
}).strict();
export const jobEventSchema = z.object({
  at: z.iso.datetime(),
  stage: jobStatusSchema,
  message: z.string(),
  provider: z.string().nullable(),
  shotId: z.string().nullable(),
}).strict();
export type JobEvent = z.infer<typeof jobEventSchema>;
export const jobSchema = z.object({
  id: z.uuid(),
  ownerId: z.string(),
  request: jobRequestSchema,
  product: productSchema,
  status: jobStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  events: z.array(jobEventSchema),
  warnings: z.array(z.string()),
  error: jobErrorSchema.nullable(),
  character: characterSchema.nullable(),
  plan: moviePlanSchema.nullable(),
  frames: z.array(storyboardFrameSchema),
  sceneFrames: z.array(storyboardFrameSchema).optional(),
  productionMode: productionModeSchema.optional(),
  hero: videoArtifactSchema.nullable(),
  heroAttempted: z.boolean().optional(),
  videoSegments: z.array(videoSegmentSchema).max(3).optional(),
  result: renderResultSchema.nullable(),
  operations: z.array(z.object({ provider: z.string(), id: z.string() })),
  retries: z.array(retryRecordSchema).optional(),
  videoRecoveries: z.array(videoRecoveryRecordSchema).max(MAX_VIDEO_REPLACEMENTS + 2).optional(),
  designerDecisions: z.array(z.object({
    assetId: z.uuid(),
    request: frameDecisionRequestSchema,
    at: z.iso.datetime(),
  }).strict()).optional(),
  heroEndpoints: z.object({
    startAssetId: z.uuid().optional(),
    endAssetId: z.uuid().optional(),
  }).strict().optional(),
  heroEndpointSelections: z.array(z.object({
    request: heroEndpointSelectionRequestSchema,
    at: z.iso.datetime(),
  }).strict()).optional(),
  storyboardLocked: z.boolean().optional(),
}).strict();
export type MovieJob = z.infer<typeof jobSchema>;

export class MovieError extends Error {
  constructor(public code: string, message: string, public httpStatus = 500) {
    super(message);
    this.name = "MovieError";
  }
}

export function validatePlan(plan: MoviePlan, profile: PersonalizationProfile): MoviePlan {
  const parsed = moviePlanSchema.safeParse(plan);
  if (!parsed.success) throw new MovieError("INVALID_PLAN", parsed.error.issues.map(issue => issue.message).join(" "), 502);
  const allowed = new Set([
    ...profile.signals.filter(signal => signal.visualUseAllowed).map(signal => signal.value),
    ...[profile.customerFirstName, profile.city].filter((value): value is string => !!value),
  ]);
  const used = new Set(plan.personalizationUsed);
  plan.shots.forEach(shot => {
    if (shot.personalization.some(value => !allowed.has(value) || !used.has(value))) {
      throw new MovieError("INVALID_PLAN", "A shot used an unapproved personalization signal.");
    }
  });
  if (plan.personalizationUsed.some(value => !allowed.has(value)) || used.size !== plan.personalizationUsed.length) {
    throw new MovieError("INVALID_PLAN", "The director invented or duplicated personalization.");
  }
  return plan;
}
