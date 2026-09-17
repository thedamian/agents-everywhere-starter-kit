import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AcceptedStudioSnapshotSchema, ShowroomSnapshotSchema, ShowroomCatalogSchema,
} from "../../FinalProject/src/contracts/showroom";
import type { ShowroomAction, ShowroomSnapshot, PendingAction } from "../../FinalProject/src/contracts/showroom";
import { ShowroomController } from "../src/kiosk/showroom-controller";
import type { ShowroomApi, ShowroomState } from "../src/kiosk/showroom-controller";
import { showroomPrompt, showroomStep } from "../src/kiosk/showroom-guide";
import { ShowroomClientError } from "../integration/showroom-client";
import { ReferenceCapture } from "../src/kiosk/capture";
import type { CaptureView } from "../src/kiosk/capture";

const examples = JSON.parse(await readFile(new URL("../integration/dwight/showroom-v1/examples.json", import.meta.url), "utf8"));
const id = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const baseTime = 1_800_000_000_000;
const movie = new Blob(["movie"], { type: "video/mp4" });
function fixture() {
  let now = baseTime;
  let snapshot = ShowroomSnapshotSchema.parse(examples.ShowroomSnapshotSchema);
  const actions: ShowroomAction[] = [];
  const uploaded: { eventId: string; expectedRevision: number }[] = [];
  const revoked: string[] = [];
  const madeUrls: string[] = [];
  let uploadFailure = false;
  let moviePromise: Promise<Blob> | null = null;
  let actionPromise: Promise<void> | null = null;
  let revokedServer = false;
  const urls = {
    createObjectURL: () => { const url = `blob:${madeUrls.length}`; madeUrls.push(url); return url; },
    revokeObjectURL: (url: string) => { revoked.push(url); },
  };
  const capture = new ReferenceCapture({ now: () => now, urls });
  const api: ShowroomApi = {
    exchange: async () => ({ sessionId: id, sessionToken: "fixture-session-token-123456789", serverInstanceId: id, expiresAt: now + 300000 }),
    join() {}, forget() {},
    snapshot: async () => ShowroomSnapshotSchema.parse(snapshot),
    catalog: async () => ShowroomCatalogSchema.parse(examples.ShowroomCatalogSchema),
    action: async action => {
      actions.push(action);
      if (actionPromise && action.type !== "stop_requested") await actionPromise;
      if (action.expectedRevision !== snapshot.revision && action.type !== "stop_requested") throw new ShowroomClientError("Stale revision.", 409, "REVISION_CONFLICT");
      const revision = snapshot.revision + 1;
      if (action.type === "answer_proposed") {
        snapshot = { ...snapshot, revision, inputRevision: snapshot.inputRevision + 1, pendingAction: {
          kind: "answer", payload: action.payload, pendingActionId: randomUUID(), expectedRevision: revision,
          inputRevision: snapshot.inputRevision + 1, confirmationFingerprint: "b".repeat(64), readback: "A corrected answer. Approve?",
          expiresAt: now + 60000,
        } };
      } else if (action.type === "action_confirmed") {
        if (snapshot.pendingAction?.kind === "studio" && action.payload.decision === "approve") {
          snapshot = { ...snapshot, acceptedStudio: AcceptedStudioSnapshotSchema.parse(examples.AcceptedStudioSnapshotSchema) };
        }
        if (snapshot.pendingAction?.kind === "motion" && action.payload.decision === "approve") {
          snapshot = { ...snapshot, motionGrant: {
            grantId: randomUUID(), sessionId: id, inputRevision: snapshot.inputRevision, expiresAt: now + 10000,
            intent: snapshot.pendingAction.payload, maxPulseCount: 4, maxCumulativePulseMs: 2000,
          } };
        }
        snapshot = { ...snapshot, revision, pendingAction: null };
      } else if (action.type === "capture_set_recorded") {
        snapshot = { ...snapshot, revision, captureSet: action.payload, pendingAction: null };
      } else if (action.type === "playback_started" || action.type === "playback_ended") {
        snapshot = { ...snapshot, revision, playback: { ...action.payload, status: action.type === "playback_started" ? "playing" : "ended" } };
      } else if (action.type === "motion_requested") {
        snapshot = { ...snapshot, revision, pendingAction: {
          kind: "motion", payload: action.payload, pendingActionId: randomUUID(), expectedRevision: revision,
          inputRevision: snapshot.inputRevision, confirmationFingerprint: "c".repeat(64), readback: "A small reverse framing adjustment?",
          expiresAt: now + 60000,
        } };
      } else snapshot = { ...snapshot, revision };
      return ShowroomSnapshotSchema.parse(snapshot);
    },
    upload: async (_blob, query) => {
      uploaded.push({ ...query });
      if (uploadFailure) { uploadFailure = false; throw new ShowroomClientError("Upload reply lost."); }
      snapshot = { ...snapshot, revision: snapshot.revision + 1 };
      return { assetId: randomUUID(), snapshot };
    },
    removeReference: async removeId => {
      const refs = snapshot.captureSet?.references.filter(ref => ref.assetId !== removeId) ?? [];
      snapshot = { ...snapshot, revision: snapshot.revision + 1, captureSet: refs.length && snapshot.captureSet ? {
        ...snapshot.captureSet, references: refs, primaryAssetId: refs[0].assetId,
      } : null };
      return snapshot;
    },
    movie: async () => moviePromise ?? movie,
    voice: async (_sdp, generation) => ({ sessionId: id, generation, session: { id: "voice" }, transport: { type: "webrtc", sdp: "v=0\r\n" } }),
    terminateVoice: async () => {},
    revoke: async () => { revokedServer = true; },
  };
  const controller = new ShowroomController({ api, capture, now: () => now, urls, pollMs: 100000 });
  return {
    controller, capture, api, actions, uploaded, revoked, madeUrls,
    setSnapshot: (update: Partial<ShowroomSnapshot>) => { snapshot = { ...snapshot, ...update }; },
    advance: (ms: number) => { now += ms; },
    failUpload: () => { uploadFailure = true; },
    deferMovie: (value: Promise<Blob>) => { moviePromise = value; },
    deferAction: (value: Promise<void>) => { actionPromise = value; },
    revokedServer: () => revokedServer,
    ready: () => {
      snapshot = { ...snapshot, pendingAction: null, studio: {
        status: "ready", snapshotId: id, jobId: id, assetId, mimeType: "video/mp4",
        durationSeconds: 5, provenance: "generated", byteLength: 5,
        checksum: createHash("sha256").update("movie").digest("hex"),
      } };
    },
    addPhoto: (view: CaptureView = "front_face", index = 0) => capture.addManual({
      timestamp: now, people: 1, tracked: true, stable: true, robotStopped: true, view,
      light: 120, sharpness: 100,
      perceptualHash: Array.from({ length: 64 }, (_, n) => String(Math.floor(n / (2 ** index)) % 2)).join(""),
    }, async () => ({ blob: new Blob([`photo${index}`], { type: "image/jpeg" }), width: 640, height: 480, sha256: String(index).padStart(64, "0") })),
  };
}

