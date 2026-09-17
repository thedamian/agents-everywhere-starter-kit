import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  AdBriefSchema, CreateAdBriefInputSchema, DEMO_PRODUCT, EnrichProfileInputSchema,
  GetMediaStatusInputSchema, IdentifyCustomerInputSchema, ProfileResultSchema,
  ScheduleFollowupInputSchema, SessionEventSchema, StartMediaJobInputSchema,
  type AdBrief, type ConsentRecord, type CustomerContext, type CustomerProfile,
  type JsonValue, type MediaJob, type OutputEvent, type SessionSnapshot, type SessionState,
} from '../contracts/index.js';
import type { BriefProvider, MediaInput, MediaOutput, MediaProvider, ProfileProvider } from '../providers/interfaces.js';
import { createMockBriefProvider, createMockProfileProvider, isMockProfileProvider } from '../providers/mock.js';
import { ProviderFailure } from '../providers/http-client.js';
import { isPrerecordedDemoProvider } from '../providers/demo-media.js';
import { SHOWROOM_SESSION_TTL_MS } from '../config.js';
import { ApiError } from './errors.js';
import { ShowroomService, type ShowroomCalendar, type ShowroomMotion } from './showroom.js';
import type { StudioProvider } from '../providers/studio.js';

export { ApiError } from './errors.js';

const MAX_EVENTS = 64;
const MAX_EVENT_RECEIPTS = 256;
const MAX_JOBS = 32;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const STAGES = ['queued', 'accepted', 'preparing', 'generating', 'rendering', 'encoding', 'finalizing', 'complete'];
const terminal = (job: MediaJob) => !['queued', 'running'].includes(job.status);
const copy = <T>(value: T): T => structuredClone(value);
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, 'INVALID_INPUT', 'Input does not match the versioned contract.');
  return result.data;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

interface Asset {
  bytes: Uint8Array;
  mimeType: string;
  provenance: string;
}
interface JobRecord {
  job: MediaJob;
  idempotencyKey: string;
  fingerprint: string;
  brief?: AdBrief;
  image: Asset;
  controller: AbortController;
}
interface Session {
  id: string;
  tokenHash: Uint8Array;
  state: SessionState;
  revision: number;
  expiresAt: number;
  detected: boolean;
  consent?: ConsentRecord;
  customer?: CustomerProfile;
  context?: CustomerContext;
  brief?: AdBrief;
  imageAssetId?: string;
  events: OutputEvent[];
  receipts: Map<string, { fingerprint: string; revision: number }>;
  jobs: Map<string, JobRecord>;
  keys: Map<string, string>;
  assets: Map<string, Asset>;
  operation?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  showroomActive?: boolean;
}

export interface OrchestratorOptions {
  mediaProvider: MediaProvider;
  briefProvider?: BriefProvider;
  profileProvider?: ProfileProvider;
  now?: () => number;
  sessionTtlMs?: number;
  jobTimeoutMs?: number;
  maxSessions?: number;
  maxQueuedJobs?: number;
  fallbackMediaProvider?: MediaProvider;
  allowFallbacks?: boolean;
  studioProvider?: StudioProvider;
  showroomMode?: 'studio' | 'fixture';
  calendar?: ShowroomCalendar;
  motion?: ShowroomMotion;
}

export class Orchestrator {
  readonly serverInstanceId = randomUUID();
  readonly showroom?: ShowroomService;
  private readonly sessions = new Map<string, Session>();
  private readonly expired = new Map<string, true>();
  private readonly queue: { session: Session; record: JobRecord }[] = [];
  private running?: JobRecord;
  private disposed = false;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly timeout: number;
  private readonly maxSessions: number;
  private readonly maxQueued: number;
  private readonly briefProvider: BriefProvider;
  private readonly profileProvider: ProfileProvider;
  private readonly endListeners = new Set<(sessionId: string) => void>();

  onSessionEnded(listener: (sessionId: string) => void): () => void {
    this.endListeners.add(listener);
    return () => { this.endListeners.delete(listener); };
  }

