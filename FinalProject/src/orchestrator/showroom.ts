import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ShowroomActionSchema, ShowroomSnapshotSchema, StudioInputSchema, PendingActionSchema,
  assertExpectedRevision, assertPendingConfirmation, parseAcceptedStudioSnapshot,
  type ShowroomAction, type ShowroomSnapshot, type PendingAction, type ShowroomCatalog,
  type AcceptedStudioSnapshot, type CalendarDraftProposal, type AppointmentDraft,
} from '../contracts/showroom.js';
import type { SessionState } from '../contracts/index.js';
import { BRIDGE_LIMITS, type MotionIntent, type BridgeCommand, type BridgeStatus, type StopIntent } from '../contracts/bridge.js';
import { MAX_REFERENCE_SET_BYTES, validateReferenceImage } from '../providers/image.js';
import type { StudioProvider, StudioPhoto, StudioOutput } from '../providers/studio.js';
import { ProviderFailure } from '../providers/http-client.js';
import { ApiError } from './errors.js';

const clone = <T>(value: T): T => structuredClone(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const bytesHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type RecordState = Omit<ShowroomSnapshot, 'revision' | 'expiresAt' | 'serverInstanceId' | 'acknowledgement'>;
interface SessionRecord {
  view: RecordState;
  photos: Map<string, StudioPhoto & { checksum: string }>;
  receipts: Map<string, { fingerprint: string; revision: number; assetId?: string }>;
  operation?: AbortController;
  work?: Promise<void>;
  pulseCount: number;
  pulseMs: number;
  lastPulseAt: number;
  calendarRequest?: { eventId: string; confirmationId: string; draftId: string; draft: AppointmentDraft };
}
export interface ShowroomCalendar {
  draft(input: CalendarDraftProposal, product: { id: string; name: string }): AppointmentDraft;
  checkAvailability(draft: AppointmentDraft): Promise<{ available: boolean }>;
  confirm(input: { confirmationId: string; confirmed: true; draft: AppointmentDraft }): Promise<{
    status: string; eventId: string; invitationsRequested: boolean;
  }>;
}
export interface ShowroomMotion {
  authorizeMotion(sessionId: string, intent: MotionIntent): BridgeCommand | Promise<BridgeCommand>;
  stopSession(sessionId: string, reason: StopIntent['reason']): unknown;
  sessionState(sessionId: string): BridgeStatus | null;
}
export interface ShowroomAuthority {
  session(id: string): { revision: number; expiresAt: number; state: SessionState; serverInstanceId: string };
  transition(id: string, state: SessionState, event: string): void;
  saveAsset(id: string, asset: { bytes: Uint8Array; mimeType: string; provenance: string }): string;
  deleteAsset(id: string, assetId: string): void;
  end(id: string): void;
}

export class ShowroomService {
  private readonly records = new Map<string, SessionRecord>();
  private readonly mutations = new Map<string, Promise<unknown>>();
  private readonly activeWork = new Set<Promise<void>>();
  private readonly now: () => number;
  constructor(private readonly options: {
    authority: ShowroomAuthority; provider: StudioProvider; mode?: 'studio' | 'fixture';
    calendar?: ShowroomCalendar; motion?: ShowroomMotion; now?: () => number; jobTimeoutMs?: number;
  }) { this.now = options.now ?? Date.now; }

  private record(sessionId: string): SessionRecord {
    const authority = this.options.authority.session(sessionId);
    let record = this.records.get(sessionId);
    if (!record) {
      record = {
        view: {
          schemaVersion: 1, mode: this.options.mode ?? 'studio', sessionId, inputRevision: 0, state: 'intake',
          visitor: null, consent: null, context: null, selection: null, captureSet: null, pendingAction: null,
          acceptedStudio: null, studio: { status: 'idle' }, playback: { status: 'idle' },
          calendar: { status: 'idle' }, bridge: null, motionGrant: null,
        },
        photos: new Map(), receipts: new Map(), pulseCount: 0, pulseMs: 0, lastPulseAt: 0,
      };
      this.records.set(sessionId, record);
    }
    if (authority.state === 'cancelled') record.view.state = 'cancelled';
    return record;
  }

  snapshot(sessionId: string): ShowroomSnapshot {
    const record = this.record(sessionId);
    const authority = this.options.authority.session(sessionId);
    return ShowroomSnapshotSchema.parse(clone({
      ...record.view, revision: authority.revision, expiresAt: authority.expiresAt,
      serverInstanceId: authority.serverInstanceId,
      bridge: this.options.motion?.sessionState(sessionId) ?? null,
    }));
  }

  async catalog(sessionId: string): Promise<ShowroomCatalog> {
    this.options.authority.session(sessionId);
    return this.options.provider.catalog(AbortSignal.timeout(15_000));
  }

  private serial<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(sessionId) ?? Promise.resolve();
    const next = previous.then(action, action);
    this.mutations.set(sessionId, next);
    void next.then(() => { if (this.mutations.get(sessionId) === next) this.mutations.delete(sessionId); },
      () => { if (this.mutations.get(sessionId) === next) this.mutations.delete(sessionId); });
    return next;
  }

  private mutable(record: SessionRecord, movieInput = false): void {
    if (record.view.state === 'cancelled') throw new ApiError(410, 'SESSION_CANCELLED', 'This showroom session has ended.');
    if (movieInput && record.view.acceptedStudio) throw new ApiError(409, 'STUDIO_INPUT_FROZEN', 'The accepted movie input is immutable.');
  }
  private requireCapture(record: SessionRecord): void {
    const consent = record.view.consent;
    if (!consent?.personalization || !consent.capture || !consent.likeness || !consent.providerTransfer) {
      throw new ApiError(403, 'CAPTURE_CONSENT_REQUIRED', 'Explicit photography, likeness and provider-transfer consent is required.');
    }
  }
  private bump(record: SessionRecord, event: string, state?: SessionState): void {
    const view = record.view;
    const existing = this.options.authority.session(view.sessionId).state;
    this.options.authority.transition(view.sessionId, state ?? existing, event);
  }
  private inputChanged(record: SessionRecord): void {
    const view = record.view;
    view.inputRevision++;
    view.pendingAction = null;
    if (view.consent) view.consent = { ...view.consent, inputRevision: view.inputRevision };
    if (view.captureSet) view.captureSet = { ...view.captureSet, inputRevision: view.inputRevision };
    view.motionGrant = null;
  }
  private stage(record: SessionRecord, draft: Omit<PendingAction, 'pendingActionId' | 'confirmationFingerprint' | 'expectedRevision' | 'inputRevision' | 'expiresAt'>): void {
    const authority = this.options.authority.session(record.view.sessionId);
    record.view.pendingAction = PendingActionSchema.parse({
      ...draft, pendingActionId: randomUUID(), inputRevision: record.view.inputRevision,
      expectedRevision: authority.revision + 1, expiresAt: Math.min(authority.expiresAt, this.now() + 120_000),
      confirmationFingerprint: fingerprint({ kind: draft.kind, payload: draft.payload, inputRevision: record.view.inputRevision }),
    });
  }

  async action(sessionId: string, input: unknown): Promise<ShowroomSnapshot> {
    const action = ShowroomActionSchema.parse(input);
    const immediate = action.type === 'stop_requested'
      || (action.type === 'consent_recorded' && this.withdraws(this.record(sessionId), action.payload));
    const execute = async () => {
      const record = this.record(sessionId);
      const view = record.view;
      const digest = fingerprint(action);
      const previous = record.receipts.get(action.eventId);
      if (previous) {
        if (previous.fingerprint !== digest) throw new ApiError(409, 'EVENT_CONFLICT', 'This event ID was used for different input.');
        if (view.state !== 'cancelled' && view.calendar.status === 'uncertain'
            && action.type === 'action_confirmed' && record.calendarRequest?.eventId === action.eventId) {
          await this.submitCalendar(record);
        }
        return { ...this.snapshot(sessionId), acknowledgement: { eventId: action.eventId, revision: previous.revision } };
      }
      this.mutable(record);
      if (action.type !== 'stop_requested' && !(action.type === 'consent_recorded' && this.withdraws(record, action.payload))) {
        assertExpectedRevision(action.expectedRevision, this.options.authority.session(sessionId).revision);
      }
      if (record.receipts.size >= 256 && action.type !== 'stop_requested'
          && !(action.type === 'consent_recorded' && this.withdraws(record, action.payload))) {
        throw new ApiError(429, 'EVENT_LIMIT', 'This session reached its mutation limit. Start a new session.');
      }
      await this.apply(record, action);
      const revision = this.options.authority.session(sessionId).revision;
      record.receipts.set(action.eventId, { fingerprint: digest, revision });
      return { ...this.snapshot(sessionId), acknowledgement: { eventId: action.eventId, revision } };
    };
    return immediate ? execute() : this.serial(sessionId, execute);
  }

  private withdraws(record: SessionRecord, next: { [K in keyof NonNullable<ShowroomSnapshot['consent']>]?: unknown }): boolean {
    const current = record.view.consent;
    return !!current && (['personalization', 'capture', 'likeness', 'providerTransfer', 'calendar', 'motion'] as const)
      .some(key => current[key] && next[key] === false);
  }

  private async apply(record: SessionRecord, action: ShowroomAction): Promise<void> {
    const view = record.view;
    switch (action.type) {
      case 'answer_proposed': {
        this.mutable(record, true);
        if (!view.consent?.personalization) throw new ApiError(403, 'CONSENT_REQUIRED', 'Confirm personalization consent first.');
        let selectedProduct: ShowroomCatalog['products'][number] | undefined;
        if (action.payload.field === 'selection') {
          const selection = action.payload.value;
          const catalog = await this.catalog(view.sessionId);
          assertExpectedRevision(action.expectedRevision, this.options.authority.session(view.sessionId).revision);
          selectedProduct = catalog.products.find(product => product.id === selection.productId && product.ready);
          if (!selectedProduct) {
            throw new ApiError(409, 'PRODUCT_UNAVAILABLE', 'Select an available, approved catalog product.');
          }
        }
        if (action.payload.field === 'context' && action.payload.value.signals.some(signal => signal.source !== 'manual')) {
          throw new ApiError(403, 'ENRICHMENT_NOT_APPROVED', 'Only explicitly self-reported interests are supported in this showroom intake.');
        }
        const answer = action.payload;
        const readback = answer.field === 'visitor' ? `I understood your name as ${answer.value.displayName}. Is that correct?`
          : answer.field === 'context' ? `Your approved interests are ${answer.value.signals.map(signal => signal.value).join(', ') || 'none'}${answer.value.customerFirstName ? `; first name ${answer.value.customerFirstName}` : ''}${answer.value.city ? `; city ${answer.value.city}` : ''}. Is that correct?`
          : `Use ${selectedProduct?.name ?? answer.value.productId}, ${answer.value.templateId}, ${answer.value.heroMode}, ${answer.value.productionMode}, ${answer.value.videoProvider ?? 'image motion only'}, ${answer.value.renderLayout}, ${answer.value.movieDurationSeconds ?? 'standard'} seconds. Is that correct?`;
        this.stage(record, { kind: 'answer', payload: answer, readback });
        this.bump(record, 'showroom_answer_proposed');
        break;
      }
      case 'consent_recorded': {
        if (this.withdraws(record, action.payload)) {
          this.options.authority.end(view.sessionId);
          this.bump(record, 'showroom_consent_withdrawn', 'cancelled');
          break;
        }
        if (view.acceptedStudio && (['personalization', 'capture', 'likeness', 'providerTransfer', 'policyVersion'] as const)
          .some(key => view.consent?.[key] !== action.payload[key])) {
          throw new ApiError(409, 'STUDIO_INPUT_FROZEN', 'Movie permissions cannot change after acceptance except by withdrawal.');
        }
        if (action.payload.policyVersion !== 'showroom-v1') throw new ApiError(400, 'CONSENT_POLICY_INVALID', 'Use the current showroom-v1 consent policy.');
        const consent = action.payload;
        this.stage(record, {
          kind: 'consent', payload: consent,
          readback: `Policy ${consent.policyVersion}. Personalization ${consent.personalization ? 'yes' : 'no'}; up to four photos ${consent.capture ? 'yes' : 'no'}; likeness generation ${consent.likeness ? 'yes' : 'no'}; transfer to generation providers ${consent.providerTransfer ? 'yes' : 'no'}; calendar scheduling ${consent.calendar ? 'yes' : 'no'}; bounded robot movement ${consent.motion ? 'yes' : 'no'}. Confirm these choices?`,
        });
        this.bump(record, 'showroom_consent_proposed');
        break;
      }
      case 'capture_set_recorded': {
        this.mutable(record, true);
        this.requireCapture(record);
        const set = action.payload;
        if (set.sessionId !== view.sessionId || set.consentId !== view.consent!.consentId
            || set.inputRevision !== view.inputRevision || set.references.some(reference => !record.photos.has(reference.assetId))) {
          throw new ApiError(409, 'CAPTURE_SET_MISMATCH', 'Use the current consent, input revision and owned reference photos.');
        }
        const selected = new Set(set.references.map(reference => reference.assetId));
        for (const assetId of record.photos.keys()) {
          if (!selected.has(assetId)) { record.photos.delete(assetId); this.options.authority.deleteAsset(view.sessionId, assetId); }
        }
        view.captureSet = clone(set);
        this.inputChanged(record);
        view.state = 'review';
        this.bump(record, 'showroom_capture_set_recorded', view.visitor ? 'context_ready' : 'awaiting_consent');
        break;
      }
      case 'studio_requested': {
        this.mutable(record, true);
        const studio = StudioInputSchema.parse({
          mode: 'studio', sessionId: view.sessionId, inputRevision: view.inputRevision,
          visitor: view.visitor, consent: view.consent, selection: view.selection,
          context: view.context, captureSet: view.captureSet,
        });
        const catalog = await this.catalog(view.sessionId);
        assertExpectedRevision(action.expectedRevision, this.options.authority.session(view.sessionId).revision);
        const product = catalog.products.find(product => product.id === studio.selection.productId && product.ready);
        if (!product || !catalog.workerAvailable || !catalog.rendererAvailable
            || (studio.selection.videoProvider && !catalog.videoProviders.some(provider => provider.id === studio.selection.videoProvider && provider.available))) {
          throw new ApiError(503, 'STUDIO_NOT_READY', 'The selected product and production services must be ready before approval.');
        }
        this.stage(record, {
          kind: 'studio', payload: studio,
          readback: this.options.mode === 'fixture'
            ? `Play the registered demonstration film for this approved input: ${studio.visitor.displayName}, ${product.name}, ${studio.context.signals.map(signal => signal.value).join(', ') || 'no interests'}. This is a prerecorded demo, not a newly generated film or your likeness. No photos go to a generation provider in fixture mode. Confirm?`
            : `Create one movie for ${studio.visitor.displayName} featuring ${product.name}, interests ${studio.context.signals.map(signal => signal.value).join(', ') || 'none'}, template ${studio.selection.templateId}, ${studio.selection.heroMode}, ${studio.captureSet?.references.length ?? 0} approved photos, ${studio.selection.productionMode}, ${studio.selection.videoProvider ?? 'image motion only'}, ${studio.selection.renderLayout}, ${studio.selection.movieDurationSeconds ?? 'standard'} seconds. The studio director plans the shots. Confirm this fixed movie input?`,
        });
        view.state = 'review';
        this.bump(record, 'showroom_studio_proposed', 'brief_ready');
        break;
      }
      case 'action_confirmed':
        await this.confirm(record, action);
        break;
      case 'playback_started':
      case 'playback_ended': {
        const studio = view.studio;
        if (studio.status !== 'ready' || studio.jobId !== action.payload.jobId || studio.assetId !== action.payload.assetId) {
          throw new ApiError(409, 'MEDIA_NOT_READY', 'Playback must refer to the current ready movie.');
        }
        if (action.type === 'playback_ended' && (view.playback.status !== 'playing'
            || view.playback.playbackId !== action.payload.playbackId)) {
          throw new ApiError(409, 'PLAYBACK_MISMATCH', 'Only the current playback can report its actual ended event.');
        }
        view.playback = { ...action.payload, status: action.type === 'playback_started' ? 'playing' : 'ended' };
        view.state = action.type === 'playback_started' ? 'playback' : 'followup';
        this.options.motion?.stopSession(view.sessionId, 'playback');
        view.motionGrant = null;
        this.bump(record, action.type === 'playback_started' ? 'media_revealed' : 'showroom_playback_ended', 'revealed');
        break;
      }
      case 'calendar_draft_proposed': {
        if (!view.consent?.calendar || view.playback.status !== 'ended') throw new ApiError(403, 'CALENDAR_CONSENT_REQUIRED', 'Calendar consent and completed playback are required.');
        if (!this.options.calendar || !view.selection) throw new ApiError(503, 'FOLLOWUP_DISABLED', 'Calendar scheduling is not configured.');
        if (['submitting', 'scheduled', 'uncertain'].includes(view.calendar.status)) throw new ApiError(409, 'APPOINTMENT_EXISTS', 'Reconcile the existing appointment before preparing another invitation.');
        const catalog = await this.catalog(view.sessionId);
        const product = catalog.products.find(product => product.id === view.selection!.productId);
        if (!product) throw new ApiError(409, 'PRODUCT_UNAVAILABLE', 'The selected product is unavailable.');
        const appointment = this.options.calendar.draft(action.payload, product);
        if (!(await this.options.calendar.checkAvailability(appointment)).available) throw new ApiError(409, 'CALENDAR_BUSY', 'That interval is unavailable. Choose another time.');
        assertExpectedRevision(action.expectedRevision, this.options.authority.session(view.sessionId).revision);
        const draft = { draftId: randomUUID(), inputRevision: view.inputRevision, appointment };
        view.calendar = { status: 'draft', draft };
        this.stage(record, {
          kind: 'calendar', payload: draft,
          readback: `Send a 60-minute invitation for ${appointment.subject}, ${appointment.startTime} to ${appointment.endTime}, timezone ${appointment.timeZone}, location ${appointment.location}, to ${appointment.attendees.join(', ')}. Confirm sending these invitations?`,
        });
        this.bump(record, 'showroom_calendar_proposed');
        break;
      }
      case 'motion_requested':
        if (!view.consent?.motion || !this.options.motion) throw new ApiError(403, 'MOTION_UNAVAILABLE', 'Consented, operator-armed robot movement is unavailable.');
        this.stage(record, { kind: 'motion', payload: action.payload, readback: `Allow this bounded ${action.payload.intent} framing adjustment?` });
        this.bump(record, 'showroom_motion_proposed');
        break;
      case 'motion_execution_requested': {
        const grant = view.motionGrant;
        const bridge = this.options.motion?.sessionState(view.sessionId);
        if (!grant || grant.grantId !== action.payload.grantId || grant.sessionId !== view.sessionId
            || grant.inputRevision !== view.inputRevision || grant.expiresAt <= this.now()
            || !view.consent?.motion || view.playback.status === 'playing' || !bridge?.armed || !bridge.connected
            || bridge.leaseId !== grant.intent.leaseId || bridge.leaseGeneration !== grant.intent.leaseGeneration) {
          view.motionGrant = null;
          throw new ApiError(409, 'MOTION_GRANT_INVALID', 'A current, explicitly approved framing grant and operator lease are required.');
        }
        if (record.pulseCount >= BRIDGE_LIMITS.maxPulseCount || record.pulseMs + grant.intent.pulseMs > BRIDGE_LIMITS.maxCumulativePulseMs
            || this.now() - record.lastPulseAt < BRIDGE_LIMITS.cooldownMs) {
          throw new ApiError(409, 'MOTION_LIMIT', 'The session motion budget or cooldown does not permit another pulse.');
        }
        const capturedAt = Date.parse(action.payload.tracking.capturedAt);
        if (capturedAt > this.now() || this.now() - capturedAt > BRIDGE_LIMITS.trackingFreshnessMs) {
          throw new ApiError(409, 'TRACKING_STALE', 'Capture a fresh framing measurement before moving.');
        }
        record.pulseCount++; record.pulseMs += grant.intent.pulseMs; record.lastPulseAt = this.now();
        this.bump(record, 'showroom_motion_requested');
        record.receipts.set(action.eventId, { fingerprint: fingerprint(action), revision: this.options.authority.session(view.sessionId).revision });
        await this.options.motion!.authorizeMotion(view.sessionId, { ...grant.intent, tracking: action.payload.tracking });
        break;
      }
      case 'stop_requested':
        this.options.motion?.stopSession(view.sessionId, action.payload.reason);
        view.motionGrant = null;
        if (view.pendingAction?.kind === 'motion') view.pendingAction = null;
        this.bump(record, 'showroom_motion_stopped');
        break;
    }
  }

  private async confirm(record: SessionRecord, action: Extract<ShowroomAction, { type: 'action_confirmed' }>): Promise<void> {
    const view = record.view;
    const pending = view.pendingAction;
    if (!pending) throw new ApiError(409, 'APPROVAL_MISMATCH', 'There is no pending action to confirm.');
    assertPendingConfirmation(pending, action.payload, action.expectedRevision,
      this.options.authority.session(view.sessionId).revision, view.inputRevision, this.now());
    if (action.payload.decision === 'reject') {
      view.pendingAction = null;
      this.bump(record, 'showroom_action_rejected');
      return;
    }
    switch (pending.kind) {
      case 'consent':
        this.inputChanged(record);
        view.consent = { ...pending.payload, consentId: randomUUID(), recordedAt: this.now(), inputRevision: view.inputRevision };
        if (view.captureSet) view.captureSet = { ...view.captureSet, consentId: view.consent.consentId };
        view.state = pending.payload.capture ? 'capture' : 'intake';
        this.bump(record, 'showroom_consent_confirmed');
        break;
      case 'answer': {
        this.mutable(record, true);
        const answer = pending.payload;
        if (answer.field === 'visitor') {
          if (view.visitor && view.visitor.displayName !== answer.value.displayName) {
            for (const assetId of record.photos.keys()) this.options.authority.deleteAsset(view.sessionId, assetId);
            record.photos.clear(); view.captureSet = null; view.consent = null; view.context = null;
          }
          view.visitor = { visitorId: view.visitor?.visitorId ?? randomUUID(), sessionId: view.sessionId, source: 'self_reported', displayName: answer.value.displayName };
        } else if (answer.field === 'context') view.context = clone(answer.value);
        else view.selection = clone(answer.value);
        this.inputChanged(record);
        this.bump(record, 'showroom_answer_confirmed', view.visitor ? view.context ? 'context_ready' : 'identified' : 'awaiting_consent');
        break;
      }
      case 'studio': {
        this.mutable(record, true);
        const catalog = await this.catalog(view.sessionId);
        assertPendingConfirmation(pending, action.payload, action.expectedRevision,
          this.options.authority.session(view.sessionId).revision, view.inputRevision, this.now());
        const accepted = parseAcceptedStudioSnapshot({
          schemaVersion: 1, snapshotId: randomUUID(), acceptedAt: this.now(), acceptedRevision: action.expectedRevision + 1,
          pendingActionId: pending.pendingActionId, confirmationFingerprint: pending.confirmationFingerprint, input: pending.payload,
        }, {
          sessionId: view.sessionId, inputRevision: view.inputRevision, consentId: view.consent!.consentId,
          ownedAssetIds: [...record.photos.keys()], availableProductIds: catalog.products.filter(product => product.ready).map(product => product.id),
        });
        view.acceptedStudio = accepted; view.pendingAction = null; view.state = 'producing';
        const jobId = randomUUID();
        view.studio = { status: 'queued', snapshotId: accepted.snapshotId, jobId, stage: 'queued' };
        const controller = new AbortController();
        record.operation = controller;
        this.bump(record, 'showroom_studio_accepted', 'media_pending');
        const work = this.runStudio(record, accepted, jobId, controller);
        record.work = work;
        this.activeWork.add(work);
        void work.then(() => this.activeWork.delete(work), () => this.activeWork.delete(work));
        break;
      }
      case 'calendar': {
        if (!this.options.calendar || !view.consent?.calendar) throw new ApiError(503, 'FOLLOWUP_DISABLED', 'Calendar scheduling is not configured or consented.');
        record.calendarRequest = {
          eventId: action.eventId, confirmationId: pending.pendingActionId,
          draftId: pending.payload.draftId, draft: clone(pending.payload.appointment),
        };
        view.pendingAction = null;
        await this.submitCalendar(record);
        break;
      }
      case 'motion': {
        if (!view.consent?.motion || !this.options.motion) throw new ApiError(403, 'MOTION_UNAVAILABLE', 'Robot movement is unavailable.');
        const bridge = this.options.motion.sessionState(view.sessionId);
        if (!bridge?.armed || !bridge.connected || bridge.leaseId !== pending.payload.leaseId
            || bridge.leaseGeneration !== pending.payload.leaseGeneration || !bridge.leaseExpiresAt || bridge.leaseExpiresAt <= this.now()) {
          throw new ApiError(409, 'MOTION_UNAVAILABLE', 'The approved operator lease is no longer active.');
        }
        view.motionGrant = {
          grantId: randomUUID(), sessionId: view.sessionId, inputRevision: view.inputRevision,
          expiresAt: Math.min(bridge.leaseExpiresAt, this.now() + BRIDGE_LIMITS.maxLeaseMs),
          intent: pending.payload, maxPulseCount: 4, maxCumulativePulseMs: 2000,
        };
        view.pendingAction = null;
        this.bump(record, 'showroom_motion_confirmed');
        break;
      }
    }

  }

  private async submitCalendar(record: SessionRecord): Promise<void> {
    const request = record.calendarRequest;
    if (!request || !this.options.calendar) throw new ApiError(409, 'CALENDAR_CONFIRMATION_MISSING', 'No confirmed appointment is available to reconcile.');
    const view = record.view;
    view.calendar = { status: 'submitting', draftId: request.draftId, confirmationId: request.confirmationId };
    this.bump(record, 'showroom_calendar_submitting');
    try {
      const result = await this.options.calendar.confirm({
        confirmationId: request.confirmationId, confirmed: true, draft: clone(request.draft),
      });
      if (result.status !== 'created' || !result.invitationsRequested) throw new ProviderFailure('CALENDAR_RESULT_UNCERTAIN', 'The invitation result could not be confirmed.', false, true);
      view.calendar = { status: 'scheduled', draftId: request.draftId, confirmationId: request.confirmationId, eventId: result.eventId, invitationStatus: 'sent' };
      record.calendarRequest = undefined;
      if (view.state !== 'cancelled') this.bump(record, 'showroom_calendar_scheduled');
    } catch (error) {
      const uncertain = error instanceof ProviderFailure && error.acceptanceUncertain;
      view.calendar = { status: uncertain ? 'uncertain' : 'failed', draftId: request.draftId,
        error: { code: error instanceof ProviderFailure ? error.code : 'CALENDAR_FAILED', message: 'The calendar invitation was not confirmed. Retry only this exact confirmed action to reconcile an uncertain outcome.' } };
      if (!uncertain) record.calendarRequest = undefined;
      if (view.state !== 'cancelled') this.bump(record, 'showroom_calendar_failed');
    }
  }

  private async runStudio(record: SessionRecord, accepted: AcceptedStudioSnapshot, jobId: string, controller: AbortController): Promise<void> {
    const view = record.view;
    const deadline = AbortSignal.timeout(this.options.jobTimeoutMs ?? 15 * 60_000);
    const signal = AbortSignal.any([controller.signal, deadline]);
    try {
      const result = await this.options.provider.generate(accepted, [...record.photos.values()].map(clone), signal, stage => {
        if (signal.aborted || view.state === 'cancelled') return;
        this.options.authority.session(view.sessionId);
        if (view.studio.status === 'running' && view.studio.stage === stage) return;
        view.studio = { status: 'running', snapshotId: accepted.snapshotId, jobId, stage };
        this.bump(record, 'showroom_studio_progress', 'media_pending');
      });
      signal.throwIfAborted();
      this.options.authority.session(view.sessionId);
      this.publishResult(record, accepted, jobId, result);
    } catch (error) {
      if (view.state !== 'cancelled') {
        view.studio = { status: 'failed', snapshotId: accepted.snapshotId, jobId,
          error: { code: error instanceof ProviderFailure ? error.code : signal.aborted ? 'STUDIO_EXPIRED' : 'STUDIO_FAILED',
            message: error instanceof ProviderFailure ? error.message : 'The approved movie could not be completed. No replacement was generated.' } };
        view.state = 'review';
        try { this.bump(record, 'showroom_studio_failed', 'brief_ready'); } catch (failure) {
          if (!(failure instanceof ApiError && ['SESSION_EXPIRED', 'SESSION_NOT_FOUND', 'ORCHESTRATOR_DISPOSED'].includes(failure.code))) throw failure;
        }
      }
    } finally {
      if (record.operation === controller) record.operation = undefined;
    }
  }
  private publishResult(record: SessionRecord, accepted: AcceptedStudioSnapshot, jobId: string, result: StudioOutput): void {
    const view = record.view;
    if (result.provenance !== (this.options.mode === 'fixture' ? 'mock_fixture' : 'generated')
        || result.mimeType !== 'video/mp4' || result.bytes.byteLength > 50 * 1024 * 1024
        || Buffer.from(result.bytes.subarray(4, 8)).toString('ascii') !== 'ftyp') {
      throw new ProviderFailure('STUDIO_RESULT_MISMATCH', 'The selected studio mode did not return its promised media provenance.');
    }
    const assetId = this.options.authority.saveAsset(view.sessionId, result);
    view.studio = { status: 'ready', snapshotId: accepted.snapshotId, jobId, assetId,
      mimeType: 'video/mp4', durationSeconds: result.durationSeconds, provenance: result.provenance,
      checksum: bytesHash(result.bytes), byteLength: result.bytes.byteLength };
    for (const id of record.photos.keys()) this.options.authority.deleteAsset(view.sessionId, id);
    record.photos.clear();
    view.state = 'review';
    this.bump(record, 'showroom_studio_ready', 'media_ready');
  }

  upload(sessionId: string, bytes: Uint8Array, mimeType: string, expectedRevision: number, eventId: string): Promise<{ assetId: string; snapshot: ShowroomSnapshot }> {
    z.uuid().parse(eventId);
    const digest = fingerprint({ expectedRevision, mimeType, checksum: bytesHash(bytes) });
    return this.serial(sessionId, async () => {
      const record = this.record(sessionId);
      const prior = record.receipts.get(eventId);
      if (prior) {
        if (prior.fingerprint !== digest || !prior.assetId) throw new ApiError(409, 'EVENT_CONFLICT', 'This upload event ID was used for different input.');
        return { assetId: prior.assetId, snapshot: this.snapshot(sessionId) };
      }
      this.mutable(record, true); this.requireCapture(record);
      assertExpectedRevision(expectedRevision, this.options.authority.session(sessionId).revision);
      if (record.photos.size >= 4) throw new ApiError(409, 'REFERENCE_LIMIT', 'Keep at most four original reference photos.');
      if (record.receipts.size >= 256) throw new ApiError(429, 'EVENT_LIMIT', 'This session reached its upload limit.');
      const validated = await validateReferenceImage(bytes, mimeType);
      assertExpectedRevision(expectedRevision, this.options.authority.session(sessionId).revision);
      this.mutable(record, true); this.requireCapture(record);
      if ([...record.photos.values()].reduce((sum, photo) => sum + photo.bytes.byteLength, 0) + validated.bytes.byteLength > MAX_REFERENCE_SET_BYTES) {
        throw new ApiError(413, 'REFERENCE_SET_TOO_LARGE', 'The selected reference set must not exceed 20 MiB.');
      }
      const checksum = bytesHash(validated.bytes);
      if ([...record.photos.values()].some(photo => photo.checksum === checksum)) throw new ApiError(409, 'DUPLICATE_PHOTO', 'This reference photo is already registered.');
      const assetId = this.options.authority.saveAsset(sessionId, { ...validated, provenance: 'consented_upload' });
      record.photos.set(assetId, { assetId, bytes: validated.bytes, mimeType: validated.mimeType, checksum });
      this.inputChanged(record);
      this.bump(record, 'showroom_reference_uploaded');
      record.receipts.set(eventId, { fingerprint: digest, revision: this.options.authority.session(sessionId).revision, assetId });
      return { assetId, snapshot: this.snapshot(sessionId) };
    });
  }

  deleteReference(sessionId: string, assetId: string, expectedRevision: number, eventId: string): Promise<ShowroomSnapshot> {
    z.uuid().parse(assetId); z.uuid().parse(eventId);
    return this.serial(sessionId, async () => {
      const record = this.record(sessionId);
      const digest = fingerprint({ assetId, expectedRevision, eventId, delete: true });
      const prior = record.receipts.get(eventId);
      if (prior) {
        if (prior.fingerprint !== digest) throw new ApiError(409, 'EVENT_CONFLICT', 'This event ID was used for different input.');
        return this.snapshot(sessionId);
      }
      this.mutable(record, true);
      assertExpectedRevision(expectedRevision, this.options.authority.session(sessionId).revision);
      if (!record.photos.has(assetId)) throw new ApiError(404, 'ASSET_NOT_FOUND', 'The reference is not owned by this session.');
      record.photos.delete(assetId); this.options.authority.deleteAsset(sessionId, assetId);
      const set = record.view.captureSet;
      if (set) {
        const references = set.references.filter(reference => reference.assetId !== assetId);
        record.view.captureSet = references.length ? { ...set, references,
          primaryAssetId: set.primaryAssetId === assetId ? references[0]!.assetId : set.primaryAssetId } : null;
      }
      this.inputChanged(record); this.bump(record, 'showroom_reference_deleted');
      record.receipts.set(eventId, { fingerprint: digest, revision: this.options.authority.session(sessionId).revision });
      return this.snapshot(sessionId);
    });
  }

  cancel(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (!record) return;
    const view = record.view;
    record.operation?.abort(new ApiError(410, 'SESSION_CANCELLED', 'The showroom session ended.'));
    if (view.acceptedStudio && view.studio.status !== 'idle') {
      view.studio = { status: 'cancelled', jobId: view.studio.jobId, snapshotId: view.acceptedStudio.snapshotId,
        error: { code: 'SESSION_CANCELLED', message: 'The session ended; studio cleanup is settling.' } };
    }
    this.options.motion?.stopSession(sessionId, 'session_ended');
    record.photos.clear();
    view.visitor = null; view.consent = null; view.context = null; view.captureSet = null;
    view.pendingAction = null; view.acceptedStudio = null; view.selection = null;
    view.motionGrant = null;
    if (view.calendar.status === 'draft') view.calendar = { status: 'idle' };
    view.state = 'cancelled';
  }

  forget(sessionId: string): void { this.records.delete(sessionId); }
  async settled(): Promise<void> { await Promise.all(this.activeWork); }
}
