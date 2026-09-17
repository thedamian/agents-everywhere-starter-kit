import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { frameDecisionRequestSchema, heroEndpointSelectionRequestSchema, jobSchema, productionModeOf, retryRequestSchema, MovieError, type FrameDecisionRequest, type HeroEndpointSelectionRequest, type JobRequest, type MovieJob, type ProductReference, type RetryRequest, type StoryboardFrame } from "../domain";
import type { Readiness } from "../domain/http";
import { atomicWrite, isMissing, processAlive, readJson, withDiskLock } from "../server/files";
import type { LocalMediaRepository } from "../server/media";
import { retrySummary, validateSavedPlan } from "./retry";
import { assertJobNotCancelled, jobReceiptSchema, referencedAssets, type JobReceipt } from "./lifecycle";
import { assertVeoRecoverable } from "../domain/veo-failure";
import { hasUncertainVideoSegment, savedVideoSegments } from "../domain/video-sequence-state";
import { isFrameApproved } from "../domain/storyboard-state";

export const WORKER_HEARTBEAT_MS = 3_000;
export const WORKER_STALE_MS = 15_000;
export const terminal = (job: MovieJob) => job.status === "COMPLETED" || job.status === "FAILED";
type WorkerLease = { token: string; pid: number; heartbeatAt: string };

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export function requestFingerprint(request: JobRequest): string {
  return createHash("sha256").update(canonical(request)).digest("hex");
}

export class JobStore {
  readonly directory: string;
  constructor(dataDir: string) { this.directory = path.join(path.resolve(dataDir), "jobs"); }
  private manifest(id: string): string {
    if (!z.uuid().safeParse(id).success) throw new MovieError("JOB_NOT_FOUND", "Job not found.", 404);
    return path.join(this.directory, "records", `${id}.json`);
  }
  private queue(id: string, status: "pending" | "claimed"): string { return path.join(this.directory, status, `${id}.json`); }
  private idempotencyPath(ownerId: string, key: string): string {
    const hash = createHash("sha256").update(JSON.stringify([ownerId, key])).digest("hex");
    return path.join(this.directory, "idempotency", `${hash}.json`);
  }
  private get leasePath(): string { return path.join(this.directory, "worker.json"); }
  private transaction<T>(action: () => Promise<T>): Promise<T> { return withDiskLock(this.directory, action); }
  private async write(job: MovieJob): Promise<void> {
    jobSchema.parse(job);
    await atomicWrite(this.manifest(job.id), JSON.stringify(job));
  }

  async get(id: string): Promise<MovieJob> {
    try { return jobSchema.parse(await readJson(this.manifest(id))); } catch (error) {
      if (error instanceof MovieError) throw error;
      if (isMissing(error)) throw new MovieError("JOB_NOT_FOUND", "Job not found.", 404);
      throw new MovieError("INVALID_JOB_RECORD", "The saved job record is invalid.", 500);
    }
  }
  async getOwned(id: string, ownerId: string): Promise<MovieJob> {
    const job = await this.get(id);
    if (job.ownerId !== ownerId) throw new MovieError("JOB_NOT_FOUND", "Job not found.", 404);
    return job;
  }
  async list(): Promise<MovieJob[]> {
    const directory = path.join(this.directory, "records");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const names = (await readdir(directory)).filter(name => /^[a-f0-9-]+\.json$/.test(name));
    return Promise.all(names.map(name => this.get(name.slice(0, -5))));
  }

  async findIdempotent(ownerId: string, request: JobRequest): Promise<MovieJob | null> {
    const entry = await this.receipt(ownerId, request.idempotency_key);
    if (entry) {
      if (entry.cancelledAt) throw new MovieError("JOB_CANCELLED", "This movie request was cancelled and cannot be restarted.", 410);
      if (entry.fingerprint !== requestFingerprint(request)) {
        throw new MovieError("IDEMPOTENCY_CONFLICT", "This idempotency key was already used for a different request.", 409);
      }
      try { return await this.getOwned(entry.jobId!, ownerId); } catch (error) {
        if (error instanceof MovieError && error.code === "JOB_NOT_FOUND") {
          throw new MovieError("JOB_DELETED", "This request's job was deleted. Use a new idempotency key only to intentionally create another movie.", 410);
        }
        throw error;
      }
    }
    return null;
  }