function guideState(update: Partial<ShowroomSnapshot>): ShowroomState {
  return {
    connection: "active",
    snapshot: ShowroomSnapshotSchema.parse({
      ...examples.ShowroomSnapshotSchema,
      pendingAction: null,
      acceptedStudio: null,
      studio: { status: "idle" },
      playback: { status: "idle" },
      calendar: { status: "idle" },
      bridge: null,
      motionGrant: null,
      ...update,
    }),
    catalog: null,
    busy: false,
    error: null,
    movieUrl: null,
    movieLoading: false,
    playbackError: null,
    stopState: "unavailable",
    generation: 0,
  };
}

test("showroom guide starts with consent, then quiet capture, then preferences before brief review", () => {
  assert.equal(showroomStep(guideState({ consent: null, captureSet: null, visitor: null, context: null, selection: null })), "consent");
  const capture = guideState({ captureSet: null, visitor: null, context: null, selection: null });
  assert.equal(showroomStep(capture), "capture");
  assert.match(showroomPrompt(capture).message, /one to four clear photos/i);
  assert.equal(showroomStep(guideState({ visitor: null, context: null, selection: null })), "visitor");
  assert.equal(showroomStep(guideState({ context: null, selection: null })), "context");
  assert.equal(showroomStep(guideState({ selection: null })), "selection");
  assert.equal(showroomStep(guideState({})), "review");
  assert.match(showroomPrompt(guideState({})).message, /Create the brief/i);
});

