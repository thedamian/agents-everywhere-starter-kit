import assert from "node:assert/strict";
import test from "node:test";
import { robotPrompt } from "../src/kiosk/robot-guide";
import { RobotNarrator, localBrowserSpeech } from "../src/kiosk/robot-speech";
import type { SpeechCallbacks } from "../src/kiosk/robot-speech";
import type { KioskState } from "../src/kiosk/controller";
import type { AdBrief, MediaJob, SessionSnapshot } from "../integration/dwight/types";

function state(): KioskState {
  return {
    connection: "unpaired", snapshot: null, consent: { personalization: false, capture: false, enrichment: false },
    busy: null, error: null, networkError: null, notice: null, photoUrl: null,
    movieUrl: null, movieAssetId: null, uploadedId: null, photoVersion: 0,
    reveal: "unplayed", revealError: null, startAttempted: false, generation: 0,
  };
}
function snapshot(): SessionSnapshot {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    serverInstanceId: "22222222-2222-4222-8222-222222222222",
    state: "awaiting_consent", revision: 1, expiresAt: Date.now() + 90_000, jobs: [], events: [],
  };
}
const brief: AdBrief = {
  schemaVersion: 1, id: "33333333-3333-4333-8333-333333333333",
  sessionId: snapshot().sessionId, customerId: "demo-alex", productId: "demo-car",
  contextRevision: 2, objective: "A synthetic concept", audiencePreferences: ["Beach road trips"],
  scenes: [{ durationSeconds: 6, visual: "A synthetic car", onScreenText: "Synthetic concept" }],
  callToAction: "Ask the team", templateId: "demo-car-v1", durationSeconds: 6, provenance: "mock",
};
function job(status: MediaJob["status"]): MediaJob {
  return {
    jobId: "44444444-4444-4444-8444-444444444444", briefId: brief.id, status, stage: "rendering",
    createdAt: 1, updatedAt: 2, deadline: Date.now() + 60_000, attempts: 1, warnings: [],
  };
}

test("robot greeting invites pairing and does not grant consent or claim to listen", () => {
  const current = state();
  const before = structuredClone(current);
  assert.equal(robotPrompt(current).action, "connect");
  assert.match(robotPrompt(current).message, /permission/);
  assert.deepEqual(current, before);
  current.connection = "active";
  current.snapshot = snapshot();
  const prompt = robotPrompt(current);
  assert.equal(prompt.id, "permissions");
  assert.equal(prompt.action, "permissions");
  assert.match(prompt.message, /You can say no/);
  assert.equal(current.snapshot.consent, undefined);
});

test("robot takes the legacy flow from consent to photos before customer preferences and brief", () => {
  const current = state();
  current.connection = "active";
  current.snapshot = snapshot();
  current.snapshot.consent = {
    consentId: "55555555-5555-4555-8555-555555555555", policyVersion: 1,
    recordedAt: Date.now(), capture: true, personalization: true, enrichment: false,
  };
  assert.equal(robotPrompt(current).action, "photo");
  current.uploadedId = "photo";
  assert.equal(robotPrompt(current).id, "preferences");
  current.snapshot.customer = { customerId: "demo-alex", displayName: "Alex", method: "manual", synthetic: true };
  current.snapshot.context = { revision: 2, source: "conversation", preferences: ["Beach road trips"] };
  assert.equal(robotPrompt(current).action, "brief");
  assert.equal(robotPrompt(current).actionLabel, "Create brief");
  current.snapshot.brief = brief;
  assert.equal(robotPrompt(current).action, "create");
  current.snapshot.jobs = [job("running")];
  assert.equal(robotPrompt(current).expression, "thinking");
  const firstId = robotPrompt(current).id;
  current.snapshot.revision++;
  current.snapshot.jobs[0].stage = "encoding";
  assert.equal(robotPrompt(current).id, firstId, "polling/progress does not restart speech");
});

