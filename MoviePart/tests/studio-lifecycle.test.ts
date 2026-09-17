import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { MovieError, type JobRequest, type ProductReference } from "../src/domain";
import { JobStore } from "../src/jobs/store";
import { MovieWorker } from "../src/jobs/worker";
import { LocalMediaRepository, normalizeImage } from "../src/server/media";
import { UploadBatchStore } from "../src/server/upload-batches";
import { createApiHandlers } from "../src/server/api";
import { runMediaCommand } from "../src/render/process";

const consent = { likeness: true as const, personalization: true as const };
const product: ProductReference = {
  id: "test-car", version: 1, name: "Synthetic test vehicle", make: null, model: null,
  exteriorColor: "red", interiorColor: null, appearance: "Fixture", approvedClaims: [],
  usagePermission: "Synthetic test", referenceImages: [
    { assetId: randomUUID(), role: "exterior", origin: "original" },
    { assetId: randomUUID(), role: "interior", origin: "original" },
  ],
};
function input(assetId: string, key = randomUUID()): JobRequest {
  return {
    schema_version: 1, session_id: "visitor-a", customer_reference_asset_ids: [assetId],
    primary_reference_asset_id: assetId, consent, product_id: "test-car",
    personalization_profile: { signals: [] }, preferred_template: "DREAM_ROUTE",
    enable_hero_video: false, idempotency_key: key,
  };
}
async function fixture(t: TestContext) {
  const directory = path.resolve(".movie-data", "tests", `lifecycle-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const config = { dataDir: directory, imageModel: "test", veoModel: "test", apiToken: "test-only-machine-token" };
  const media = new LocalMediaRepository(directory);
  const jobs = new JobStore(directory);
  const batches = new UploadBatchStore(jobs, media);
  const photo = async (ownerId = "owner") => media.saveCustomer({
    ownerId, consent, image: await normalizeImage(await sharp({
      create: { width: 10, height: 12, channels: 3, background: "blue" },
    }).png().toBuffer()),
  });
  const form = async (color = "blue", two = false) => {
    const data = new FormData();
    for (const background of two ? [color, "red"] : [color]) {
      const bytes = await sharp({ create: { width: 10, height: 12, channels: 3, background } }).png().toBuffer();
      data.append("photos", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "photo.png");
    }
    data.append("consent", JSON.stringify(consent));
    return new Request("http://127.0.0.1:3200/api/movie-assets", { method: "POST", body: data });
  };
  return { directory, config, media, jobs, batches, photo, form };
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

test("cancel-before-submit is durable, owner-scoped and prevents late POST revival", async t => {
  const { jobs, media, directory, photo } = await fixture(t);
  const asset = await photo();
  const request = input(asset.id);
  const receipt = await jobs.cancelOwnedRequest("owner", request.idempotency_key, media);
  assert.equal(receipt.assetsDeleted, true);
  assert.equal(receipt.jobId, null);
  const restarted = new JobStore(directory);
  await assert.rejects(restarted.create("owner", request, product), (error: unknown) =>
    error instanceof MovieError && error.code === "JOB_CANCELLED");
  assert.ok((await restarted.create("other-owner", request, product)).id);
  assert.equal((await restarted.receipt("owner", request.idempotency_key))?.cancelledAt, receipt.cancelledAt);
});

test("cancelling a queued job reclaims only owned originals and artifacts, and fences retry", async t => {
  const { jobs, media, photo, directory } = await fixture(t);
  const own = await photo();
  const unrelated = await photo("other-owner");
  const request = input(own.id);
  const job = await jobs.create("owner", request, product);
  const artifact = await media.saveAsset({ ownerId: "owner", jobId: job.id, kind: "video", mime: "video/mp4", bytes: new Uint8Array([1]) });
  await writeFile(path.join(media.directory, `${artifact.id}.media.interrupted.writing`), new Uint8Array([2]));
  const receipt = await jobs.cancelOwnedRequest("owner", request.idempotency_key, media);
  assert.equal(receipt.assetsDeleted, true);
  assert.ok(await media.getAsset(unrelated.id));
  assert.deepEqual((await media.listAssets()).map(asset => asset.id), [unrelated.id]);
  assert.equal((await readdir(media.directory)).some(name => name.includes(artifact.id)), false);
  await assert.rejects(new JobStore(directory).create("owner", request, product), /cancelled/);
});

test("active cancellation signals an independent store worker and waits for delayed provider settlement", async t => {
  const { jobs, media, photo, config, directory } = await fixture(t);
  const original = await photo();
  const job = await jobs.create("owner", input(original.id), product);
  const entered = deferred();
  const aborted = deferred();
  const settle = deferred();
  const worker = new MovieWorker(config, { execute: async (_job, context) => {
    await context.report({ stage: "GENERATING_HERO", message: "Fake provider running" });
    entered.resolve();
    context.signal.addEventListener("abort", aborted.resolve, { once: true });
    await settle.promise;
    context.signal.throwIfAborted();
    throw new Error("Cancellation expected");
  } });
  await worker.start();
  const running = worker.runOnce();
  t.after(async () => { settle.resolve(); await worker.stop(); });
  await entered.promise;
  const pending = await new JobStore(directory).cancelOwnedRequest("owner", job.request.idempotency_key, media);
  assert.equal(pending.assetsDeleted, false);
  await aborted.promise;
  assert.ok(await media.getAsset(original.id));
  assert.equal((await jobs.receipt("owner", job.request.idempotency_key))?.assetsDeleted, false);
  await assert.rejects(jobs.retryOwned(job.id, "owner", { idempotency_key: "retry-cancelled", expected_attempt: 0 }, async () => {}), /cancelled/);
  await assert.rejects(jobs.deleteOwned(job.id, "owner", media), /settling/);
  settle.resolve();
  await running;
  assert.equal((await jobs.receipt("owner", job.request.idempotency_key))?.assetsDeleted, true);
  assert.deepEqual(await media.listAssets(), []);
});

test("cancellation kills an owned encoder before claiming local assets deleted", async t => {
  const { jobs, media, photo, config } = await fixture(t);
  const original = await photo();
  const job = await jobs.create("owner", input(original.id), product);
  const entered = deferred();
  let commandSettled = false;
  const worker = new MovieWorker(config, { execute: async (_job, context) => {
    await context.report({ stage: "ASSEMBLING", message: "Fake encoder running" });
    const work = runMediaCommand(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      signal: context.signal, label: "Test owned encoder",
    });
    entered.resolve();
    try { await work; } finally { commandSettled = true; }
    throw new Error("Cancellation expected");
  } });
  await worker.start();
  const running = worker.runOnce();
  t.after(() => worker.stop());
  await entered.promise;
  assert.equal((await jobs.cancelOwnedRequest("owner", job.request.idempotency_key, media)).assetsDeleted, false);
  await running;
  assert.equal(commandSettled, true);
  assert.equal((await jobs.receipt("owner", job.request.idempotency_key))?.assetsDeleted, true);
});

test("cleanup failure is retryable and never publishes successful deletion", async t => {
  const { jobs, media, photo } = await fixture(t);
  const original = await photo();
  const job = await jobs.create("owner", input(original.id), product);
  const remove = media.deleteOwned.bind(media);
  media.deleteOwned = async () => { throw new Error("Simulated disk failure"); };
  await assert.rejects(jobs.cancelOwnedRequest("owner", job.request.idempotency_key, media), /disk failure/);
  assert.equal((await jobs.receipt("owner", job.request.idempotency_key))?.assetsDeleted, false);
  media.deleteOwned = remove;
  assert.equal((await jobs.cancelOwnedRequest("owner", job.request.idempotency_key, media)).assetsDeleted, true);
});

test("reference sharing never deletes another active movie's references", async t => {
  const { jobs, media, photo } = await fixture(t);
  const original = await photo();
  const first = await jobs.create("owner", input(original.id), product);
  const second = await jobs.create("owner", input(original.id), product);
  assert.equal((await jobs.cancelOwnedRequest("owner", first.request.idempotency_key, media)).assetsDeleted, false);
  assert.ok(await media.getAsset(original.id));
  assert.equal((await jobs.cancelOwnedRequest("owner", second.request.idempotency_key, media)).assetsDeleted, true);
  assert.equal((await jobs.cancelOwnedRequest("owner", first.request.idempotency_key, media)).assetsDeleted, true);
});

test("upload batch receipt reconciles lost responses and rejects changed bytes", async t => {
  const { batches, form, media, jobs } = await fixture(t);
  const first = await batches.upload(await form(), "owner", "batch-key");
  const resumed = await new UploadBatchStore(jobs, media).upload(await form(), "owner", "batch-key");
  assert.deepEqual(resumed, first);
  assert.equal((await media.listAssets()).length, 1);
  await assert.rejects(batches.upload(await form("green"), "owner", "batch-key"), /different photos/);
  const cancelled = await batches.cancel("owner", "batch-key");
  assert.equal(cancelled.assetsDeleted, true);
  await assert.rejects(batches.upload(await form(), "owner", "batch-key"), /cancelled/);
  await batches.cancel("owner", "before-upload");
  await assert.rejects(batches.upload(await form(), "owner", "before-upload"), /cancelled/);
});

test("partial upload allocation survives failure for exact orphan cleanup and no foreign deletions", async t => {
  const { batches, form, media, photo } = await fixture(t);
  const unrelated = await photo("other");
  const save = media.saveCustomer.bind(media);
  let saved = 0;
  media.saveCustomer = async input => {
    const result = await save(input);
    if (++saved === 2) throw new Error("Lost result after persistence");
    return result;
  };
  await assert.rejects(batches.upload(await form("blue", true), "owner", "partial"), /Lost result/);
  assert.equal((await batches.get("owner", "partial"))?.state, "uploading");
  assert.equal((await media.listAssets()).length, 3);
  assert.equal((await batches.cancel("owner", "partial")).assetsDeleted, true);
  assert.deepEqual((await media.listAssets()).map(asset => asset.id), [unrelated.id]);
});

test("machine scope is authenticated, receipts and assets remain isolated, and API key validation is strict", async t => {
  const { config, jobs, media, form } = await fixture(t);
  const handlers = createApiHandlers(config, { store: jobs, media, rendererReady: async () => ({ available: true, message: "Fixture" }) });
  const request = async (scope: string, token = config.apiToken) => {
    const source = await form();
    source.headers.set("host", "127.0.0.1:3200");
    source.headers.set("authorization", `Bearer ${token}`);
    source.headers.set("x-movie-session-id", scope);
    source.headers.set("idempotency-key", "batch");
    return source;
  };
  const first = await handlers.upload(await request("session-a"));
  assert.equal(first.status, 201);
  const assetId = (await first.json()).assets[0].id;
  const foreign = await request("session-b");
  assert.equal((await handlers.getUploadBatch(foreign, "batch")).status, 404);
  assert.equal((await handlers.getAsset(foreign, assetId)).status, 404);
  assert.equal((await handlers.upload(await request("../bad"))).status, 400);
  assert.equal((await handlers.upload(await request("session-a", "incorrect"))).status, 401);
  const browser = await request("session-a");
  browser.headers.delete("authorization");
  assert.equal((await handlers.upload(browser)).status, 401);
  assert.equal((await handlers.cancelJobRequest(await request("session-a"), "../bad")).status, 400);
});