test("spoken and touch approvals race through one exact pending-action mutation", async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  await f.controller.pair("ABCD1234");
  const pending = f.controller.pending()!;
  const touch = f.controller.confirm(pending, "approve", "touch");
  const voice = f.controller.confirm(pending, "approve", "voice");
  assert.equal(touch, voice);
  await Promise.all([touch, voice]);
  assert.equal(f.actions.filter(action => action.type === "action_confirmed").length, 1);
  assert.ok(f.controller.getState().snapshot?.acceptedStudio);
});

test("correction, wrong fingerprint, expiry and partial utterance cannot approve", async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  await f.controller.pair("ABCD1234");
  const old = f.controller.pending()!;
  await assert.rejects(f.controller.confirm({ ...old, confirmationFingerprint: "f".repeat(64) }, "approve", "touch"), /match/);
  await f.controller.propose({ field: "visitor", value: { displayName: "Corrected" } });
  await assert.rejects(f.controller.confirm(old, "approve", "touch"), /Refresh|match/);
  await assert.rejects(f.controller.voiceAction({ transcript: "yes", partial: true }));
  f.advance(60001);
  assert.equal(f.controller.pending(), null);
  const pending = f.controller.getState().snapshot!.pendingAction!;
  await assert.rejects(f.controller.confirm(pending, "approve", "voice"), /expired/);
  assert.equal(f.actions.filter(action => action.type === "action_confirmed").length, 0);
});

test("spoken answers use the same authoritative proposal and explicit confirmation path as touch", async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  await f.controller.pair("ABCD1234");
  const snapshot = f.controller.getState().snapshot!;
  await f.controller.voiceAction({
    schemaVersion: 1, eventId: randomUUID(), expectedRevision: snapshot.revision, type: "answer_proposed",
    payload: { field: "visitor", value: { displayName: "Taylor" } },
  });
  const pending = f.controller.pending()!;
  await f.controller.voiceAction({
    schemaVersion: 1, eventId: randomUUID(), expectedRevision: pending.expectedRevision, type: "action_confirmed",
    payload: {
      pendingActionId: pending.pendingActionId, confirmationFingerprint: pending.confirmationFingerprint,
      decision: "approve", channel: "voice",
    },
  });
  assert.deepEqual(f.actions.slice(-2).map(action => action.type), ["answer_proposed", "action_confirmed"]);
  const confirmation = f.actions.at(-1);
  assert.equal(confirmation?.type, "action_confirmed");
  if (confirmation?.type === "action_confirmed") assert.equal(confirmation.payload.channel, "voice");
});

test("one to four owned uploads bind all views and primary; exact-byte retry reuses event ID", async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  f.setSnapshot({ pendingAction: null, captureSet: null });
  await f.controller.pair("ABCD1234");
  await assert.rejects(f.controller.requestStudio(), /one to four/);
  await f.addPhoto(); f.failUpload();
  await assert.rejects(f.controller.syncPhotos(), /lost/);
  await f.controller.syncPhotos();
  assert.deepEqual(f.uploaded[0], f.uploaded[1]);
  for (const [index, view] of (["half_body", "profile", "three_quarter"] as const).entries()) {
    await f.addPhoto(view, index + 1);
    await f.controller.syncPhotos();
  }
  const set = f.controller.getState().snapshot!.captureSet!;
  assert.equal(set.references.length, 4);
  assert.equal(set.references[0].assetId, set.primaryAssetId);
  await f.controller.removePhoto(f.capture.getState().references[0].id);
  assert.equal(f.capture.getState().references.length, 3);
  assert.equal(f.revoked.length, 1);
});