test("ready prompts distinguish fixture/fallback/generated and yield to actual video", () => {
  const current = state();
  current.connection = "active";
  current.snapshot = snapshot();
  current.snapshot.consent = { consentId: "consent", policyVersion: 1, recordedAt: 1, personalization: true, capture: true, enrichment: false };
  current.snapshot.brief = brief;
  const ready = job("ready");
  ready.result = {
    assetId: "asset", mimeType: "video/mp4", provenance: "mock_fixture",
    durationSeconds: 1, byteLength: 2880, checksum: "checksum",
  };
  current.snapshot.jobs = [ready];
  assert.match(robotPrompt(current).message, /synthetic sample, not a movie of you/i);
  ready.result.provenance = "prerendered_fallback";
  assert.match(robotPrompt(current).message, /not generated/i);
  ready.result.provenance = "generated";
  assert.equal(robotPrompt(current).action, "load");
  current.movieUrl = "blob:authorized-result";
  assert.equal(robotPrompt(current).id, "playback");
  assert.equal(robotPrompt(current).action, null);
  assert.equal(current.reveal, "unplayed", "presentation never acknowledges playback itself");
  current.connection = "terminal";
  assert.equal(robotPrompt(current).id, "ended");
});

test("failure and disconnect prompts never announce a successful movie", () => {
  const current = state();
  current.connection = "active";
  current.snapshot = snapshot();
  current.snapshot.consent = { consentId: "consent", policyVersion: 1, recordedAt: 1, personalization: true, capture: true, enrichment: false };
  current.snapshot.brief = brief;
  current.snapshot.jobs = [job("failed")];
  assert.match(robotPrompt(current).message, /didn't finish/);
  current.connection = "cleanup_failed";
  assert.match(robotPrompt(current).message, /cleanup needs attention/);
  current.connection = "offline";
  assert.match(robotPrompt(current).message, /disconnected/);
});

function speech() {
  const requests: { text: string; callbacks: SpeechCallbacks; stopped: boolean }[] = [];
  const narrator = new RobotNarrator({
    speak(text, callbacks) {
      const request = { text, callbacks, stopped: false };
      requests.push(request);
      return () => { request.stopped = true; };
    },
  });
  return { narrator, requests };
}

test("mouth movement starts with actual speech start and stops before revealing controls", () => {
  const { narrator, requests } = speech();
  let prompted = 0;
  narrator.speak("May I use a photo?", () => {
    assert.equal(narrator.getState().status, "idle");
    prompted++;
  });
  assert.equal(narrator.getState().status, "queued");
  requests[0].callbacks.start();
  assert.equal(narrator.getState().status, "speaking");
  requests[0].callbacks.end();
  assert.equal(narrator.getState().status, "idle");
  assert.equal(prompted, 1);
  requests[0].callbacks.end();
  assert.equal(prompted, 1, "duplicate browser callbacks cannot prompt twice");
});

test("stop/visibility/session cancellation ignores late speech callbacks and never opens controls", () => {
  const { narrator, requests } = speech();
  let completed = false;
  narrator.speak("Choose permissions", () => { completed = true; });
  requests[0].callbacks.start();
  narrator.stop();
  requests[0].callbacks.end();
  requests[0].callbacks.start();
  assert.equal(requests[0].stopped, true);
  assert.equal(narrator.getState().status, "idle");
  assert.equal(completed, false);
});

test("replacing a prompt cancels the old speech without stale state changes", () => {
  const { narrator, requests } = speech();
  narrator.speak("First prompt");
  requests[0].callbacks.start();
  narrator.speak("Next prompt");
  assert.equal(requests[0].stopped, true);
  requests[0].callbacks.error();
  assert.equal(narrator.getState().status, "queued");
  requests[1].callbacks.start();
  assert.equal(narrator.getState().status, "speaking");
  narrator.stop();
});

test("speech unavailable/error keeps captions usable and invokes the text handoff once", () => {
  const narrator = new RobotNarrator({ speak(_text, callbacks) { callbacks.error(); return () => {}; } });
  let completed = 0;
  narrator.speak("May I use a photo?", () => { completed++; });
  assert.equal(narrator.getState().status, "error");
  assert.match(narrator.getState().error!, /continue without sound/);
  assert.equal(completed, 1);
  narrator.stop();
  const unavailable = new RobotNarrator(localBrowserSpeech());
  unavailable.speak("No browser present");
  assert.equal(unavailable.getState().status, "error");
  unavailable.stop();
});

test("a missing browser end event cannot leave the mouth talking indefinitely", async () => {
  let cancelled = false;
  const narrator = new RobotNarrator({
    speak(_text, callbacks) { callbacks.start(); return () => { cancelled = true; }; },
  }, 15);
  narrator.speak("A short greeting");
  assert.equal(narrator.getState().status, "speaking");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(narrator.getState().status, "error");
  assert.equal(cancelled, true);
});
