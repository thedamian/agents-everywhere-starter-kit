import { ShowroomClient, ShowroomClientError } from "../../integration/showroom-client";
import {
  ShowroomActionSchema, assertPendingConfirmation,
} from "../../../FinalProject/src/contracts/showroom";
import type {
  ShowroomAction, ShowroomSnapshot, ShowroomSessionCreated, ShowroomCatalog, ShowroomAnswer,
  ShowroomConsentInput, CalendarDraftProposal, PlaybackEvent, PendingAction,
} from "../../../FinalProject/src/contracts/showroom";
import type { FramingTracking } from "../../../FinalProject/src/contracts/bridge";
import { ReferenceCapture } from "./capture";

type ActionInput = ShowroomAction extends infer Action
  ? Action extends ShowroomAction ? Pick<Action, "type" | "payload"> : never : never;
export interface ShowroomState {
  connection: "unpaired" | "connecting" | "active" | "offline" | "ending" | "ended" | "cleanup_failed";
  snapshot: ShowroomSnapshot | null;
  catalog: ShowroomCatalog | null;
  busy: boolean;
  error: string | null;
  movieUrl: string | null;
  movieLoading: boolean;
  playbackError: string | null;
  stopState: "unavailable" | "requested" | "bridge_confirmed" | "unconfirmed";
  generation: number;
}
export type ShowroomApi = Pick<ShowroomClient, "exchange" | "join" | "forget" | "snapshot" | "catalog" | "action" | "movie" | "revoke" | "upload" | "removeReference" | "voice" | "terminateVoice">;

const initial = (): ShowroomState => ({
  connection: "unpaired", snapshot: null, catalog: null, busy: false, error: null,
  movieUrl: null, movieLoading: false, playbackError: null, stopState: "unavailable", generation: 0,
});

export class ShowroomController {
  readonly capture: ReferenceCapture;
  private state = initial();
  private listeners = new Set<() => void>();
  private capability: ShowroomSessionCreated | null = null;
  private root = new AbortController();
  private mediaRoot = new AbortController();
  private blockedConsentId: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private confirmations = new Map<string, { eventId: string; request: Promise<ShowroomSnapshot>; failed: boolean; channel: "voice" | "touch" }>();
  private playback: PlaybackEvent | null = null;
  private playbackStarted = false;
  private playbackEnded = false;
  private playbackStartRequest: Promise<ShowroomSnapshot> | null = null;
  private playbackStartReceipt: { eventId: string; expectedRevision: number } | null = null;
  private playbackEndReceipt: { eventId: string; expectedRevision: number } | null = null;
  private readonly api: ShowroomApi;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly urls: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  private onSuspend: () => void = () => {};
  private onStopCapture: () => void = () => {};
  private onPlaybackPause: (paused: boolean) => void = () => {};
  private tracking: (() => FramingTracking | null) = () => null;
  private photoUploads = new Map<string, { eventId: string; expectedRevision: number; assetId?: string }>();
  private photoRemovals = new Map<string, { eventId: string; expectedRevision: number; assetId: string; refreshAttempt: boolean }>();
  private captureSetAttempt: { photoRevision: number; action: Extract<ShowroomAction, { type: "capture_set_recorded" }> } | null = null;
  private syncedPhotoRevision = -1;
  private motionInFlight = false;
  private motionUntil = 0;
  private stopRequestedAt = 0;
  private calendarConfirmation: { draftId: string; action: Extract<ShowroomAction, { type: "action_confirmed" }> } | null = null;