test("revocation fences pending uploads and clears previews immediately", async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  await f.controller.pair("ABCD1234"); await f.addPhoto();
  let resolve!: (result: Awaited<ReturnType<ShowroomApi["upload"]>>) => void;
  f.api.upload = () => new Promise(r => { resolve = r; });
  const upload = f.controller.syncPhotos();
  await Promise.resolve();
  f.setSnapshot({ consent: null, captureSet: null, pendingAction: null, revision: 9 });
  await f.controller.refresh();
  assert.equal(f.capture.getState().references.length, 0);
  resolve({ assetId, snapshot: f.controller.getState().snapshot! });
  await upload;
  assert.equal(f.actions.filter(action => action.type === "capture_set_recorded").length, 0);
});

test("local withdrawal aborts media immediately and old consent cannot reopen capture after a lost response", async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  await f.controller.pair("ABCD1234"); await f.addPhoto();
  const consent = f.controller.getState().snapshot!.consent!;
  f.api.action = async () => { throw new ShowroomClientError("Withdrawal response lost."); };
  await assert.rejects(f.controller.consent({
    policyVersion: consent.policyVersion, personalization: true, capture: false, likeness: true,
    providerTransfer: true, calendar: false, motion: false,
  }), /lost/);
  assert.equal(f.controller.canCapture(), false);
  assert.equal(f.capture.getState().references.length, 0);
  await f.controller.refresh();
  assert.equal(f.controller.canCapture(), false, "a stale authorized snapshot cannot undo local withdrawal");
  assert.equal(f.capture.getState().status, "off");
  f.setSnapshot({ consent: { ...consent, consentId: randomUUID() }, revision: 4 });
  await f.controller.refresh();
  assert.equal(f.controller.canCapture(), true, "only a new authoritative consent grant can reopen capture");
});

test("withdrawal aborts an in-flight photo before waiting for a server mutation", async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  await f.controller.pair("ABCD1234"); await f.addPhoto();
  let signal: AbortSignal | undefined;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  f.api.upload = (_blob, _query, incoming) => new Promise((_resolve, reject) => {
    signal = incoming;
    incoming?.addEventListener("abort", () => reject(new ShowroomClientError("Photo aborted.", 0, "ABORTED")), { once: true });
    began();
  });
  const photo = f.controller.syncPhotos();
  const rejected = assert.rejects(photo, /aborted/);
  await started;
  const consent = f.controller.getState().snapshot!.consent!;
  const withdrawing = f.controller.consent({
    policyVersion: consent.policyVersion, personalization: true, capture: false, likeness: true,
    providerTransfer: true, calendar: false, motion: false,
  });
  assert.equal(signal?.aborted, true);
  assert.equal(f.controller.canCapture(), false);
  await rejected; await withdrawing;
  assert.equal(f.capture.getState().references.length, 0);
});

test("playback must be explicitly accepted, actually playing, and actually ended", async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  f.ready(); await f.controller.pair("ABCD1234");
  const playbackPauses: boolean[] = [];
  f.controller.setPlaybackHandler(paused => playbackPauses.push(paused));
  assert.equal(f.controller.getState().movieUrl, null);
  await f.controller.onEnded();
  assert.equal(f.actions.length, 0);
  await f.controller.acceptPlayback();
  assert.deepEqual(playbackPauses, [true]);
  assert.equal(f.actions.filter(action => action.type === "playback_started").length, 0);
  f.controller.onPlaying(); f.controller.onPlaying();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.actions.filter(action => action.type === "playback_started").length, 1);
  await f.controller.onEnded(); await f.controller.onEnded();
  assert.equal(f.actions.filter(action => action.type === "playback_ended").length, 1);
  assert.deepEqual(playbackPauses, [true, false]);
  assert.equal(f.controller.getState().movieUrl, null);
});