  constructor(private readonly options: OrchestratorOptions) {
    this.now = options.now ?? Date.now;
    this.ttl = options.sessionTtlMs ?? SHOWROOM_SESSION_TTL_MS;
    this.timeout = options.jobTimeoutMs ?? 60_000;
    this.maxSessions = options.maxSessions ?? 100;
    this.maxQueued = options.maxQueuedJobs ?? 8;
    for (const value of [this.ttl, this.timeout, this.maxSessions]) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
        throw new ApiError(500, 'INVALID_CONFIGURATION', 'Limits must be positive bounded integers.');
      }
    }
    if (!Number.isSafeInteger(this.maxQueued) || this.maxQueued < 0 || this.maxQueued > 10_000) {
      throw new ApiError(500, 'INVALID_CONFIGURATION', 'The queue limit is invalid.');
    }
    this.briefProvider = options.briefProvider ?? createMockBriefProvider();
    this.profileProvider = options.profileProvider ?? createMockProfileProvider();
    if (options.studioProvider) this.showroom = new ShowroomService({
      provider: options.studioProvider, mode: options.showroomMode, calendar: options.calendar,
      motion: options.motion, now: this.now, jobTimeoutMs: this.timeout,
      authority: {
        session: id => {
          const session = this.get(id);
          session.showroomActive = true;
          return { revision: session.revision, expiresAt: session.expiresAt, state: session.state, serverInstanceId: this.serverInstanceId };
        },
        transition: (id, state, event) => {
          const session = this.get(id); session.state = state; this.emit(session, event, {});
        },
        saveAsset: (id, asset) => {
          const session = this.get(id); this.mutable(session);
          const assetId = randomUUID(); session.assets.set(assetId, copy(asset)); return assetId;
        },
        deleteAsset: (id, assetId) => { this.get(id).assets.delete(assetId); },
        end: id => { this.cancel(this.get(id), 'cancelled'); },
      },
    });
  }

  createSession(): { sessionId: string; sessionToken: string; serverInstanceId: string } {
    this.ensureOpen();
    this.sweep();
    if (this.sessions.size >= this.maxSessions) {
      throw new ApiError(429, 'SESSION_LIMIT', 'Session capacity reached. Try again after a session ends.');
    }
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const session: Session = {
      id, tokenHash: Buffer.from(digest(token), 'hex'), state: 'awaiting_consent',
      revision: 0, expiresAt: this.now() + this.ttl, detected: false,
      events: [], receipts: new Map(), jobs: new Map(), keys: new Map(), assets: new Map(),
    };
    this.sessions.set(id, session);
    this.emit(session, 'session_created', {});
    this.armExpiration(session);
    return { sessionId: id, sessionToken: token, serverInstanceId: this.serverInstanceId };
  }

  authorize(sessionId: string, token: string): boolean {
    const session = this.get(sessionId);
    if (typeof token !== 'string' || token.length > 256) return false;
    return timingSafeEqual(session.tokenHash, Buffer.from(digest(token), 'hex'));
  }

  snapshot(sessionId: string, afterRevision?: number): SessionSnapshot {
    const session = this.get(sessionId);
    if (afterRevision !== undefined && (!Number.isSafeInteger(afterRevision) || afterRevision < 0)) {
      throw new ApiError(400, 'INVALID_CURSOR', 'The revision cursor must be a nonnegative integer.');
    }
    const reset = afterRevision !== undefined
      && (afterRevision > session.revision || afterRevision < (session.events[0]?.revision ?? 1) - 1);
    return copy({
      sessionId: session.id, serverInstanceId: this.serverInstanceId,
      state: session.state, revision: session.revision, expiresAt: session.expiresAt,
      ...(session.consent ? { consent: session.consent } : {}),
      ...(session.customer ? { customer: session.customer } : {}),
      ...(session.context ? { context: session.context } : {}),
      ...(session.brief ? { brief: session.brief } : {}),
      jobs: [...session.jobs.values()].map(({ job }) => job),
      events: session.events.filter((event) => reset || afterRevision === undefined || event.revision > afterRevision),
      ...(reset ? { resetRequired: true } : {}),
    });
  }

  event(sessionId: string, input: unknown): SessionSnapshot {
    const session = this.get(sessionId);
    const event = parse(SessionEventSchema, input);
    if (session.showroomActive && event.type !== 'session_cancelled') {
      throw new ApiError(409, 'SHOWROOM_ACTION_REQUIRED', 'Use the authoritative showroom actions for this session.');
    }
    const fingerprint = digest(canonical(input));
    const prior = session.receipts.get(event.eventId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new ApiError(409, 'EVENT_CONFLICT', 'This event ID was already used with different input.');
      }
      return { ...this.snapshot(sessionId), acknowledgement: { eventId: event.eventId, revision: prior.revision } };
    }
    this.mutable(session);
    const ending = event.type === 'session_cancelled' || (event.type === 'consent_recorded' && (
      !event.payload.personalization
      || (session.consent?.capture && !event.payload.capture)
      || (session.consent?.enrichment && !event.payload.enrichment)
    ));
    if (session.receipts.size >= MAX_EVENT_RECEIPTS && !ending) {
      throw new ApiError(429, 'EVENT_LIMIT', 'The session event limit was reached. Start a new session.');
    }
    switch (event.type) {
      case 'customer_detected':
        this.state(session, ['awaiting_consent']);
        if (session.detected) throw new ApiError(409, 'INVALID_STATE', 'Customer presence is already recorded.');
        session.detected = true;
        break;
      case 'consent_recorded': {
        const old = session.consent;
        const revoked = old && (
          (old.personalization && !event.payload.personalization)
          || (old.capture && !event.payload.capture)
          || (old.enrichment && !event.payload.enrichment)
        );
        if (!event.payload.personalization || revoked) {
          this.cancel(session, 'cancelled');
        } else {
          session.consent = { ...event.payload, consentId: randomUUID(), policyVersion: 1, recordedAt: this.now() };
        }
        break;
      }
      case 'context_updated':
        this.personalization(session);
        this.idle(session);
        this.state(session, ['identified', 'context_ready', 'brief_ready', 'media_ready', 'revealed']);
        session.context = { ...event.payload, source: 'conversation', revision: (session.context?.revision ?? 0) + 1 };
        session.brief = undefined;
        session.state = 'context_ready';
        break;
      case 'media_revealed': {
        this.state(session, ['media_ready']);
        const job = this.job(session, event.payload.jobId).job;
        if (job.status !== 'ready' || job.briefId !== session.brief?.id || !job.result
          || !session.assets.has(job.result.assetId)) {
          throw new ApiError(409, 'MEDIA_NOT_READY', 'Only the current ready media can be revealed.');
        }
        session.state = 'revealed';
        break;
      }
      case 'session_cancelled':
        this.cancel(session, 'cancelled');
        break;
    }
    this.emit(session, event.type, event.type === 'media_revealed' ? { jobId: event.payload.jobId } : {}, event.eventId);
    session.receipts.set(event.eventId, { fingerprint, revision: session.revision });
    return { ...this.snapshot(sessionId), acknowledgement: { eventId: event.eventId, revision: session.revision } };
  }

  async command(sessionId: string, name: string, input: unknown): Promise<CustomerProfile | CustomerContext | AdBrief | MediaJob> {
    const session = this.get(sessionId);
    if (session.showroomActive) throw new ApiError(409, 'SHOWROOM_ACTION_REQUIRED', 'Use the authoritative showroom actions for this session.');
    if (name === 'get_media_status') {
      const { jobId } = parse(GetMediaStatusInputSchema, input);
      return copy(this.job(session, jobId).job);
    }
    if (name === 'schedule_followup') {
      parse(ScheduleFollowupInputSchema, input);
      throw new ApiError(503, 'FOLLOWUP_DISABLED', 'Follow-up booking is disabled. Contact the team manually.');
    }
    if (!['identify_customer', 'enrich_profile', 'create_ad_brief', 'start_media_job'].includes(name)) {
      throw new ApiError(400, 'UNKNOWN_COMMAND', 'This command is not supported.');
    }
    this.mutable(session);
    switch (name) {
      case 'identify_customer': {
        const value = parse(IdentifyCustomerInputSchema, input);
        this.personalization(session);
        this.state(session, ['awaiting_consent']);
        if (value.customerId !== 'demo-alex' && value.customerId !== 'demo-sam') {
          throw new ApiError(404, 'CUSTOMER_NOT_FOUND', 'Select an enrolled synthetic demo customer.');
        }
        session.customer = {
          customerId: value.customerId, displayName: value.customerId === 'demo-alex' ? 'Alex' : 'Sam',
          method: value.method, synthetic: true,
        };
        session.context = { preferences: [], revision: 1, source: 'conversation' };
        session.state = 'identified';
        this.emit(session, 'customer_identified', { customerId: value.customerId, synthetic: true });
        return copy(session.customer);
      }
      case 'enrich_profile':
        parse(EnrichProfileInputSchema, input);
        return this.enrich(session);
      case 'create_ad_brief': {
        parse(CreateAdBriefInputSchema, input);
        return this.createBrief(session);
      }
      case 'start_media_job':
        return this.startJob(session, parse(StartMediaJobInputSchema, input));
      default:
        throw new ApiError(400, 'UNKNOWN_COMMAND', 'This command is not supported.');
    }
  }

  uploadImage(sessionId: string, bytes: Uint8Array, mimeType: 'image/png' | 'image/jpeg'): { assetId: string } {
    const session = this.get(sessionId);
    if (session.showroomActive) throw new ApiError(409, 'SHOWROOM_ACTION_REQUIRED', 'Use the bounded showroom reference uploader.');
    this.mutable(session);
    this.personalization(session);
    if (!session.consent?.capture) throw new ApiError(403, 'CAPTURE_CONSENT_REQUIRED', 'Capture consent is required.');
    this.idle(session);
    this.state(session, ['identified', 'context_ready', 'brief_ready']);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new ApiError(413, 'IMAGE_TOO_LARGE', 'Image uploads must not exceed 5 MiB.');
    }
    const png = mimeType === 'image/png' && bytes.byteLength >= 24
      && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && Buffer.from(bytes.subarray(12, 16)).toString('ascii') === 'IHDR';
    const jpeg = mimeType === 'image/jpeg' && bytes.byteLength >= 4
      && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
    if (!png && !jpeg) throw new ApiError(415, 'INVALID_IMAGE', 'Upload a PNG or JPEG matching its MIME type.');
    if (session.imageAssetId) session.assets.delete(session.imageAssetId);
    const assetId = randomUUID();
    session.assets.set(assetId, { bytes: Uint8Array.from(bytes), mimeType, provenance: 'consented_upload' });
    session.imageAssetId = assetId;
    this.emit(session, 'image_registered', { assetId });
    return { assetId };
  }

  asset(sessionId: string, assetId: string): Asset {
    const session = this.get(sessionId);
    const asset = session.assets.get(assetId);
    if (!asset) throw new ApiError(404, 'ASSET_NOT_FOUND', 'The asset is not available in this session.');
    return copy(asset);
  }

  deleteSession(sessionId: string): void {
    const session = this.get(sessionId);
    this.remove(session, 'cancelled');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const session of this.sessions.values()) this.remove(session, 'cancelled');
    this.queue.length = 0;
  }

  private ensureOpen(): void {
    if (this.disposed) throw new ApiError(503, 'ORCHESTRATOR_DISPOSED', 'The service is shutting down.');
  }

  private get(sessionId: string): Session {
    this.ensureOpen();
    const session = this.sessions.get(sessionId);
    if (!session) {
      if (this.expired.has(sessionId)) throw new ApiError(410, 'SESSION_EXPIRED', 'This session has ended. Start a new session.');
      throw new ApiError(404, 'SESSION_NOT_FOUND', 'The session is not available on this server instance.');
    }
    if (this.now() >= session.expiresAt) {
      this.remove(session, 'expired');
      throw new ApiError(410, 'SESSION_EXPIRED', 'This session has expired. Start a new session.');
    }
    this.expireJobs(session);
    return session;
  }

  private sweep(): void {
    for (const session of this.sessions.values()) {
      if (this.now() >= session.expiresAt) this.remove(session, 'expired');
      else this.expireJobs(session);
    }
  }

  private armExpiration(session: Session): void {
    session.timer = setTimeout(() => {
      if (this.sessions.get(session.id) !== session) return;
      if (this.now() >= session.expiresAt) this.remove(session, 'expired');
      else this.armExpiration(session);
    }, Math.max(1, session.expiresAt - this.now()));
    session.timer.unref();
  }

  private remove(session: Session, status: 'cancelled' | 'expired'): void {
    this.cancel(session, status);
    this.showroom?.forget(session.id);
    clearTimeout(session.timer);
    this.sessions.delete(session.id);
    this.expired.set(session.id, true);
    if (this.expired.size > this.maxSessions * 2) this.expired.delete(this.expired.keys().next().value!);
    session.receipts.clear();
    session.events.length = 0;
  }

  private cancel(session: Session, status: 'cancelled' | 'expired'): void {
    if (session.state !== 'cancelled') for (const listener of this.endListeners) listener(session.id);
    this.showroom?.cancel(session.id);
    session.state = 'cancelled';
    const reason = new ApiError(410, status === 'expired' ? 'SESSION_EXPIRED' : 'SESSION_CANCELLED', 'The session has ended.');
    session.operation?.abort(reason);
    for (const record of session.jobs.values()) {
      if (!terminal(record.job)) {
        record.job.status = status;
        record.job.stage = status;
        record.job.updatedAt = this.now();
        record.controller.abort(reason);
      }
      record.image = { bytes: new Uint8Array(), mimeType: '', provenance: '' };
      record.brief = undefined;
      delete record.job.result;
    }
    for (let index = this.queue.length - 1; index >= 0; index--) {
      if (this.queue[index]?.session === session) this.queue.splice(index, 1);
    }
    session.assets.clear();
    session.imageAssetId = undefined;
    session.consent = undefined;
    session.customer = undefined;
    session.context = undefined;
    session.brief = undefined;
    session.events.length = 0;
  }

  private mutable(session: Session): void {
    if (session.state === 'cancelled') throw new ApiError(409, 'SESSION_CANCELLED', 'This session was cancelled. Start a new session.');
  }

  private personalization(session: Session): void {
    if (!session.consent?.personalization) {
      throw new ApiError(403, 'CONSENT_REQUIRED', 'Explicit personalization consent is required.');
    }
  }

  private idle(session: Session): void {
    if (session.operation || [...session.jobs.values()].some(({ job }) => !terminal(job))) {
      throw new ApiError(409, 'WORKFLOW_BUSY', 'The current workflow is immutable while work is pending.');
    }
  }

  private state(session: Session, allowed: SessionState[]): void {
    if (!allowed.includes(session.state)) throw new ApiError(409, 'INVALID_STATE', 'This operation is not valid in the current session state.');
  }

  private emit(session: Session, type: string, payload: { [key: string]: JsonValue }, eventId: string = randomUUID()): void {
    session.events.push({ schemaVersion: 1, eventId, type, revision: ++session.revision, receivedAt: this.now(), payload });
    if (session.events.length > MAX_EVENTS) session.events.shift();
  }

  private job(session: Session, id: string): JobRecord {
    const record = session.jobs.get(id);
    if (!record) throw new ApiError(404, 'JOB_NOT_FOUND', 'The job is not available in this session.');
    return record;
  }

  private async bounded<T>(
    session: Session, controller: AbortController, timeoutMs: number,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const deadline = Math.min(session.expiresAt, this.now() + timeoutMs);
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason ?? new ApiError(410, 'WORK_CANCELLED', 'The operation was cancelled.'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
      timer = setTimeout(() => controller.abort(new ApiError(504, 'PROVIDER_TIMEOUT', 'The provider deadline was exceeded.')), Math.max(1, deadline - this.now()));
    });
    try {
      controller.signal.throwIfAborted();
      const result = await Promise.race([Promise.resolve().then(() => {
        this.get(session.id);
        controller.signal.throwIfAborted();
        return action(controller.signal);
      }), aborted]);
      this.get(session.id);
      controller.signal.throwIfAborted();
      if (this.now() >= deadline) throw new ApiError(504, 'PROVIDER_TIMEOUT', 'The provider deadline was exceeded.');
      return result;
    } finally {
      clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
  }

  private async enrich(session: Session): Promise<CustomerContext> {
    this.personalization(session);
    this.idle(session);
    this.state(session, ['identified', 'context_ready', 'brief_ready', 'media_ready', 'revealed']);
    if (!session.customer || !session.context) throw new ApiError(409, 'IDENTITY_REQUIRED', 'Select a customer first.');
    if (!isMockProfileProvider(this.profileProvider)) {
      if (!session.consent?.enrichment) throw new ApiError(403, 'ENRICHMENT_CONSENT_REQUIRED', 'External enrichment requires separate consent.');
      if (!session.context.profileUrl) throw new ApiError(400, 'PROFILE_URL_REQUIRED', 'Provide an explicit public profile URL.');
    }
    const controller = new AbortController();
    session.operation = controller;
    try {
      const result = await this.bounded(session, controller, Math.min(this.timeout, 5_000),
        (signal) => this.profileProvider.enrich(copy({ sessionId: session.id, customer: session.customer!, context: session.context! }), signal));
      const validated = ProfileResultSchema.safeParse(result);
      if (!validated.success) throw new ApiError(502, 'INVALID_PROFILE_OUTPUT', 'The profile provider returned invalid data.');
      session.context = { ...session.context, revision: session.context.revision + 1, profile: validated.data };
      session.brief = undefined;
      session.state = 'context_ready';
      this.emit(session, 'context_ready', { contextRevision: session.context.revision, provenance: validated.data.provenance });
      return copy(session.context);
    } finally {
      if (session.operation === controller) session.operation = undefined;
    }
  }

  private async createBrief(session: Session): Promise<AdBrief> {
    this.personalization(session);
    this.idle(session);
    this.state(session, ['context_ready', 'brief_ready', 'media_ready', 'revealed']);
    if (!session.customer || !session.context || session.context.preferences.length === 0) {
      throw new ApiError(409, 'CONTEXT_REQUIRED', 'Confirm a customer preference before creating a brief.');
    }
    const input = copy({
      briefId: randomUUID(), sessionId: session.id, customer: session.customer,
      context: session.context, product: DEMO_PRODUCT,
    });
    const controller = new AbortController();
    session.operation = controller;
    try {
      const output = await this.bounded(session, controller, Math.min(this.timeout, 10_000),
        (signal) => this.briefProvider.create(copy(input), signal));
      const validated = AdBriefSchema.safeParse(output);
      if (!validated.success || validated.data.id !== input.briefId
        || validated.data.sessionId !== input.sessionId
        || validated.data.customerId !== input.customer.customerId
        || validated.data.contextRevision !== input.context.revision
        || canonical(validated.data.audiencePreferences) !== canonical(input.context.preferences)
        || validated.data.callToAction !== input.product.callToAction) {
        throw new ApiError(502, 'INVALID_BRIEF_OUTPUT', 'The brief provider returned invalid or mismatched data.');
      }
      session.brief = validated.data;
      session.state = 'brief_ready';
      if (this.briefProvider.name !== 'mock' && session.brief.provenance === 'mock') {
        this.emit(session, 'fallback_selected', { reason: 'BRIEF_PROVIDER_FAILED', provenance: 'mock' });
      }
      this.emit(session, 'brief_created', { briefId: session.brief.id, provenance: session.brief.provenance });
      return copy(session.brief);
    } finally {
      if (session.operation === controller) session.operation = undefined;
    }
  }

  private startJob(session: Session, input: { briefId: string; idempotencyKey: string }): MediaJob {
    const fingerprint = digest(canonical(input));
    const previous = session.keys.get(input.idempotencyKey);
    if (previous) {
      const record = this.job(session, previous);
      if (record.fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was already used with different input.');
      return copy(record.job);
    }
    this.personalization(session);
    if (!session.consent?.capture) throw new ApiError(403, 'CAPTURE_CONSENT_REQUIRED', 'Capture consent is required.');
    this.idle(session);
    this.state(session, ['brief_ready']);
    if (!session.brief || session.brief.id !== input.briefId) throw new ApiError(409, 'BRIEF_MISMATCH', 'Use the current registered brief.');
    const image = session.imageAssetId ? session.assets.get(session.imageAssetId) : undefined;
    if (!image) throw new ApiError(409, 'IMAGE_REQUIRED', 'Upload a consented customer image before starting media.');
    this.sweep();
    if ((this.running && this.queue.length >= this.maxQueued) || session.jobs.size >= MAX_JOBS) {
      throw new ApiError(429, 'QUEUE_FULL', 'Media capacity reached. Wait before submitting new work.');
    }
    const now = this.now();
    const job: MediaJob = {
      jobId: randomUUID(), briefId: input.briefId, status: 'queued', stage: 'queued',
      createdAt: now, updatedAt: now, deadline: Math.min(session.expiresAt, now + this.timeout),
      attempts: 0, warnings: [],
    };
    const record: JobRecord = {
      job, fingerprint, idempotencyKey: input.idempotencyKey, brief: copy(session.brief),
      image: copy(image), controller: new AbortController(),
    };
    session.jobs.set(job.jobId, record);
    session.keys.set(input.idempotencyKey, job.jobId);
    session.state = 'media_pending';
    this.emit(session, 'media_job_started', { jobId: job.jobId, status: 'queued' });
    this.queue.push({ session, record });
    this.pump();
    return copy(job);
  }

  private expireJobs(session: Session): void {
    for (const record of session.jobs.values()) {
      if (!terminal(record.job) && this.now() >= record.job.deadline) {
        record.controller.abort(new ApiError(504, 'PROVIDER_TIMEOUT', 'The media deadline was exceeded.'));
        this.failJob(session, record, 'expired', 'MEDIA_EXPIRED', 'The media deadline was exceeded.');
      }
    }
    for (let index = this.queue.length - 1; index >= 0; index--) {
      if (terminal(this.queue[index]!.record.job)) this.queue.splice(index, 1);
    }
  }

  private pump(): void {
    if (this.disposed || this.running) return;
    let next = this.queue.shift();
    while (next) {
      if (this.now() >= next.session.expiresAt) this.remove(next.session, 'expired');
      else this.expireJobs(next.session);
      if (!terminal(next.record.job)) {
        this.running = next.record;
        const { session, record } = next;
        record.job.status = 'running';
        record.job.stage = 'accepted';
        record.job.updatedAt = this.now();
        this.emit(session, 'media_progress', { jobId: record.job.jobId, stage: 'accepted' });
        void this.runMedia(session, record).finally(() => {
          if (this.running === record) this.running = undefined;
          this.pump();
        });
        return;
      }
      next = this.queue.shift();
    }
  }

  private async runMedia(session: Session, record: JobRecord): Promise<void> {
    try {
      const output = await this.bounded(session, record.controller, record.job.deadline - this.now(), async (signal) => {
        const generate = async (provider: MediaProvider) => {
          record.job.attempts++;
          if (!record.brief) throw new ApiError(410, 'WORK_CANCELLED', 'The job input is no longer retained.');
          const input: MediaInput = {
            jobId: record.job.jobId, idempotencyKey: record.idempotencyKey,
            brief: copy(record.brief), image: { bytes: Uint8Array.from(record.image.bytes), mimeType: record.image.mimeType },
          };
          return provider.generate(input, signal, (stage) => this.progress(session, record, stage));
        };
        try {
          const primary = this.validateMedia(await generate(this.options.mediaProvider));
          if (primary.provenance === 'prerendered_fallback' && !isPrerecordedDemoProvider(this.options.mediaProvider)) {
            throw new ApiError(502, 'INVALID_MEDIA_OUTPUT', 'A prerecorded fallback must be explicitly selected.');
          }
          if (primary.provenance === 'prerendered_fallback') {
            record.job.warnings.push('Prerecorded demo media; not generated for this customer or brief.');
          }
          return primary;
        } catch (error) {
          signal.throwIfAborted();
          const knownFailure = error instanceof ProviderFailure || error instanceof ApiError;
          const uncertain = error instanceof ProviderFailure && error.acceptanceUncertain;
          if (!knownFailure || uncertain || !this.options.allowFallbacks || !this.options.fallbackMediaProvider) throw error;
          this.get(session.id);
          record.job.warnings.push('The primary provider failed. An explicitly enabled fallback was selected.');
          this.emit(session, 'fallback_selected', { jobId: record.job.jobId, reason: 'PRIMARY_PROVIDER_FAILED' });
          const fallback = this.validateMedia(await generate(this.options.fallbackMediaProvider));
          if (fallback.provenance === 'generated') {
            throw new ApiError(502, 'INVALID_MEDIA_OUTPUT', 'Fallback media must be labeled as a fixture or prerecorded fallback.');
          }
          return fallback;
        }
      });
      if (!this.live(session, record)) return;
      const assetId = randomUUID();
      session.assets.set(assetId, { bytes: Uint8Array.from(output.bytes), mimeType: output.mimeType, provenance: output.provenance });
      record.job.result = {
        assetId, mimeType: output.mimeType, provenance: output.provenance,
        durationSeconds: output.durationSeconds, byteLength: output.bytes.byteLength, checksum: digest(output.bytes),
      };
      record.job.status = 'ready';
      record.job.stage = 'complete';
      record.job.updatedAt = this.now();
      record.image = { bytes: new Uint8Array(), mimeType: '', provenance: '' };
      record.brief = undefined;
      session.state = 'media_ready';
      this.emit(session, 'media_ready', { jobId: record.job.jobId, assetId, provenance: output.provenance });
    } catch (error) {
      if (!this.live(session, record)) return;
      const timedOut = error instanceof ApiError && error.code === 'PROVIDER_TIMEOUT';
      const invalid = error instanceof ApiError && error.code === 'INVALID_MEDIA_OUTPUT';
      const uncertain = error instanceof ProviderFailure && error.acceptanceUncertain;
      this.failJob(session, record, timedOut ? 'expired' : 'failed',
        timedOut ? 'MEDIA_EXPIRED' : uncertain ? 'MEDIA_ACCEPTANCE_UNCERTAIN' : invalid ? 'INVALID_MEDIA_OUTPUT' : 'MEDIA_PROVIDER_FAILED',
        timedOut ? 'The media deadline was exceeded.' : uncertain ? 'Media acceptance is uncertain. Reconcile the provider job before starting another render.' : invalid ? 'The media provider returned invalid media.' : 'Media generation failed.');
    }
  }

  private validateMedia(output: MediaOutput): MediaOutput {
    const result = z.strictObject({
      bytes: z.instanceof(Uint8Array),
      mimeType: z.literal('video/mp4'),
      provenance: z.enum(['generated', 'mock_fixture', 'prerendered_fallback']),
      durationSeconds: z.number().positive().max(30),
    }).safeParse(output);
    if (!result.success) throw new ApiError(502, 'INVALID_MEDIA_OUTPUT', 'The media provider returned invalid media.');
    const bytes = result.data.bytes;
    const header = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 16 || bytes.byteLength > MAX_VIDEO_BYTES
      || header.toString('ascii', 4, 8) !== 'ftyp'
      || header.readUInt32BE(0) < 16 || header.readUInt32BE(0) > bytes.byteLength
      || header.readUInt32BE(0) % 4 !== 0
      || !/^[a-zA-Z0-9 ]{4}$/.test(header.toString('ascii', 8, 12))) {
      throw new ApiError(502, 'INVALID_MEDIA_OUTPUT', 'The media provider did not return a valid MP4 header.');
    }
    return { ...result.data, bytes: Uint8Array.from(bytes) };
  }

  private live(session: Session, record: JobRecord): boolean {
    if (this.disposed || this.sessions.get(session.id) !== session || session.state === 'cancelled' || terminal(record.job)) return false;
    if (this.now() >= session.expiresAt) {
      this.remove(session, 'expired');
      return false;
    }
    if (this.now() >= record.job.deadline) {
      this.failJob(session, record, 'expired', 'MEDIA_EXPIRED', 'The media deadline was exceeded.');
      record.controller.abort(new ApiError(504, 'PROVIDER_TIMEOUT', 'The media deadline was exceeded.'));
      return false;
    }
    return true;
  }

  private progress(session: Session, record: JobRecord, stage: string): void {
    if (!this.live(session, record) || !STAGES.includes(stage) || stage === 'complete') return;
    if (STAGES.indexOf(stage) <= STAGES.indexOf(record.job.stage)) return;
    record.job.stage = stage;
    record.job.updatedAt = this.now();
    this.emit(session, 'media_progress', { jobId: record.job.jobId, stage });
  }

  private failJob(session: Session, record: JobRecord, status: 'failed' | 'expired', code: string, message: string): void {
    if (terminal(record.job)) return;
    record.job.status = status;
    record.job.stage = status;
    record.job.updatedAt = this.now();
    record.job.error = { code, message };
    record.image = { bytes: new Uint8Array(), mimeType: '', provenance: '' };
    record.brief = undefined;
    if (session.state !== 'cancelled') session.state = 'brief_ready';
    this.emit(session, 'media_failed', { jobId: record.job.jobId, code, status });
  }
}