  async receipt(ownerId: string, key: string): Promise<JobReceipt | null> {
    const index = await readJson(this.idempotencyPath(ownerId, key)).catch(error => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (index) return jobReceiptSchema.parse(index);
    const existing = (await this.list()).find(job => job.ownerId === ownerId && job.request.idempotency_key === key);
    return existing ? { jobId: existing.id, fingerprint: requestFingerprint(existing.request) } : null;
  }

  async cancelOwnedRequest(ownerId: string, key: string, media: LocalMediaRepository): Promise<JobReceipt> {
    return this.transaction(async () => {
      const previous = await this.receipt(ownerId, key);
      const receipt: JobReceipt = {
        ...previous, jobId: previous?.jobId ?? null, fingerprint: previous?.fingerprint ?? null,
        cancelledAt: previous?.cancelledAt ?? new Date().toISOString(), assetsDeleted: previous?.assetsDeleted ?? false,
      };
      // Commit the fence before touching the manifest or assets; a late POST can never revive this key.
      await atomicWrite(this.idempotencyPath(ownerId, key), JSON.stringify(receipt));
      const job = receipt.jobId ? await this.getOwned(receipt.jobId, ownerId).catch(error => {
        if (error instanceof MovieError && error.code === "JOB_NOT_FOUND") return null;
        throw error;
      }) : null;
      if (job) {
        if (job.error?.code !== "JOB_CANCELLED") {
          job.error = { code: "JOB_CANCELLED", message: "The owner cancelled this movie. Cleanup waits for active work to settle.", stage: job.status };
          job.status = "FAILED";
          job.updatedAt = receipt.cancelledAt!;
          job.events.push({ at: job.updatedAt, stage: "FAILED", message: job.error.message, provider: null, shotId: null });
          await this.write(job);
        }
        await rm(this.queue(job.id, "pending"), { force: true });
        if (await this.isClaimed(job.id)) return receipt;
        receipt.assetsDeleted = await this.cleanupJob(job, media);
      } else {
        receipt.assetsDeleted = true;
      }
      await atomicWrite(this.idempotencyPath(ownerId, key), JSON.stringify(receipt));
      return receipt;
    });
  }

  private async isClaimed(id: string): Promise<boolean> {
    return !!await stat(this.queue(id, "claimed")).catch(error => {
      if (isMissing(error)) return null;
      throw error;
    });
  }

  async isCancellationRequested(id: string): Promise<boolean> {
    const job = await this.get(id);
    return !!(await this.receipt(job.ownerId, job.request.idempotency_key))?.cancelledAt;
  }

  async create(ownerId: string, request: JobRequest, product: ProductReference, verifyReferences?: () => Promise<void>): Promise<MovieJob> {
    return this.transaction(async () => {
      const existing = await this.findIdempotent(ownerId, request);
      if (existing) return existing;
      await verifyReferences?.();
      const at = new Date().toISOString();
      const job = jobSchema.parse({
        id: randomUUID(), ownerId, request, product, status: "RECEIVED", createdAt: at, updatedAt: at,
        events: [{ at, stage: "RECEIVED", message: "Queued for the local movie worker.", provider: null, shotId: null }],
        warnings: [], error: null, character: null, plan: null, frames: [], hero: null, result: null, operations: [],
      });
      await this.write(job);
      await atomicWrite(this.idempotencyPath(ownerId, request.idempotency_key), JSON.stringify({
        jobId: job.id, fingerprint: requestFingerprint(request),
      }));
      await atomicWrite(this.queue(job.id, "pending"), JSON.stringify({ jobId: job.id }));
      return job;
    });
  }

  async findRetry(id: string, ownerId: string, request: RetryRequest): Promise<{ job: MovieJob; attempt: number } | null> {
    const job = await this.getOwned(id, ownerId);
    assertJobNotCancelled(job);
    if (await this.isCancellationRequested(id)) throw new MovieError("JOB_CANCELLED", "This movie was cancelled.", 410);
    const index = job.retries?.findIndex(retry => retry.idempotencyKey === request.idempotency_key) ?? -1;
    if (index < 0) return null;
    if (job.retries![index].expectedAttempt !== request.expected_attempt ||
      job.retries![index].productionMode !== request.production_mode ||
      job.retries![index].videoRecoveryAction !== request.video_recovery_action) {
      throw new MovieError("IDEMPOTENCY_CONFLICT", "This retry key was used with a different attempt. Reuse the original retry request.", 409);
    }
    return { job, attempt: index + 1 };
  }

  async retryOwned(
    id: string, ownerId: string, input: RetryRequest, verify: (job: MovieJob) => Promise<void>,
  ): Promise<{ job: MovieJob; attempt: number }> {
    const request = retryRequestSchema.parse(input);
    return this.transaction(async () => {
      const previous = await this.findRetry(id, ownerId, request);
      if (previous) return previous;
      const job = await this.getOwned(id, ownerId);
      assertJobNotCancelled(job);
      assertVeoRecoverable(job.error?.code);
      if (request.expected_attempt !== (job.retries?.length ?? 0)) {
        throw new MovieError("STALE_RETRY", "Another retry was already accepted. Refresh this movie before authorizing another attempt.", 409);
      }
      if (!retrySummary(job).eligible) {
        throw new MovieError("RETRY_UNAVAILABLE", "Only a failed movie with a saved plan and references can be retried. Active and completed movies cannot be restarted.", 409);
      }
      const claimed = await stat(this.queue(id, "claimed")).catch(error => {
        if (isMissing(error)) return null;
        throw error;
      });
      if (claimed) throw new MovieError("JOB_ACTIVE", "The previous worker is still finishing. Wait briefly and retry the same request.", 409);
      validateSavedPlan(job);
      const recovery = retrySummary(job).videoRecovery;
      if (recovery?.veoSubmissionUncertain
          && request.video_recovery_action !== "replace-rejected-clip") {
        throw new MovieError("VIDEO_SUBMISSION_UNCERTAIN", "The Veo submission may have been accepted without a recoverable operation ID. Explicitly authorize a replacement to make another paid request.", 409);
      }
      if (job.error?.code === "VEO_CONTINUITY_REJECTED" && !request.video_recovery_action) {
        throw new MovieError("VIDEO_RECOVERY_REQUIRED", "This retained clip cannot improve through ordinary retry. Explicitly authorize a replacement clip.", 409);
      }
      if (request.video_recovery_action === "replace-rejected-clip") {
        if (!recovery?.replacementAvailable) {
          throw new MovieError("VIDEO_REPLACEMENT_LIMIT", "The replacement limit has been reached. An operator may explicitly finish with image motion instead.", 409);
        }
        const segments = savedVideoSegments(job);
        const rejected = segments.filter(segment => !segment.clip && !!segment.operationId);
        const uncertain = segments.filter(segment => segment.submitted && !segment.clip && !segment.operationId);
        if (rejected.length + uncertain.length !== 1) {
          throw new MovieError("VIDEO_RECOVERY_UNAVAILABLE", "Exactly one continuity-rejected retained clip is required for replacement.", 409);
        }
        const target = rejected[0] ?? uncertain[0];
        job.videoRecoveries = [...(job.videoRecoveries ?? []), {
          action: "replace-rejected-clip", at: new Date().toISOString(),
          segmentIndex: target.index,
          ...(target.operationId ? { supersededOperationId: target.operationId } : {}),
        }];
        if (segments.length > 1) {
          job.videoSegments = segments.map(segment => segment.index === target.index
            ? { index: segment.index, submitted: false, ...(segment.startFrameAssetId ? { startFrameAssetId: segment.startFrameAssetId } : {}) }
            : segment);
        } else {
          job.heroAttempted = false;
        }
      }
      if (request.video_recovery_action === "use-image-motion") {
        if (!recovery?.imageMotionAvailable) {
          throw new MovieError("VIDEO_FALLBACK_UNAVAILABLE", "Image-motion fallback is available only after the bounded replacement attempts are exhausted.", 409);
        }
        job.videoRecoveries = [...(job.videoRecoveries ?? []), {
          action: "use-image-motion", at: new Date().toISOString(),
        }];
        job.productionMode = "movie-first";
        job.result = null;
      }
      if (request.production_mode === "movie-first" && job.request.video_provider) {
        throw new MovieError("ANIMATION_REQUIRED", "A generated-video movie cannot silently switch to animated stills. Create a separate image-only take explicitly.", 409);
      }
      if (request.production_mode) job.productionMode = request.production_mode;
      await verify(job);
      return this.requeue(job, request);
    });
  }

  private async requeue(job: MovieJob, request: RetryRequest): Promise<{ job: MovieJob; attempt: number }> {
    assertVeoRecoverable(job.error?.code);
    const at = new Date().toISOString();
    job.retries = [...(job.retries ?? []), {
      idempotencyKey: request.idempotency_key, expectedAttempt: request.expected_attempt,
      requestedAt: at, previousError: job.error,
      ...(request.production_mode ? { productionMode: request.production_mode } : {}),
      ...(request.video_recovery_action ? { videoRecoveryAction: request.video_recovery_action } : {}),
    }];
    job.status = "RECEIVED";
    job.updatedAt = at;
    job.error = null;
    job.storyboardLocked = false;
    if (productionModeOf(job) !== "movie-first") job.result = null;
    job.events.push({
      at, stage: "RECEIVED", provider: null, shotId: null,
      message: request.video_recovery_action === "use-image-motion"
        ? "Operator-approved image-motion fallback requested. Keeping the plan and usable visuals; no replacement video will be submitted."
        : request.video_recovery_action === "replace-rejected-clip"
        ? "Operator-approved replacement requested for the rejected animation segment. Approved clips and storyboard work are retained."
        : productionModeOf(job) === "movie-first"
        ? "Movie-first production requested. Keeping the plan and usable visuals; storyboard images will be extracted after encoding."
        : "Explicit retry accepted. Keeping the director plan and approved shots; only unfinished work will run.",
    });
    await this.write(job);
    await atomicWrite(this.queue(job.id, "pending"), JSON.stringify({ jobId: job.id }));
    return { job, attempt: job.retries.length };
  }

  async decideFrame(
    id: string, ownerId: string, assetId: string, input: FrameDecisionRequest,
    verifyFrame: (job: MovieJob, frame: StoryboardFrame) => Promise<void>,
    verifyResume: (job: MovieJob) => Promise<void>,
  ): Promise<MovieJob> {
    const request = frameDecisionRequestSchema.parse(input);
    return this.transaction(async () => {
      const job = await this.getOwned(id, ownerId);
      assertJobNotCancelled(job);
      assertVeoRecoverable(job.error?.code);
      if (await this.isCancellationRequested(id)) throw new MovieError("JOB_CANCELLED", "This movie was cancelled.", 410);
      const previous = job.designerDecisions?.find(item => item.request.idempotency_key === request.idempotency_key);
      if (previous) {
        if (previous.assetId !== assetId || canonical(previous.request) !== canonical(request)) {
          throw new MovieError("IDEMPOTENCY_CONFLICT", "This designer-decision key was used for different input.", 409);
        }
        return job;
      }
      if (request.expected_revision !== (job.designerDecisions?.length ?? 0) ||
          request.expected_attempt !== (job.retries?.length ?? 0)) {
        throw new MovieError("STALE_REVIEW", "The movie or designer decisions changed. Refresh before choosing a frame.", 409);
      }
      const reviewing = ["STORYBOARDING", "VALIDATING"].includes(job.status) && !job.storyboardLocked;
      if ((!reviewing && job.status !== "FAILED") || job.result || !job.plan || !job.character) {
        throw new MovieError("REVIEW_LOCKED", "Designer decisions are available during storyboard review or after a failed attempt, not once video rendering is locked.", 409);
      }
      const frame = job.frames.find(item => item.assetId === assetId);
      if (!frame || frame.source === "extracted" || !job.plan.shots.some(shot => shot.id === frame.shotId)) {
        throw new MovieError("FRAME_NOT_FOUND", "This movie does not contain that generated storyboard frame.", 404);
      }
      if (frame.shotId === job.plan.heroShotId && (job.hero || job.heroAttempted)) {
        throw new MovieError("HERO_LOCKED", "The hero video has already been attempted from its reference. Create a new take to change that reference.", 409);
      }
      await verifyFrame(job, frame);
      const at = new Date().toISOString();
      for (const candidate of job.frames.filter(item => item.shotId === frame.shotId)) {
        candidate.designerDecision = {
          action: candidate.assetId === assetId && request.action === "keep" ? "keep" : "regenerate",
          note: request.note, at,
        };
      }
      job.designerDecisions = [...(job.designerDecisions ?? []), { assetId, request, at }];
      job.updatedAt = at;
      job.events.push({
        at, stage: job.status, provider: "Designer", shotId: frame.shotId,
        message: request.action === "keep" ? "Designer kept this image. The AI verdict is retained; use the selected image and continue." : "Designer requested a new image for this shot.",
      });
      if (request.resume && job.status === "FAILED") {
        const claimed = await stat(this.queue(id, "claimed")).catch(error => { if (isMissing(error)) return null; throw error; });
        if (claimed) throw new MovieError("JOB_ACTIVE", "The previous attempt is finishing. Wait briefly before continuing.", 409);
        await verifyResume(job);
        const key = `designer-${createHash("sha256").update(request.idempotency_key).digest("hex")}`;
        return (await this.requeue(job, { idempotency_key: key, expected_attempt: request.expected_attempt })).job;
      }
      await this.write(job);
      return job;
    });
  }

  async selectHeroEndpoint(
    id: string, ownerId: string, input: HeroEndpointSelectionRequest,
    verifyFrame: (job: MovieJob, frame: StoryboardFrame) => Promise<void>,
  ): Promise<MovieJob> {
    const request = heroEndpointSelectionRequestSchema.parse(input);
    return this.transaction(async () => {
      const job = await this.getOwned(id, ownerId);
      assertJobNotCancelled(job);
      if (await this.isCancellationRequested(id)) throw new MovieError("JOB_CANCELLED", "This movie was cancelled.", 410);
      const previous = job.heroEndpointSelections?.find(item => item.request.idempotency_key === request.idempotency_key);
      if (previous) {
        if (canonical(previous.request) !== canonical(request)) {
          throw new MovieError("IDEMPOTENCY_CONFLICT", "This hero-endpoint key was used for different input.", 409);
        }
        return job;
      }
      if (request.expected_revision !== (job.heroEndpointSelections?.length ?? 0) ||
          request.expected_attempt !== (job.retries?.length ?? 0)) {
        throw new MovieError("STALE_HERO_ENDPOINT", "The movie or hero endpoints changed. Refresh before choosing this frame.", 409);
      }
      if (job.request.video_provider !== "google-veo" || !job.request.enable_hero_video || !job.plan || !job.character) {
        throw new MovieError("HERO_ENDPOINT_UNAVAILABLE", "Manual hero endpoints are available only for a planned Google Veo movie.", 409);
      }
      if (job.hero || job.heroAttempted || job.operations.some(operation => operation.provider === "Google Veo")) {
        throw new MovieError("HERO_LOCKED", "Veo has already been attempted for this take. Create a new take to change its hero endpoints.", 409);
      }
      if (job.status !== "FAILED" || job.error?.code !== "HERO_ENDPOINT_SELECTION_REQUIRED") {
        throw new MovieError("HERO_ENDPOINT_UNAVAILABLE", "Wait for storyboard generation to pause before choosing hero endpoints.", 409);
      }
      const frame = job.frames.find(item => item.assetId === request.asset_id);
      if (!frame || frame.source === "extracted" || !job.plan.shots.some(shot => shot.id === frame.shotId)) {
        throw new MovieError("FRAME_NOT_FOUND", "This movie does not contain that storyboard frame.", 404);
      }
      if (!isFrameApproved(frame)) {
        throw new MovieError("FRAME_NOT_APPROVED", "Choose an approved storyboard image for the Veo endpoint.", 409);
      }
      await verifyFrame(job, frame);
      const otherAssetId = request.role === "start" ? job.heroEndpoints?.endAssetId : job.heroEndpoints?.startAssetId;
      if (otherAssetId === request.asset_id) {
        throw new MovieError("HERO_ENDPOINTS_IDENTICAL", "Choose two different storyboard images for the hero start and end.", 409);
      }
      const at = new Date().toISOString();
      job.heroEndpoints = {
        ...job.heroEndpoints,
        ...(request.role === "start" ? { startAssetId: request.asset_id } : { endAssetId: request.asset_id }),
      };
      job.heroEndpointSelections = [...(job.heroEndpointSelections ?? []), { request, at }];
      job.updatedAt = at;
      job.events.push({
        at, stage: job.status, provider: "Designer", shotId: frame.shotId,
        message: `Designer selected ${frame.shotId} as the Veo hero ${request.role} frame.`,
      });
      await this.write(job);
      return job;
    });
  }

  async update(id: string, mutate: (job: MovieJob) => void): Promise<MovieJob> {
    return this.transaction(async () => {
      const job = await this.get(id);
      if ((await this.receipt(job.ownerId, job.request.idempotency_key))?.cancelledAt) {
        throw new MovieError("JOB_CANCELLED", "This movie was cancelled.", 410);
      }
      mutate(job);
      job.updatedAt = new Date().toISOString();
      await this.write(job);
      return job;
    });
  }

  private async lease(): Promise<WorkerLease | null> {
    try {
      return z.object({ token: z.uuid(), pid: z.number().int().positive(), heartbeatAt: z.iso.datetime() }).parse(await readJson(this.leasePath));
    } catch (error) {
      if (isMissing(error)) return null;
      throw new MovieError("WORKER_LOCK_INVALID", "The local worker lock is invalid; inspect the private job store before restarting.", 503);
    }
  }

  async workerReadiness(): Promise<Readiness> {
    const lease = await this.lease().catch(() => null);
    const available = !!lease && processAlive(lease.pid) && Date.now() - Date.parse(lease.heartbeatAt) < WORKER_STALE_MS;
    return { available, message: available ? "Local worker is running." : "Start npm run worker in a separate terminal before creating a movie." };
  }

  async acquireWorker(): Promise<string> {
    return this.transaction(async () => {
      const existing = await this.lease();
      if (existing && processAlive(existing.pid)) {
        throw new MovieError("WORKER_ALREADY_RUNNING", "Another local movie worker owns the queue.", 409);
      }
      const token = randomUUID();
      await atomicWrite(this.leasePath, JSON.stringify({ token, pid: process.pid, heartbeatAt: new Date().toISOString() }));
      return token;
    });
  }

  private async requireLease(token: string): Promise<WorkerLease> {
    const lease = await this.lease();
    if (!lease || lease.token !== token || lease.pid !== process.pid) throw new MovieError("WORKER_LOCK_LOST", "The worker no longer owns the queue.", 409);
    return lease;
  }
  async heartbeat(token: string): Promise<void> {
    await this.transaction(async () => {
      const lease = await this.requireLease(token);
      await atomicWrite(this.leasePath, JSON.stringify({ ...lease, heartbeatAt: new Date().toISOString() }));
    });
  }
  async releaseWorker(token: string): Promise<void> {
    await this.transaction(async () => {
      const lease = await this.lease();
      if (lease?.token === token && lease.pid === process.pid) await rm(this.leasePath, { force: true });
    });
  }

  async recoverInterrupted(token: string): Promise<void> {
    await this.transaction(async () => {
      await this.requireLease(token);
      const claimedDirectory = path.join(this.directory, "claimed");
      await mkdir(claimedDirectory, { recursive: true, mode: 0o700 });
      const claimed = new Set((await readdir(claimedDirectory)).filter(file => file.endsWith(".json")).map(file => file.slice(0, -5)));
      for (const job of await this.list()) {
        if ((await this.receipt(job.ownerId, job.request.idempotency_key))?.cancelledAt) {
          job.error = { code: "JOB_CANCELLED", message: "The owner cancelled this movie.", stage: job.status };
          job.status = "FAILED";
          await this.write(job);
        }
        if (!terminal(job) && (claimed.has(job.id) || job.status !== "RECEIVED")) {
          const stage = job.status;
          job.status = "FAILED";
          job.updatedAt = new Date().toISOString();
          job.error = { code: "WORKER_INTERRUPTED", message: "The worker stopped during this job. Saved artifacts were retained; paid operations will not be repeated automatically.", stage };
          job.events.push({ at: job.updatedAt, stage: "FAILED", message: job.error.message, provider: null, shotId: null });
          await this.write(job);
        }
        if (terminal(job)) {
          await rm(this.queue(job.id, "pending"), { force: true });
          await rm(this.queue(job.id, "claimed"), { force: true });
        } else if (job.status === "RECEIVED") {
          await atomicWrite(this.queue(job.id, "pending"), JSON.stringify({ jobId: job.id }));
        }
      }
    });
  }

  async claim(token: string): Promise<MovieJob | null> {
    return this.transaction(async () => {
      await this.requireLease(token);
      const claimedDirectory = path.join(this.directory, "claimed");
      await mkdir(claimedDirectory, { recursive: true, mode: 0o700 });
      if ((await readdir(claimedDirectory)).some(file => file.endsWith(".json"))) return null;
      const jobs = (await this.list()).filter(job => job.status === "RECEIVED").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const job of jobs) {
        if ((await this.receipt(job.ownerId, job.request.idempotency_key))?.cancelledAt) continue;
        try { await rename(this.queue(job.id, "pending"), this.queue(job.id, "claimed")); } catch (error) {
          if (!isMissing(error)) throw error;
          // A crash after the manifest commit but before queue publication must not strand an unpaid job.
          await atomicWrite(this.queue(job.id, "pending"), JSON.stringify({ jobId: job.id }));
          await rename(this.queue(job.id, "pending"), this.queue(job.id, "claimed"));
        }
        return job;
      }
      return null;
    });
  }

