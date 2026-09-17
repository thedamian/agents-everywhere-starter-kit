import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { AcceptedStudioSnapshotSchema } from "../src/contracts/showroom.ts";
import { createStudioProvider } from "../src/providers/studio.ts";
import { persistentStudioCredential } from "../scripts/studio-credential.mjs";
import { createApiHandlers } from "../../MoviePart/src/server/api.ts";
import { LocalMediaRepository, PRODUCT_OWNER } from "../../MoviePart/src/server/media.ts";
import { ProductCatalog } from "../../MoviePart/src/server/catalog.ts";
import { JobStore } from "../../MoviePart/src/jobs/store.ts";

test("rotating the actual studio API token cannot acknowledge another owner's pending cleanup", { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "studio-owner-recovery-"));
  const dataDir = join(directory, "studio");
  const receiptDirectory = join(directory, "orchestrator");
  const media = new LocalMediaRepository(dataDir);
  const store = new JobStore(dataDir);
  const catalog = new ProductCatalog(dataDir, media);
  const worker = await store.acquireWorker();
  t.after(async () => {
    await store.releaseWorker(worker);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const image = async background => sharp({ create: { width: 12, height: 14, channels: 3, background } }).png().toBuffer();
  await catalog.install({
    id: "toyota-camry", exteriorColor: "red", interiorColor: "black", permission: "Synthetic offline test images only.",
    exterior: await image("red"), interior: await image("black"),
  });
  const launcherRuntime = join(directory, "launcher");
  const originalToken = await persistentStudioCredential(launcherRuntime);
  const rotatedToken = "rotated-private-studio-token";
  const baseUrl = "http://127.0.0.1:3200";
  const config = {
    dataDir, imageModel: "fake-image", veoModel: "fake-veo",
    openaiKey: "fake-not-a-provider-key", visionModel: "fake-vision", directorModel: "fake-director",
  };
  const handlersFor = token => createApiHandlers({ ...config, apiToken: token }, {
    media, store, catalog, rendererReady: async () => ({ available: true, message: "Explicit offline test renderer." }),
  });
  let handlers = handlersFor(originalToken);
  let blockCleanup = true;
  let calls = 0;
  let submissions = 0;
  const controller = new AbortController();
  const transport = async (target, init = {}) => {
    calls++;
    const url = new URL(target);
    assert.equal(url.origin, baseUrl);
    const headers = new Headers(init.headers);
    headers.set("host", url.host);
    const request = new Request(url, { ...init, headers });
    const segments = url.pathname.split("/");
    const key = segments.at(-1);
    if (request.method === "DELETE" && blockCleanup) throw new Error("Simulated unavailable cleanup transport.");
    if (url.pathname === "/api/movie-config") {
      await store.heartbeat(worker);
      return handlers.config(request);
    }
    if (url.pathname === "/api/movie-assets") return handlers.upload(request);
    if (url.pathname === "/api/movie-jobs") {
      submissions++;
      await store.heartbeat(worker);
      return handlers.submit(request);
    }
    if (url.pathname.startsWith("/api/movie-upload-batches/")) {
      return request.method === "DELETE" ? handlers.deleteUploadBatch(request, key) : handlers.getUploadBatch(request, key);
    }
    if (url.pathname.startsWith("/api/movie-job-requests/")) {
      return request.method === "DELETE" ? handlers.cancelJobRequest(request, key) : handlers.getJobRequest(request, key);
    }
    if (url.pathname.startsWith("/api/movie-jobs/")) {
      controller.abort();
      return handlers.getJob(request, key);
    }
    throw new Error(`Unexpected studio route ${url.pathname}`);
  };
  const sessionId = randomUUID(), consentId = randomUUID(), photoId = randomUUID(), snapshotId = randomUUID();
  const snapshot = AcceptedStudioSnapshotSchema.parse({
    schemaVersion: 1, snapshotId, acceptedAt: Date.now(), acceptedRevision: 10,
    pendingActionId: randomUUID(), confirmationFingerprint: "a".repeat(64),
    input: {
      mode: "studio", sessionId, inputRevision: 5,
      visitor: { visitorId: randomUUID(), sessionId, source: "self_reported", displayName: "Synthetic visitor" },
      consent: {
        consentId, inputRevision: 5, recordedAt: Date.now(), policyVersion: "showroom-v1",
        personalization: true, capture: true, likeness: true, providerTransfer: true, calendar: false, motion: false,
      },
      context: { signals: [] },
      selection: {
        productId: "toyota-camry", templateId: "DREAM_ROUTE", heroMode: "LIKENESS",
        productionMode: "movie-first", enableHeroVideo: false, videoProvider: null,
        storyFormat: "four-shot", renderLayout: "storyboard", movieDurationSeconds: null,
      },
      captureSet: {
        captureSetId: randomUUID(), sessionId, consentId, inputRevision: 5,
        references: [{ assetId: photoId, view: "front_face" }], primaryAssetId: photoId,
      },
    },
  });
  const original = createStudioProvider({
    baseUrl, token: originalToken, directory: receiptDirectory, fetch: transport, pollMs: 1, cleanupAttempts: 1,
  });
  await assert.rejects(original.generate(snapshot, [{
    assetId: photoId, mimeType: "image/png", bytes: new Uint8Array(await image("blue")),
  }], controller.signal, () => {}), { code: "STUDIO_CLEANUP_PENDING" });
  assert.equal(submissions, 1);
  const jobs = await store.list();
  assert.equal(jobs.length, 1);
  const ownedPhotoId = jobs[0].request.customer_reference_asset_ids[0];
  assert.ok(await media.getAsset(ownedPhotoId));
  const receiptPath = join(receiptDirectory, `${snapshotId}.json`);
  const pendingReceipt = await readFile(receiptPath, "utf8");
  assert.equal(JSON.parse(pendingReceipt).cleanupRequired, true);

  handlers = handlersFor(rotatedToken);
  blockCleanup = false;
  const rotated = createStudioProvider({ baseUrl, token: rotatedToken, directory: receiptDirectory, fetch: transport });
  const before = calls;
  await assert.rejects(rotated.recoverCleanup(), { code: "STUDIO_CLEANUP_OWNER_MISMATCH" });
  assert.equal(calls, before, "Owner mismatch must fail before contacting the newly authenticated studio principal.");
  assert.equal(await readFile(receiptPath, "utf8"), pendingReceipt);

  const emptyOwnerResponse = await handlers.cancelJobRequest(new Request(`${baseUrl}/api/movie-job-requests/${snapshotId}`, {
    method: "DELETE", headers: { host: "127.0.0.1:3200", authorization: `Bearer ${rotatedToken}`, "x-movie-session-id": sessionId },
  }), snapshotId);
  assert.equal(emptyOwnerResponse.status, 200);
  const emptyOwnerReceipt = (await emptyOwnerResponse.json()).receipt;
  assert.equal(emptyOwnerReceipt.jobId, null);
  assert.equal(emptyOwnerReceipt.assetsDeleted, true);
  assert.equal((await store.list()).length, 1, "An empty receipt from the new owner says nothing about the old owner's job.");
  assert.ok(await media.getAsset(ownedPhotoId));

  const restartedToken = await persistentStudioCredential(launcherRuntime);
  assert.equal(restartedToken, originalToken);
  handlers = handlersFor(restartedToken);
  const restored = createStudioProvider({ baseUrl, token: restartedToken, directory: receiptDirectory, fetch: transport });
  await restored.recoverCleanup();
  assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).cleanupRequired, false);
  assert.equal((await store.list()).length, 0);
  assert.deepEqual((await media.listAssets()).filter(asset => asset.ownerId !== PRODUCT_OWNER), []);
  assert.equal(submissions, 1);
});
