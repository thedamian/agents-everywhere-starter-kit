import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import { Orchestrator } from "../../FinalProject/src/orchestrator/service";
import { createApp } from "../../FinalProject/src/http/app";
import { readConfig } from "../../FinalProject/src/config";
import { createFixtureStudioProvider } from "../../FinalProject/src/providers/studio-fixture";
import { createPrerecordedDemoProvider } from "../../FinalProject/src/providers/demo-media";
import { ShowroomClient } from "../integration/showroom-client";
import { ShowroomController } from "../src/kiosk/showroom-controller";
import { ReferenceCapture } from "../src/kiosk/capture";
import type { ShowroomCalendar } from "../../FinalProject/src/orchestrator/showroom";
import { ProviderFailure } from "../../FinalProject/src/providers/http-client";

test("real fixture HTTP: one-time pair, consent, quiet references, corrections, frozen movie, browser playback and calendar", { timeout: 30000 }, async t => {
  const bytes = new Uint8Array(await readFile(new URL("../../FinalProject/fixtures/media/default-demo.mp4", import.meta.url)));
  let calendarCalls = 0;
  const calendarConfirmationIds = new Set<string>();
  const calendar: ShowroomCalendar = {
    draft: (proposal, product) => ({
      startTime: proposal.startTime, endTime: new Date(Date.parse(proposal.startTime) + 3600000).toISOString(),
      timeZone: "America/New_York", attendees: [proposal.customerEmail, "staff@example.test"],
      subject: `${product.name} visit`, location: "Fixture showroom", productId: product.id, productName: product.name,
    }),
    checkAvailability: async () => ({ available: true }),
    confirm: async input => {
      calendarCalls++; calendarConfirmationIds.add(input.confirmationId);
      if (calendarCalls === 1) throw new ProviderFailure("CALENDAR_UNCERTAIN", "Fixture lost result", false, true);
      return { status: "created", eventId: "fixture-calendar", invitationsRequested: true };
    },
  };
  const orchestrator = new Orchestrator({
    mediaProvider: createPrerecordedDemoProvider(bytes), studioProvider: createFixtureStudioProvider(bytes),
    showroomMode: "fixture", calendar,
  });
  const config = readConfig({ NODE_ENV: "test", SHOWROOM_MODE: "fixture", SHOWROOM_OPERATOR_TOKEN: "fixture-operator-1234567890123456789" });
  const app = createApp({ orchestrator, config, deviceToken: "fixture-device", log: () => {} });
  const requests: { path: string; method: string }[] = [];
  let loseNextReply: string | null = null;
  let holdUpload: Promise<void> | null = null;
  let uploadStarted: (() => void) | null = null;
  const uploadAttempts: string[] = [];
  let holdDeletion: Promise<void> | null = null;
  let deletionStarted: (() => void) | null = null;
  const deletionAttempts: string[] = [];
  const captureSetAttempts: string[] = [];
  const client = new ShowroomClient(async (url, init) => {
    const path = String(url).replace(/^\/api\/showroom/, "");
    requests.push({ path, method: init?.method ?? "GET" });
    if (path.includes("/showroom/references?") && init?.method === "POST") {
      uploadAttempts.push(path);
      uploadStarted?.();
      if (holdUpload) await holdUpload;
    }
    if (path.includes("/showroom/references/") && init?.method === "DELETE") {
      deletionAttempts.push(path);
      deletionStarted?.();
      if (holdDeletion) await holdDeletion;
    }
    if (path.endsWith("/showroom/actions") && JSON.parse(String(init?.body)).type === "capture_set_recorded") {
      captureSetAttempts.push(String(init?.body));
    }
    const response = await app.request(`http://localhost${path}`, init);
    if (response.ok && path.includes("/showroom/references?") && loseNextReply === "reference_uploaded") {
      loseNextReply = null;
      throw new TypeError("Simulated accepted upload reply lost");
    }
    if (response.ok && path.includes("/showroom/references/") && loseNextReply === "reference_deleted") {
      loseNextReply = null;
      throw new TypeError("Simulated accepted removal reply lost");
    }
    if (response.ok && path.endsWith("/showroom/actions") && JSON.parse(String(init?.body)).type === loseNextReply) {
      loseNextReply = null;
      throw new TypeError("Simulated response lost after server commit");
    }
    return response;
  });
  let blobsCreated = 0;
  const revoked: string[] = [];
  const urls = { createObjectURL: () => `blob:fixture-${++blobsCreated}`, revokeObjectURL: (url: string) => { revoked.push(url); } };
  const capture = new ReferenceCapture({ urls });
  const controller = new ShowroomController({ api: client, capture, urls, pollMs: 100000 });
  t.after(() => { controller.dispose(); orchestrator.dispose(); });
  const pairing = await app.request("http://localhost/v1/operator/kiosk-pairings", {
    method: "POST", headers: { Authorization: `Bearer ${config.SHOWROOM_OPERATOR_TOKEN}`, "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(pairing.status, 201);
  const code = (await pairing.json()).pairingCode;
  await controller.pair(code);
  assert.equal(controller.getState().connection, "active", controller.getState().error ?? "");
  await assert.rejects(client.exchange(code), /HTTP 401|PAIR/);
  assert.equal(controller.getState().snapshot!.mode, "fixture");
  assert.equal(controller.canCapture(), false);
  const consent = {
    policyVersion: "showroom-v1", personalization: true, capture: true, likeness: true,
    providerTransfer: true, calendar: false, motion: false,
  };
  const confirm = async () => {
    const pending = controller.pending();
    assert.ok(pending, "The actual server response must expose an approvable readback");
    return controller.confirm(pending, "approve", "touch");
  };
  await controller.consent(consent);
  assert.equal(controller.canCapture(), false, "proposed consent cannot activate capture");
  await confirm();
  assert.equal(controller.canCapture(), true);
  const photo = await sharp({ create: { width: 640, height: 480, channels: 3, background: "blue" } }).jpeg().toBuffer();
  const addPhoto = () => capture.addManual({
    timestamp: Date.now(), people: 1, tracked: true, stable: true, robotStopped: true,
    view: "front_face", light: 120, sharpness: 100, perceptualHash: "01".repeat(32),
  }, async () => ({
    blob: new Blob([new Uint8Array(photo)], { type: "image/jpeg" }), width: 640, height: 480,
    sha256: "a".repeat(64),
  }));
  await addPhoto();
  let releaseUpload!: () => void;
  const started = new Promise<void>(resolve => { uploadStarted = resolve; });
  holdUpload = new Promise(resolve => { releaseUpload = resolve; });
  const staleUpload = controller.syncPhotos();
  await started;
  await controller.stop();
  releaseUpload(); holdUpload = null;
  await assert.rejects(staleUpload, /REVISION_CONFLICT/);
  loseNextReply = "reference_uploaded";
  await assert.rejects(controller.syncPhotos(), /Cannot reach/);
  loseNextReply = "capture_set_recorded";
  await assert.rejects(controller.syncPhotos(), /Cannot reach/);
  assert.equal(controller.canRequestStudio(), false);
  await controller.syncPhotos();
  assert.notEqual(uploadAttempts[0], uploadAttempts[1], "definite nonacceptance starts a fresh revision/event attempt");
  assert.equal(uploadAttempts[1], uploadAttempts[2], "uncertain acceptance retries the exact byte/event identity");
  assert.equal(captureSetAttempts[0], captureSetAttempts[1], "lost capture-set replies reuse the same mutation receipt");
  assert.equal(controller.getState().snapshot!.captureSet?.references.length, 1);
  let releaseDeletion!: () => void;
  const deleting = new Promise<void>(resolve => { deletionStarted = resolve; });
  holdDeletion = new Promise(resolve => { releaseDeletion = resolve; });
  const staleDeletion = controller.removePhoto(capture.getState().references[0].id);
  await deleting;
  await assert.rejects(controller.requestStudio(), /syncing/);
  await controller.stop();
  releaseDeletion(); holdDeletion = null;
  await assert.rejects(staleDeletion, /REVISION_CONFLICT/);
  loseNextReply = "reference_deleted";
  await assert.rejects(controller.syncPhotos(), /Cannot reach/);
  await assert.rejects(controller.requestStudio(), /syncing/);
  await controller.syncPhotos();
  assert.notEqual(deletionAttempts[0], deletionAttempts[1], "definite deletion nonacceptance gets a fresh revision/event");
  assert.equal(deletionAttempts[1], deletionAttempts[2], "uncertain deletion preserves its exact event identity");
  assert.equal(controller.getState().snapshot!.captureSet, null);
  await addPhoto(); await controller.syncPhotos();
  await controller.propose({ field: "visitor", value: { displayName: "Taylor" } });
  loseNextReply = "action_confirmed";
  await assert.rejects(confirm(), /Cannot reach/);
  await controller.confirm(controller.pending()!, "approve", "voice");
  assert.equal(controller.getState().snapshot!.visitor?.displayName, "Taylor");
  await controller.propose({ field: "context", value: { signals: [{ value: "Coastal drives", source: "manual", visualUseAllowed: true, confidence: null }] } });
  const stale = controller.pending()!;
  await controller.propose({ field: "context", value: { signals: [{ value: "Mountain hikes", source: "manual", visualUseAllowed: true, confidence: null }] } });
  await assert.rejects(controller.confirm(stale, "approve", "voice"));
  await confirm();
  const product = controller.getState().catalog!.products.find(item => item.ready)!;
  await controller.propose({ field: "selection", value: {
    productId: product.id, templateId: "DREAM_ROUTE", heroMode: "LIKENESS", productionMode: "reviewed-storyboard",
    videoProvider: "google-veo", enableHeroVideo: true, storyFormat: "four-shot", renderLayout: "video-bookends", movieDurationSeconds: 15,
  } });
  await confirm();
  await controller.requestStudio();
  await confirm();
  assert.equal(capture.getState().status, "frozen");
  await orchestrator.showroom!.settled();
  await controller.refresh();
  const ready = controller.getState().snapshot!.studio;
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("Fixture did not produce a ready movie.");
  assert.equal(ready.provenance, "mock_fixture");
  assert.equal(controller.getState().movieUrl, null);
  await controller.acceptPlayback();
  assert.ok(controller.getState().movieUrl);
  assert.equal(controller.getState().snapshot!.playback.status, "idle");
  loseNextReply = "playback_started";
  controller.onPlaying();
  for (let attempt = 0; !controller.getState().playbackError && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(controller.getState().playbackError);
  await controller.retryPlaybackAcknowledgement();
  loseNextReply = "playback_ended";
  await controller.onEnded();
  assert.ok(controller.getState().playbackError);
  await controller.retryPlaybackAcknowledgement();
  assert.equal(controller.getState().snapshot!.playback.status, "ended");
  assert.equal(controller.getState().movieUrl, null);
  const sessionId = controller.getState().snapshot!.sessionId;
  assert.equal(orchestrator.snapshot(sessionId).events.filter(event => event.type === "media_revealed").length, 1, "lost replies must not produce duplicate reveal events");
  await controller.consent({ ...consent, calendar: true });
  await confirm();
  await controller.proposeCalendar({ startTime: "2026-09-20T15:00:00-04:00", customerEmail: "visitor@example.test" });
  assert.match(controller.pending()!.readback, /staff@example.test/);
  assert.equal(calendarCalls, 0);
  await confirm();
  assert.equal(calendarCalls, 1);
  assert.equal(controller.getState().snapshot!.calendar.status, "uncertain");
  assert.equal(controller.canRetryCalendar(), true);
  await controller.retryCalendarConfirmation();
  assert.equal(controller.getState().snapshot!.calendar.status, "scheduled");
  assert.equal(calendarCalls, 2);
  assert.equal(calendarConfirmationIds.size, 1, "reconciliation uses the original approved appointment identity");
  await controller.end();
  assert.equal(calendarCalls, 2, "ending the session cannot create or cancel a confirmed appointment");
  assert.equal(controller.getState().connection, "ended");
  assert.equal(capture.getState().references.length, 0);
  assert.equal(blobsCreated, revoked.length);
  assert.ok(requests.every(request => !request.path.includes("127.0.0.1") && !request.path.includes("provider")));
});