  async finishClaim(id: string, token: string): Promise<void> {
    await this.transaction(async () => {
      await this.requireLease(token);
      const job = await this.get(id).catch(error => {
        if (error instanceof MovieError && error.code === "JOB_NOT_FOUND") return null;
        throw error;
      });
      if (job && !terminal(job)) throw new MovieError("JOB_NOT_TERMINAL", "Cannot release an unfinished job claim.", 409);
      await rm(this.queue(id, "claimed"), { force: true });
    });
  }

  async deleteOwned(id: string, ownerId: string, media: LocalMediaRepository): Promise<void> {
    await this.transaction(async () => {
      const job = await this.getOwned(id, ownerId);
      if (!terminal(job)) throw new MovieError("JOB_ACTIVE", "Only completed or failed jobs can be deleted.", 409);
      if (await this.isClaimed(id)) throw new MovieError("JOB_ACTIVE", "The worker is still settling this movie.", 409);
      const receipt = await this.receipt(ownerId, job.request.idempotency_key);
      await atomicWrite(this.idempotencyPath(ownerId, job.request.idempotency_key), JSON.stringify({
        ...receipt, jobId: job.id, fingerprint: requestFingerprint(job.request),
      }));
      await this.cleanupJob(job, media, true);
    });
  }

  private async cleanupJob(job: MovieJob, media: LocalMediaRepository, legacyDelete = false): Promise<boolean> {
    const referenced = new Set<string>();
    for (const other of (await this.list()).filter(other => other.id !== job.id)) {
      if (other.error?.code !== "JOB_CANCELLED" || await this.isClaimed(other.id)) {
        for (const id of referencedAssets(other)) referenced.add(id);
      }
    }
    let deleted = true;
    for (const asset of await media.listAssets()) {
      if (asset.ownerId !== job.ownerId || !(asset.jobId === job.id || job.request.customer_reference_asset_ids.includes(asset.id))) continue;
      if (referenced.has(asset.id)) deleted = false;
      else await media.deleteOwned(asset.id, job.ownerId);
    }
    if (deleted || legacyDelete) {
      await rm(this.queue(job.id, "pending"), { force: true });
      await rm(this.manifest(job.id), { force: true });
    }
    return deleted;
  }
}
