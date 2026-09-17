import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { ShowroomCatalogSchema, type AcceptedStudioSnapshot, type ShowroomCatalog } from '../contracts/showroom.js';
import { ProviderFailure, responseBytes } from './http-client.js';
import { validateStudioVideo } from './studio-video.js';

export interface StudioPhoto { assetId: string; bytes: Uint8Array; mimeType: string }
export interface StudioOutput {
  bytes: Uint8Array; mimeType: 'video/mp4'; provenance: 'generated' | 'mock_fixture'; durationSeconds: number;
  productionMode: 'reviewed-storyboard' | 'movie-first'; renderMode: string;
}
export interface StudioProvider {
  catalog(signal: AbortSignal): Promise<ShowroomCatalog>;
  generate(snapshot: AcceptedStudioSnapshot, photos: readonly StudioPhoto[], signal: AbortSignal, progress: (stage: string) => void): Promise<StudioOutput>;
  cleanup(snapshotId: string): Promise<boolean>;
  recoverCleanup(): Promise<void>;
}
const id = z.uuid();
const uploadSchema = z.object({
  receipt: z.object({
    key: z.string(), fingerprint: z.string().nullable(), state: z.enum(['uploading', 'uploaded', 'cancelled']),
    assetIds: z.array(id).max(4), assetsDeleted: z.boolean(),
  }),
  assets: z.array(z.object({ id, mime: z.string(), width: z.number().nullable(), height: z.number().nullable() })).optional(),
});
const jobReceiptSchema = z.object({ receipt: z.object({
  jobId: id.nullable(), fingerprint: z.string().nullable(),
  cancelledAt: z.string().optional(), assetsDeleted: z.boolean().optional(),
}) });
const jobSchema = z.object({ job: z.object({
  id, sessionId: z.string(), status: z.string(), productionMode: z.enum(['reviewed-storyboard', 'movie-first']),
  events: z.array(z.object({ stage: z.string(), message: z.string() })),
  hero: z.object({ provider: z.string() }).nullable(),
  result: z.object({
    assetId: id, durationSeconds: z.number().positive().max(300),
    mode: z.enum(['image-motion', 'storyboard-motion', 'hybrid-video']), renderLayout: z.string().optional(),
  }).nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
}) });
const localReceiptSchema = z.object({
  sessionId: id, snapshotId: id, fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  jobKey: id, batchKey: id, cleanupRequired: z.boolean(), jobId: id.optional(),
  ownerFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
type Receipt = z.infer<typeof localReceiptSchema>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

export function createStudioProvider(options: {
  baseUrl: string; token: string; directory?: string; maxBytes?: number;
  fetch?: typeof fetch; pollMs?: number; cleanupAttempts?: number;
  validateVideo?: typeof validateStudioVideo;
}): StudioProvider {
  const base = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
      || base.username || base.password || base.search || base.hash || base.pathname !== '/' || !options.token.trim()) {
    throw new ProviderFailure('STUDIO_CONFIGURATION', 'The studio requires a loopback origin and private machine API token.');
  }
  const directory = resolve(options.directory ?? '.runtime/studio-cleanup');
  const request = options.fetch ?? fetch;
  const active = new Map<string, Promise<StudioOutput>>();
  const credentialHash = createHash('sha256').update(options.token).digest('hex');
  const ownerFingerprint = (sessionId: string) => hash(['movie-studio-owner-v1', base.origin, sessionId, credentialHash]);
  const receiptPath = (snapshotId: string) => join(directory, `${id.parse(snapshotId)}.json`);
  const readReceipt = async (snapshotId: string): Promise<Receipt | null> => {
    let receipt: Receipt;
    try { receipt = localReceiptSchema.parse(JSON.parse(await readFile(receiptPath(snapshotId), 'utf8'))); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new ProviderFailure('STUDIO_RECEIPT_INVALID', 'The durable studio receipt could not be read; inspect local state before resubmitting.');
    }
    if (receipt.cleanupRequired && receipt.ownerFingerprint !== ownerFingerprint(receipt.sessionId)) {
      throw new ProviderFailure(
        'STUDIO_CLEANUP_OWNER_MISMATCH',
        'This pending studio receipt is not bound to the configured origin and credential. Restore the original configuration, or reconcile an older unbound receipt through its original studio owner before continuing.',
        false, true,
      );
    }
    return receipt;
  };
  const writeReceipt = async (receipt: Receipt) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = receiptPath(receipt.snapshotId);
    const temporary = `${target}.${randomUUID()}.writing`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  };
  const headers = (sessionId: string) => ({
    authorization: `Bearer ${options.token}`, 'x-movie-session-id': id.parse(sessionId),
  });
  const call = async (sessionId: string, route: string, signal: AbortSignal, init: RequestInit = {}, allowMissing = false): Promise<unknown | null> => {
    let response: Response;
    try {
      response = await request(new URL(route, base), {
        ...init, headers: { ...headers(sessionId), ...init.headers }, redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
    } catch {
      signal.throwIfAborted();
      throw new ProviderFailure('STUDIO_UNREACHABLE', 'The studio request could not be reconciled.', true, init.method === 'POST');
    }
    if (allowMissing && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderFailure(response.status === 410 ? 'STUDIO_CANCELLED' : 'STUDIO_HTTP_ERROR',
        `The studio returned HTTP ${response.status}.`, response.status >= 500, init.method === 'POST' && response.status >= 500);
    }
    try { return JSON.parse(new TextDecoder().decode(await responseBytes(response, 2 * 1024 * 1024))); } catch {
      throw new ProviderFailure('STUDIO_INVALID_RESPONSE', 'The studio response could not be validated.', false, init.method === 'POST');
    }
  };
  const catalog = async (signal: AbortSignal): Promise<ShowroomCatalog> => {
    const readiness = z.object({ available: z.boolean() });
    const data = z.object({
      products: ShowroomCatalogSchema.shape.products,
      templates: z.array(z.object({ id: z.string(), name: z.string() })),
      providers: z.object({ openai: readiness, veo: readiness, openaiVideo: readiness.optional() }),
      worker: readiness, renderer: readiness,
    }).parse(await call('00000000-0000-4000-8000-000000000000', '/api/movie-config', signal));
    return ShowroomCatalogSchema.parse({
      mode: 'studio', products: data.products, templates: data.templates,
      videoProviders: [
        { id: 'google-veo', available: data.providers.openai.available && data.providers.veo.available },
        { id: 'openai-sora', available: data.providers.openai.available && !!data.providers.openaiVideo?.available },
      ],
      workerAvailable: data.worker.available && data.providers.openai.available,
      rendererAvailable: data.renderer.available,
    });
  };
  const cleanup = async (snapshotId: string): Promise<boolean> => {
    const receipt = await readReceipt(snapshotId);
    if (!receipt || !receipt.cleanupRequired) return true;
    // Cleanup has its own lifetime: revocation must not abort the cancellation request.
    const signal = AbortSignal.timeout(60_000);
    for (let attempt = 0; attempt < (options.cleanupAttempts ?? 20); attempt++) {
      const job = jobReceiptSchema.parse(await call(receipt.sessionId, `/api/movie-job-requests/${receipt.jobKey}`, signal, { method: 'DELETE' }));
      const upload = uploadSchema.parse(await call(receipt.sessionId, `/api/movie-upload-batches/${receipt.batchKey}`, signal, { method: 'DELETE' }));
      if (job.receipt.assetsDeleted && upload.receipt.assetsDeleted) {
        await writeReceipt({ ...receipt, cleanupRequired: false });
        return true;
      }
      await delay(options.pollMs ?? 500, undefined, { signal });
    }
    return false;
  };
  const generate = async (snapshot: AcceptedStudioSnapshot, photos: readonly StudioPhoto[], signal: AbortSignal, progress: (stage: string) => void): Promise<StudioOutput> => {
    const value = snapshot.input;
    const ordered = value.captureSet?.references.map(reference => {
      const photo = photos.find(photo => photo.assetId === reference.assetId);
      if (!photo) throw new ProviderFailure('STUDIO_REFERENCE_MISSING', 'An accepted original photo is no longer available.');
      return photo;
    }) ?? [];
    if (!value.consent.likeness || !value.consent.personalization || !value.consent.providerTransfer) {
      throw new ProviderFailure('STUDIO_CONSENT_REQUIRED', 'The studio requires explicitly approved likeness, personalization and provider transfer.');
    }
    const fingerprint = hash({ snapshot, photos: ordered.map(photo => ({
      id: photo.assetId, hash: createHash('sha256').update(photo.bytes).digest('hex'), mime: photo.mimeType,
    })) });
    let receipt = await readReceipt(snapshot.snapshotId);
    if (receipt && receipt.fingerprint !== fingerprint) throw new ProviderFailure('STUDIO_INPUT_CONFLICT', 'The accepted studio input cannot be changed.');
    if (receipt && !receipt.cleanupRequired) throw new ProviderFailure('STUDIO_ALREADY_SETTLED', 'This accepted movie was already settled; it cannot be submitted again.');
    receipt ??= {
      sessionId: value.sessionId, snapshotId: snapshot.snapshotId, fingerprint,
      batchKey: snapshot.snapshotId, jobKey: snapshot.snapshotId, cleanupRequired: true,
      ownerFingerprint: ownerFingerprint(value.sessionId),
    };
    await writeReceipt(receipt);
    try {
      const available = await catalog(signal);
      if (!available.workerAvailable || !available.rendererAvailable || !available.products.some(product => product.id === value.selection.productId && product.ready)
          || (value.selection.videoProvider && !available.videoProviders.some(provider => provider.id === value.selection.videoProvider && provider.available))) {
        throw new ProviderFailure('STUDIO_NOT_READY', 'The approved studio product, worker, renderer or video provider is not ready.');
      }
      let assetIds: string[] = [];
      if (value.selection.heroMode === 'LIKENESS') {
        let uploaded = await call(value.sessionId, `/api/movie-upload-batches/${receipt.batchKey}`, signal, {}, true);
        if (uploaded === null || uploadSchema.parse(uploaded).receipt.state === 'uploading') {
          const form = new FormData();
          for (const photo of ordered) form.append('photos', new Blob([Buffer.from(photo.bytes)], { type: photo.mimeType }), 'reference.jpg');
          form.append('consent', JSON.stringify({ likeness: true, personalization: true }));
          try {
            uploaded = await call(value.sessionId, '/api/movie-assets', signal, {
              method: 'POST', headers: { 'idempotency-key': receipt.batchKey }, body: form,
            });
          } catch (error) {
            signal.throwIfAborted();
            uploaded = await call(value.sessionId, `/api/movie-upload-batches/${receipt.batchKey}`, signal, {}, true);
            if (uploaded === null) throw error;
          }
        }
        const upload = uploadSchema.parse(uploaded);
        if (upload.receipt.state !== 'uploaded' || upload.receipt.assetIds.length !== ordered.length) {
          throw new ProviderFailure('STUDIO_UPLOAD_UNCERTAIN', 'The original photo batch has not settled.', false, true);
        }
        assetIds = upload.receipt.assetIds;
      }
      const selection = value.selection;
      const primaryIndex = ordered.findIndex(photo => photo.assetId === value.captureSet?.primaryAssetId);
      const submission = {
        schema_version: 1, session_id: value.sessionId, customer_reference_asset_ids: assetIds,
        primary_reference_asset_id: selection.heroMode === 'LIKENESS' ? assetIds[primaryIndex] : null,
        consent: { likeness: true, personalization: true }, product_id: selection.productId,
        personalization_profile: value.context, preferred_template: selection.templateId,
        hero_mode: selection.heroMode, production_mode: selection.productionMode,
        story_format: selection.storyFormat, enable_hero_video: selection.enableHeroVideo,
        render_layout: selection.renderLayout,
        ...(selection.movieDurationSeconds !== null ? { movie_duration_seconds: selection.movieDurationSeconds } : {}),
        ...(selection.videoProvider ? { video_provider: selection.videoProvider } : {}),
        idempotency_key: receipt.jobKey,
      };
      let reconciled = await call(value.sessionId, `/api/movie-job-requests/${receipt.jobKey}`, signal, {}, true);
      if (reconciled === null) {
        try {
          await call(value.sessionId, '/api/movie-jobs', signal, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submission) });
        } catch (error) {
          signal.throwIfAborted();
          reconciled = await call(value.sessionId, `/api/movie-job-requests/${receipt.jobKey}`, signal, {}, true);
          if (reconciled === null) throw error;
        }
        reconciled ??= await call(value.sessionId, `/api/movie-job-requests/${receipt.jobKey}`, signal);
      }
      const remote = jobReceiptSchema.parse(reconciled).receipt;
      if (!remote.jobId || remote.cancelledAt) throw new ProviderFailure('STUDIO_CANCELLED', 'The accepted studio request was cancelled.');
      if (remote.fingerprint !== hash(submission)) throw new ProviderFailure('STUDIO_INPUT_CONFLICT', 'The durable studio request fingerprint does not match the accepted input.');
      receipt = { ...receipt, jobId: remote.jobId };
      await writeReceipt(receipt);
      while (true) {
        signal.throwIfAborted();
        const job: z.infer<typeof jobSchema>['job'] = jobSchema.parse(await call(value.sessionId, `/api/movie-jobs/${remote.jobId}`, signal)).job;
        if (job.id !== remote.jobId || job.sessionId !== value.sessionId || job.productionMode !== selection.productionMode) {
          throw new ProviderFailure('STUDIO_JOB_MISMATCH', 'The studio returned a different movie than the accepted request.');
        }
        if (job.status === 'FAILED') throw new ProviderFailure('STUDIO_GENERATION_FAILED', 'The studio failed to complete the approved movie; no alternate media was substituted.');
        progress(job.status.toLowerCase());
        if (job.status === 'COMPLETED') {
          const result = job.result;
          if (!result || (selection.videoProvider && (result.mode !== 'hybrid-video'
              || job.hero?.provider !== (selection.videoProvider === 'google-veo' ? 'Google Veo' : 'OpenAI Sora')))
              || (selection.renderLayout === 'video-bookends' && (result.renderLayout !== selection.renderLayout || result.durationSeconds !== (selection.movieDurationSeconds ?? 15)))) {
            throw new ProviderFailure('STUDIO_RESULT_MISMATCH', 'The studio did not produce the approved production mode, duration or required generated video.');
          }
          let response: Response;
          try {
            response = await request(new URL(`/api/movie-assets/${result.assetId}`, base), {
              headers: headers(value.sessionId), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
            });
          } catch { signal.throwIfAborted(); throw new ProviderFailure('STUDIO_DOWNLOAD_FAILED', 'The completed studio movie could not be downloaded.'); }
          if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'video/mp4') {
            await response.body?.cancel();
            throw new ProviderFailure('STUDIO_VIDEO_INVALID', 'The completed studio asset is not an accessible MP4.');
          }
          const bytes = await responseBytes(response, options.maxBytes ?? 50 * 1024 * 1024);
          await (options.validateVideo ?? validateStudioVideo)(bytes, result.durationSeconds, signal);
          return { bytes, mimeType: 'video/mp4', provenance: 'generated', durationSeconds: result.durationSeconds,
            productionMode: job.productionMode, renderMode: result.mode };
        }
        await delay(options.pollMs ?? 500, undefined, { signal });
      }
    } finally {
      try {
        if (!await cleanup(snapshot.snapshotId)) throw new ProviderFailure('STUDIO_CLEANUP_PENDING', 'Studio cancellation is still settling.', true, true);
      } catch {
        console.error(JSON.stringify({ event: 'studio_cleanup_pending', snapshotId: snapshot.snapshotId }));
        throw new ProviderFailure('STUDIO_CLEANUP_PENDING', 'Studio deletion is not confirmed. The durable receipt remains available for cleanup; the movie is not ready.', true, true);
      }
    }
  };
  return {
    catalog, cleanup,
    generate(snapshot, photos, signal, progress) {
      const existing = active.get(snapshot.snapshotId);
      if (existing) return Promise.reject(new ProviderFailure('STUDIO_REQUEST_ACTIVE', 'This accepted movie is already running.'));
      const work = generate(snapshot, photos, signal, progress);
      active.set(snapshot.snapshotId, work);
      void work.then(() => active.delete(snapshot.snapshotId), () => active.delete(snapshot.snapshotId));
      return work;
    },
    async recoverCleanup() {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      for (const file of await readdir(directory)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
        if (!await cleanup(file.slice(0, -5))) {
          throw new ProviderFailure('STUDIO_CLEANUP_PENDING', 'A previous studio session still requires cleanup; startup will not accept new work.');
        }
      }
    },
  };
}