  constructor(private readonly options: {
    api?: ShowroomApi;
    capture?: ReferenceCapture;
    now?: () => number;
    uuid?: () => string;
    urls?: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
    pollMs?: number;
  } = {}) {
    this.api = options.api ?? new ShowroomClient();
    this.capture = options.capture ?? new ReferenceCapture();
    this.now = options.now ?? Date.now;
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
    this.urls = options.urls ?? URL;
  }

  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setSuspendHandler(handler: () => void) { this.onSuspend = handler; }
  setCaptureStopHandler(handler: () => void) { this.onStopCapture = handler; }
  setPlaybackHandler(handler: (paused: boolean) => void) { this.onPlaybackPause = handler; }
  setTrackingProvider(handler: () => FramingTracking | null) { this.tracking = handler; }
  private set(patch: Partial<ShowroomState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private valid(root: AbortController) { return root === this.root && !root.signal.aborted; }
  reportError(message: string) { this.set({ error: message }); }
  clearError() { this.set({ error: null }); }
  canCapture = () => this.state.connection === "active" && !!this.state.snapshot?.consent?.capture &&
    this.state.snapshot.consent.consentId !== this.blockedConsentId &&
    !!this.state.snapshot.consent.likeness && !!this.state.snapshot.consent.providerTransfer &&
    this.state.snapshot.expiresAt > this.now() && !this.state.snapshot.acceptedStudio && !this.state.movieUrl;
  robotStopped = () => {
    const bridge = this.state.snapshot?.bridge;
    return !bridge || (!this.motionInFlight && bridge.connected && bridge.stopped && bridge.lastHeartbeatAt !== null &&
      bridge.lastHeartbeatAt >= this.stopRequestedAt && this.now() - bridge.lastHeartbeatAt < 1000);
  };
  pending(): PendingAction | null {
    const snapshot = this.state.snapshot, pending = snapshot?.pendingAction;
    return pending && pending.expiresAt > this.now() && pending.expectedRevision === snapshot.revision &&
      pending.inputRevision === snapshot.inputRevision ? pending : null;
  }

  private clearMovie() {
    if (this.state.movieUrl) this.urls.revokeObjectURL(this.state.movieUrl);
    this.playback = null; this.playbackStarted = false; this.playbackEnded = false; this.playbackStartRequest = null;
    this.playbackStartReceipt = null; this.playbackEndReceipt = null;
    this.set({ movieUrl: null, movieLoading: false, playbackError: null });
  }
  private clearLocal() {
    this.blockedConsentId = this.state.snapshot?.consent?.consentId ?? null;
    this.mediaRoot.abort(); this.mediaRoot = new AbortController();
    this.onSuspend();
    this.capture.clear();
    this.clearMovie();
  }
  private reset() {
    clearTimeout(this.pollTimer); clearTimeout(this.expiryTimer);
    this.root.abort(); this.root = new AbortController();
    this.queue = Promise.resolve(); this.confirmations.clear();
    this.photoUploads.clear(); this.photoRemovals.clear(); this.syncedPhotoRevision = -1;
    this.captureSetAttempt = null;
    this.motionInFlight = false; this.motionUntil = 0; this.stopRequestedAt = 0;
    this.calendarConfirmation = null;
    this.clearLocal();
  }
  private receive(snapshot: ShowroomSnapshot) {
    if (!this.capability || snapshot.sessionId !== this.capability.sessionId ||
      snapshot.serverInstanceId !== this.capability.serverInstanceId) throw new ShowroomClientError("Session identity changed. Pair again.", 401, "SESSION_MISMATCH");
    if (snapshot.expiresAt <= this.now() || snapshot.state === "cancelled") throw new ShowroomClientError("This session ended. Local media has been cleared.", 410, "SESSION_ENDED");
    if (this.state.snapshot && snapshot.revision < this.state.snapshot.revision) return;
    const previousConsent = this.state.snapshot?.consent;
    this.set({ snapshot });
    if (this.motionInFlight && snapshot.bridge?.stopped && snapshot.bridge.lastHeartbeatAt !== null &&
      snapshot.bridge.lastHeartbeatAt >= this.motionUntil &&
      this.now() - snapshot.bridge.lastHeartbeatAt < 1000) this.motionInFlight = false;
    if (!snapshot.consent?.capture || !snapshot.consent.likeness || !snapshot.consent.providerTransfer ||
      snapshot.consent.consentId === this.blockedConsentId) {
      if (previousConsent?.capture || previousConsent?.likeness) this.onSuspend();
      this.capture.authorize(false, false);
      this.clearMovie();
    } else {
      this.capture.authorize(true, true);
      if (snapshot.acceptedStudio && this.capture.getState().references.length && this.capture.getState().status !== "frozen") this.capture.freeze();
    }
    if (["requested", "unconfirmed"].includes(this.state.stopState) && snapshot.bridge?.stopped && snapshot.bridge.connected &&
      snapshot.bridge.lastHeartbeatAt !== null && snapshot.bridge.lastHeartbeatAt >= this.stopRequestedAt &&
      this.now() - snapshot.bridge.lastHeartbeatAt <= 1000) {
      this.set({ stopState: "bridge_confirmed" });
    }
    clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => {
      this.reset(); this.api.forget(); this.capability = null;
      this.blockedConsentId = null;
      this.set({ connection: "ended", error: "This session expired. Pair again to continue.", snapshot: null });
    }, Math.max(1, Math.min(snapshot.expiresAt - this.now(), 2147483647)));
  }