test("voice cannot forge capture, playback or a fresh motion measurement", async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  await f.controller.pair("ABCD1234");
  await assert.rejects(f.controller.voiceAction({
    schemaVersion: 1, eventId: randomUUID(), expectedRevision: 3, type: "playback_started",
    payload: { jobId: id, assetId, playbackId: id },
  }), /local camera or browser/);
  assert.equal(f.actions.length, 0);
});

test("end clears local media before network cleanup and discards late movie responses", async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  f.ready(); await f.controller.pair("ABCD1234"); await f.addPhoto();
  let resolve!: (blob: Blob) => void;
  f.deferMovie(new Promise(r => { resolve = r; }));
  const loading = f.controller.acceptPlayback();
  await new Promise(r => setImmediate(r));
  const ending = f.controller.end();
  assert.equal(f.capture.getState().references.length, 0);
  await ending;
  resolve(movie); await loading;
  assert.equal(f.controller.getState().movieUrl, null);
  assert.equal(f.revokedServer(), true);
  assert.equal(f.actions.some(action => action.type === "calendar_draft_proposed"), false);
});

test("Stop bypasses a pending action and never turns a stale heartbeat into confirmation", async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  f.setSnapshot({ bridge: {
    bridgeId: id, connected: true, armed: true, stopped: true, leaseGeneration: 1,
    lastHeartbeatAt: baseTime - 1, leaseId: id, leaseExpiresAt: baseTime + 10000,
  } });
  await f.controller.pair("ABCD1234");
  let resolve!: () => void;
  f.deferAction(new Promise(r => { resolve = r; }));
  const answer = f.controller.propose({ field: "visitor", value: { displayName: "Sam" } });
  await Promise.resolve();
  await f.controller.stop();
  assert.equal(f.actions.at(-1)?.type, "stop_requested");
  assert.equal(f.controller.getState().stopState, "unconfirmed");
  assert.equal(f.controller.robotStopped(), false);
  resolve();
  await assert.rejects(answer, /Stale/);
});

test("motion approval contains no frozen tracking; execution requires a fresh measured frame", async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  f.setSnapshot({
    pendingAction: null,
    consent: { ...ShowroomSnapshotSchema.parse(examples.ShowroomSnapshotSchema).consent!, motion: true },
    bridge: { bridgeId: id, connected: true, armed: true, stopped: true, leaseGeneration: 1,
      lastHeartbeatAt: baseTime, leaseId: id, leaseExpiresAt: baseTime + 10000 },
  });
  await f.controller.pair("ABCD1234");
  await f.controller.requestFraming();
  const pending = f.controller.pending()!;
  assert.equal("tracking" in pending.payload, false);
  f.advance(1500);
  f.controller.setTrackingProvider(() => ({
    capturedAt: new Date(baseTime + 1500).toISOString(), confidence: 0.9, personCount: 1,
    goal: "half_body", centerX: 0.5, centerY: 0.5, bodyOccupancy: 0.6,
  }));
  await f.controller.confirm(pending, "approve", "touch");
  assert.equal(f.actions.at(-1)?.type, "motion_execution_requested");
  assert.equal(f.controller.robotStopped(), false);
  const action = f.actions.at(-1)!;
  assert.ok(action.type === "motion_execution_requested");
  assert.equal(action.payload.tracking.capturedAt, new Date(baseTime + 1500).toISOString());
});

test("expired session clears all local state with fake timers", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); t.after(() => f.controller.dispose());
  f.setSnapshot({ expiresAt: baseTime + 50 });
  await f.controller.pair("ABCD1234"); await f.addPhoto();
  t.mock.timers.tick(50);
  assert.equal(f.controller.getState().connection, "ended");
  assert.equal(f.capture.getState().references.length, 0);
});