  private failure(error: unknown) {
    const message = error instanceof Error ? error.message : "The showroom request failed.";
    if (error instanceof ShowroomClientError && error.terminal) {
      this.reset(); this.api.forget(); this.capability = null;
      this.set({ connection: "ended", snapshot: null, error: message, busy: false });
    } else this.set({ error: message });
    return error;
  }

  async pair(code: string) {
    if (this.state.connection === "ending" || this.state.connection === "cleanup_failed") return;
    this.reset(); this.api.forget(); this.capability = null;
    this.set({ ...initial(), connection: "connecting", generation: this.state.generation + 1 });
    const root = this.root;
    try {
      const capability = await this.api.exchange(code, root.signal);
      if (!this.valid(root)) return;
      this.capability = capability; this.api.join(capability);
      const [snapshot, catalog] = await Promise.all([this.api.snapshot(root.signal), this.api.catalog(root.signal)]);
      if (!this.valid(root)) return;
      this.receive(snapshot);
      this.set({ connection: "active", catalog });
      this.schedulePoll();
    } catch (error) {
      if (!this.valid(root)) return;
      this.failure(error);
      if (this.capability) this.set({ connection: "offline" });
      else this.set({ connection: "unpaired" });
    }
  }

  private schedulePoll() {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => { void this.refresh(); }, this.options.pollMs ?? 1500);
  }
  async refresh() {
    if (!this.capability || ["ending", "ended", "cleanup_failed"].includes(this.state.connection)) return;
    const root = this.root;
    try {
      const snapshot = await this.api.snapshot(root.signal);
      if (!this.valid(root)) return;
      this.receive(snapshot);
      this.set({ connection: "active" });
      this.schedulePoll();
    } catch (error) {
      if (!this.valid(root)) return;
      this.failure(error);
      if (this.valid(root)) {
        this.onSuspend(); this.capture.pause("Connection lost. Reconnect before using the camera.");
        this.set({ connection: "offline", stopState: "unconfirmed" });
      }
    }
  }

  private serial<T>(operation: (root: AbortController) => Promise<T>): Promise<T> {
    const root = this.root;
    const work = this.queue.then(async () => {
      if (!this.valid(root) || this.state.connection !== "active") throw new Error("Reconnect before making changes.");
      this.set({ busy: true, error: null });
      try {
        return await operation(root);
      } catch (error) {
        if (this.valid(root)) {
          this.failure(error);
          if (error instanceof ShowroomClientError && error.status === 409) await this.refresh();
        }
        throw error;
      } finally { if (this.valid(root)) this.set({ busy: false }); }
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
  private async mutate(input: ActionInput, expectedRevision = this.state.snapshot?.revision, eventId = this.uuid()): Promise<ShowroomSnapshot> {
    const action = ShowroomActionSchema.parse({ ...input, schemaVersion: 1, eventId, expectedRevision });
    return this.serial(async root => {
      const snapshot = await this.api.action(action, root.signal);
      if (!this.valid(root)) throw new Error("This session ended before the action completed.");
      this.receive(snapshot);
      return snapshot;
    });
  }

  syncPhotos() {
    return this.serial(async root => {
      if (!this.canCapture()) return;
      await this.flushRemovals(root);
      const capture = this.capture.getState();
      if (!capture.references.length || capture.revision === this.syncedPhotoRevision) return;
      for (const reference of capture.references) {
        let receipt = this.photoUploads.get(reference.id);
        if (!receipt) {
          receipt = { eventId: this.uuid(), expectedRevision: this.state.snapshot!.revision };
          this.photoUploads.set(reference.id, receipt);
        }
        if (!receipt.assetId) {
          let uploaded: Awaited<ReturnType<ShowroomApi["upload"]>>;
          try {
            uploaded = await this.api.upload(reference.blob, receipt, this.mediaRoot.signal);
          } catch (error) {
            if (error instanceof ShowroomClientError && error.status === 409 && error.code === "REVISION_CONFLICT") {
              this.photoUploads.delete(reference.id);
            }
            throw error;
          }
          if (!this.valid(root) || !this.canCapture()) return;
          receipt.assetId = uploaded.assetId;
          this.receive(uploaded.snapshot);
        }
      }
      if (capture.revision !== this.capture.getState().revision || !this.canCapture()) return;
      const snapshot = this.state.snapshot!;
      const references = capture.references.map(reference => ({ assetId: this.photoUploads.get(reference.id)!.assetId!, view: reference.view }));
      const action: Extract<ShowroomAction, { type: "capture_set_recorded" }> = {
        schemaVersion: 1, eventId: this.uuid(), expectedRevision: snapshot.revision, type: "capture_set_recorded",
        payload: {
          captureSetId: this.uuid(), sessionId: snapshot.sessionId, consentId: snapshot.consent!.consentId,
          inputRevision: snapshot.inputRevision, references,
          primaryAssetId: this.photoUploads.get(capture.primaryId!)!.assetId!,
        },
      };
      if (!this.captureSetAttempt || this.captureSetAttempt.photoRevision !== capture.revision) {
        this.captureSetAttempt = { photoRevision: capture.revision, action };
      }
      let result: ShowroomSnapshot;
      try {
        result = await this.api.action(this.captureSetAttempt.action, root.signal);
      } catch (error) {
        if (error instanceof ShowroomClientError && error.status === 409 && error.code === "REVISION_CONFLICT") this.captureSetAttempt = null;
        throw error;
      }
      if (!this.valid(root)) return;
      this.captureSetAttempt = null;
      this.syncedPhotoRevision = capture.revision;
      this.receive(result);
    });
  }
  removePhoto(id: string) {
    if (this.state.busy) return Promise.reject(new Error("Wait for the current photo upload to finish."));
    const assetId = this.photoUploads.get(id)?.assetId;
    if (assetId) this.photoRemovals.set(id, { assetId, eventId: this.uuid(), expectedRevision: this.state.snapshot!.revision, refreshAttempt: false });
    this.capture.remove(id);
    this.photoUploads.delete(id);
    if (!assetId) return Promise.resolve();
    return this.serial(root => this.flushRemovals(root));
  }
  private async flushRemovals(root: AbortController) {
    for (const [id, removal] of this.photoRemovals) {
      if (removal.refreshAttempt) {
        removal.eventId = this.uuid(); removal.expectedRevision = this.state.snapshot!.revision; removal.refreshAttempt = false;
      }
      let result: ShowroomSnapshot;
      try {
        result = await this.api.removeReference(removal.assetId, {
          eventId: removal.eventId, expectedRevision: removal.expectedRevision,
        }, root.signal);
      } catch (error) {
        if (error instanceof ShowroomClientError && error.status === 409 && error.code === "REVISION_CONFLICT") removal.refreshAttempt = true;
        throw error;
      }
      if (!this.valid(root)) return;
      this.photoRemovals.delete(id);
      this.receive(result);
    }
  }
  async openVoice(sdp: string, generation: number, signal: AbortSignal) {
    if (!this.capability || this.state.connection !== "active") throw new Error("Pair the tablet before starting live voice.");
    const sessionId = this.capability.sessionId;
    const response = await this.api.voice(sdp, generation, signal);
    if (response.sessionId !== sessionId || response.generation !== generation) throw new Error("Live voice belongs to an outdated session.");
    return response;
  }
  closeVoice(generation: number) {
    return this.capability ? this.api.terminateVoice(generation) : Promise.resolve();
  }

  propose(answer: ShowroomAnswer) { return this.mutate({ type: "answer_proposed", payload: answer }); }
  consent(input: ShowroomConsentInput) {
    if (!input.capture || !input.likeness || !input.providerTransfer) this.clearLocal();
    return this.mutate({ type: "consent_recorded", payload: input });
  }
  canRequestStudio() {
    const snapshot = this.state.snapshot, capture = this.capture.getState();
    if (this.state.connection !== "active" || !snapshot?.consent || snapshot.consent.consentId === this.blockedConsentId ||
      !snapshot.captureSet?.references.length || snapshot.acceptedStudio || this.state.busy ||
      this.photoRemovals.size || this.captureSetAttempt) return false;
    if (capture.references.length || this.photoUploads.size || this.syncedPhotoRevision >= 0) {
      return this.syncedPhotoRevision === capture.revision &&
        snapshot.captureSet.references.length === capture.references.length &&
        capture.references.every(reference => snapshot.captureSet!.references.some(owned =>
          owned.assetId === this.photoUploads.get(reference.id)?.assetId && owned.view === reference.view));
    }
    return true;
  }
  requestStudio() {
    if (!this.state.snapshot?.captureSet?.references.length) return Promise.reject(new Error("Select one to four photos before creating a movie."));
    if (!this.canRequestStudio()) return Promise.reject(new Error("Finish syncing the current photos and removals before reviewing your movie."));
    this.onStopCapture();
    this.capture.pause("Photos paused while you review your movie.");
    return this.mutate({ type: "studio_requested", payload: {} });
  }
  proposeCalendar(input: CalendarDraftProposal) {
    if (this.state.snapshot?.playback.status !== "ended") return Promise.reject(new Error("Appointments are available after your movie ends."));
    return this.mutate({ type: "calendar_draft_proposed", payload: input });
  }

  confirm(pending: PendingAction, decision: "approve" | "reject", channel: "voice" | "touch") {
    const key = `${pending.pendingActionId}:${pending.confirmationFingerprint}:${decision}`;
    const existing = this.confirmations.get(key);
    if (existing && !existing.failed) return existing.request;
    const snapshot = this.state.snapshot;
    if (!snapshot?.pendingAction) return Promise.reject(new Error("There is no current readback to approve."));
    const confirmation = {
      pendingActionId: pending.pendingActionId, confirmationFingerprint: pending.confirmationFingerprint, decision, channel: existing?.channel ?? channel,
    };
    try {
      assertPendingConfirmation(snapshot.pendingAction, confirmation, pending.expectedRevision, snapshot.revision, snapshot.inputRevision, this.now());
      if (decision === "approve" && pending.kind === "studio") {
        if (!this.canRequestStudio()) throw new Error("Current photo permissions and a fully synced photo set are required before movie approval.");
        this.onStopCapture();
        if (this.capture.getState().references.length) this.capture.freeze();
      }
    } catch (error) { return Promise.reject(error); }
    const eventId = existing?.eventId ?? this.uuid();
    if (pending.kind === "calendar" && decision === "approve") {
      this.calendarConfirmation = {
        draftId: pending.payload.draftId,
        action: { schemaVersion: 1, eventId, expectedRevision: pending.expectedRevision, type: "action_confirmed", payload: confirmation },
      };
    }
    const receipt = { eventId, request: Promise.resolve(snapshot), failed: false, channel: confirmation.channel };
    const request = this.mutate({ type: "action_confirmed", payload: confirmation }, pending.expectedRevision, eventId).catch(error => {
      receipt.failed = true;
      throw error;
    }).then(async result => {
      if (decision === "approve" && pending.kind === "motion" && result.motionGrant) return this.executeFraming();
      return result;
    });
    receipt.request = request;
    this.confirmations.set(key, receipt);
    return request;
  }
  canRetryCalendar() {
    const status = this.state.snapshot?.calendar;
    return this.state.connection === "active" && status?.status === "uncertain" &&
      status.draftId === this.calendarConfirmation?.draftId;
  }
  retryCalendarConfirmation() {
    if (!this.canRetryCalendar() || !this.calendarConfirmation) {
      return Promise.reject(new Error("Ask the operator to reconcile the original confirmed appointment. Do not create a replacement invitation."));
    }
    const action = this.calendarConfirmation.action;
    return this.mutate(action, action.expectedRevision, action.eventId);
  }
  requestFraming() {
    const snapshot = this.state.snapshot, bridge = snapshot?.bridge;
    if (!this.canCapture() || !snapshot?.consent?.motion || !bridge?.armed || !bridge.connected ||
      !bridge.leaseId || !bridge.leaseExpiresAt || bridge.leaseExpiresAt <= this.now()) {
      return Promise.reject(new Error("Framing requires your permission and an operator-armed bridge with confirmed rear clearance."));
    }
    return this.mutate({
      type: "motion_requested", payload: {
        intent: "reverse_for_half_body", speed: "low", pulseMs: 300, leaseId: bridge.leaseId, leaseGeneration: bridge.leaseGeneration,
      },
    });
  }
  private executeFraming() {
    const grant = this.state.snapshot?.motionGrant, tracking = this.tracking();
    if (!grant || !tracking || this.now() - Date.parse(tracking.capturedAt) > 1000 || Date.parse(tracking.capturedAt) > this.now()) {
      return Promise.reject(new Error("Framing paused: a fresh, stable single-person view is required. Resume the camera and request a new adjustment."));
    }
    this.motionInFlight = true;
    this.motionUntil = this.now() + grant.intent.pulseMs;
    // Capture keeps tracking but rejects every image until a fresh stopped heartbeat arrives.
    return this.mutate({ type: "motion_execution_requested", payload: { grantId: grant.grantId, tracking } });
  }

  async stop(reason: "user" | "disconnect" | "playback" | "session_ended" = "user") {
    this.onStopCapture();
    this.capture.pause("Camera paused; resume deliberately after stopping.");
    this.stopRequestedAt = this.now();
    this.set({ stopState: "requested" });
    if (!this.capability || !this.state.snapshot) { this.set({ stopState: "unavailable" }); return; }
    const root = this.root;
    try {
      // Stop must never wait behind upload, generation or calendar work.
      const snapshot = await this.api.action({
        schemaVersion: 1, eventId: this.uuid(), expectedRevision: this.state.snapshot.revision,
        type: "stop_requested", payload: { reason },
      });
      if (!this.valid(root)) return;
      this.receive(snapshot);
      if (this.state.stopState !== "bridge_confirmed") this.set({ stopState: "unconfirmed" });
    } catch (error) {
      if (!this.valid(root)) return;
      this.set({ stopState: "unconfirmed" }); this.failure(error);
    }
  }

  async acceptPlayback() {
    const studio = this.state.snapshot?.studio;
    if (studio?.status !== "ready" || this.state.movieLoading || this.state.movieUrl) return;
    if (!this.state.snapshot?.consent || this.state.snapshot.consent.consentId === this.blockedConsentId) {
      throw new Error("Media permission was withdrawn. The operator must complete cleanup before another presentation.");
    }
    this.onPlaybackPause(true); this.onStopCapture(); this.capture.pause("Camera paused for the movie.");
    const root = this.root;
    this.set({ movieLoading: true, playbackError: null });
    await this.stop("playback");
    if (!this.valid(root)) return;
    if (!this.robotStopped()) {
      this.set({ movieLoading: false, playbackError: "Waiting for a fresh bridge stop confirmation. Ask the operator, then try playback again." });
      return;
    }
    try {
      const media = this.mediaRoot;
      const movie = await this.api.movie(studio, media.signal);
      if (media.signal.aborted) return;
      if (!this.valid(root)) return;
      this.playback = { jobId: studio.jobId, assetId: studio.assetId, playbackId: this.uuid() };
      this.set({ movieUrl: this.urls.createObjectURL(movie), movieLoading: false });
    } catch (error) {
      if (this.valid(root)) this.set({ movieLoading: false, playbackError: error instanceof Error ? error.message : "Movie unavailable. Retry playback." });
    }
  }
  onPlaying() {
    if (!this.playback || this.playbackStarted || !this.state.movieUrl) return;
    this.playbackStarted = true;
    this.playbackStartReceipt = { eventId: this.uuid(), expectedRevision: this.state.snapshot!.revision };
    this.playbackStartRequest = this.mutate({ type: "playback_started", payload: this.playback },
      this.playbackStartReceipt.expectedRevision, this.playbackStartReceipt.eventId);
    void this.playbackStartRequest.catch(() => {
      this.set({ playbackError: "Playback started, but the showroom has not acknowledged it. Retry acknowledgement." });
    });
  }
  async onEnded() {
    if (!this.playback || !this.playbackStarted || this.playbackEnded) return;
    this.playbackEnded = true;
    try {
      await this.playbackStartRequest;
      this.playbackEndReceipt = { eventId: this.uuid(), expectedRevision: this.state.snapshot!.revision };
      await this.mutate({ type: "playback_ended", payload: this.playback }, this.playbackEndReceipt.expectedRevision, this.playbackEndReceipt.eventId);
      this.clearMovie();
      this.onPlaybackPause(false);
    } catch {
      this.set({ playbackError: "The movie ended, but acknowledgement failed. Retry before scheduling." });
    }
  }
  async retryPlaybackAcknowledgement() {
    if (!this.playback || !this.playbackStarted || !this.playbackStartReceipt) throw new Error("Start playback before acknowledging it.");
    this.playbackStartRequest = this.mutate({ type: "playback_started", payload: this.playback },
      this.playbackStartReceipt.expectedRevision, this.playbackStartReceipt.eventId);
    await this.playbackStartRequest;
    if (this.playbackEnded) {
      this.playbackEndReceipt ??= { eventId: this.uuid(), expectedRevision: this.state.snapshot!.revision };
      await this.mutate({ type: "playback_ended", payload: this.playback },
        this.playbackEndReceipt.expectedRevision, this.playbackEndReceipt.eventId);
      this.clearMovie();
      this.onPlaybackPause(false);
    } else this.set({ playbackError: null });
  }
  async voiceAction(input: unknown) {
    const action = ShowroomActionSchema.parse(input);
    if (["playback_started", "playback_ended", "capture_set_recorded", "motion_execution_requested"].includes(action.type)) {
      throw new Error("This event requires local camera or browser playback evidence.");
    }
    if (action.type === "action_confirmed") {
      const original = this.calendarConfirmation?.action.payload;
      if (this.canRetryCalendar() && original && action.payload.channel === "voice" &&
        action.payload.decision === "approve" && action.payload.pendingActionId === original.pendingActionId &&
        action.payload.confirmationFingerprint === original.confirmationFingerprint) return this.retryCalendarConfirmation();
      const pending = this.pending();
      if (!pending || action.payload.channel !== "voice" || action.expectedRevision !== pending.expectedRevision ||
        action.payload.pendingActionId !== pending.pendingActionId ||
        action.payload.confirmationFingerprint !== pending.confirmationFingerprint) throw new Error("Ask for a fresh readback before explicit approval.");
      return this.confirm(pending, action.payload.decision, "voice");
    }
    if (action.type === "stop_requested") { await this.stop(action.payload.reason === "playback" ? "playback" : "user"); return this.state.snapshot; }
    if (action.type === "studio_requested") {
      if (action.expectedRevision !== this.state.snapshot?.revision) throw new Error("Refresh the current movie inputs first.");
      return this.requestStudio();
    }
    if (action.type === "motion_requested") return this.requestFraming();
    if (action.type === "consent_recorded" && (!action.payload.capture || !action.payload.likeness || !action.payload.providerTransfer)) this.clearLocal();
    return this.mutate(action, action.expectedRevision);
  }
  async end() {
    if (this.state.connection === "ending") return;
    this.clearLocal();
    this.set({ connection: "ending", busy: false });
    await this.stop("session_ended");
    this.reset();
    this.set({ connection: "ending", busy: false });
    const root = this.root;
    try {
      if (this.capability) await this.api.revoke(root.signal);
      if (!this.valid(root)) return;
      this.api.forget(); this.capability = null;
      this.set({ ...initial(), connection: "ended", generation: this.state.generation + 1 });
    } catch (error) {
      if (this.valid(root)) this.set({ connection: "cleanup_failed", error: error instanceof Error ? error.message : "Server cleanup needs a retry." });
    }
  }
  dispose() { this.reset(); this.api.forget(); this.capability = null; this.listeners.clear(); }
}
