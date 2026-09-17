import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createApiHandlers, parseRange } from "../src/server/api";
import { SessionAuth, validateHost } from "../src/server/auth";
import { JobStore } from "../src/jobs/store";
import { LocalMediaRepository } from "../src/server/media";
import type { MovieConfig } from "../src/domain/services";
import { vehicleChoices } from "../src/catalog/vehicles";

const base = "http://127.0.0.1:3200";
const consent = { likeness: true, personalization: true };
function req(route: string, options: { cookie?: string; method?: string; body?: BodyInit; token?: string; origin?: string | null; headers?: HeadersInit } = {}): Request {
  const headers = new Headers({ host: "127.0.0.1:3200" });
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.origin !== null && options.method && options.method !== "GET") headers.set("origin", options.origin ?? base);
  new Headers(options.headers).forEach((value, key) => headers.set(key, value));
  return new Request(`${base}${route}`, { method: options.method, body: options.body, headers });
}
async function fixture(t: TestContext, includeCatalog = true) {
  const directory = path.resolve(".movie-data", "tests", `http-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const config: MovieConfig = {
    dataDir: directory, imageModel: "test-image", veoModel: "test-veo",
    openaiKey: "test-openai", visionModel: "test-vision", directorModel: "test-director", apiToken: "private-machine-token",
  };
  if (includeCatalog) {
    const catalog = path.join(directory, "catalog");
    await mkdir(catalog);
    const manifest = {
      id: "demo", version: 1, name: "Synthetic test product", make: null, model: null, exteriorColor: "red", interiorColor: "black",
      appearance: "Test shape", approvedClaims: [], usagePermission: "Only a synthetic automated test.",
      images: [{ file: "front.png", role: "front_three_quarter" }, { file: "interior.png", role: "interior" }],
    };
    await writeFile(path.join(catalog, "product.json"), JSON.stringify(manifest));
    await writeFile(path.join(catalog, "front.png"), await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).png().toBuffer());
    await writeFile(path.join(catalog, "interior.png"), await sharp({ create: { width: 4, height: 4, channels: 3, background: "black" } }).png().toBuffer());
  }
  const store = new JobStore(directory);
  const media = new LocalMediaRepository(directory);
  const handlers = createApiHandlers(config, { store, media, rendererReady: async () => ({ available: true, message: "Explicit test renderer." }) });
  const establish = async () => {
    const response = await handlers.config(req("/api/movie-config"));
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    return cookie.split(";")[0];
  };
  const photo = async (cookie?: string, token?: string) => {
    const form = new FormData();
    const bytes = await sharp({ create: { width: 5, height: 6, channels: 3, background: "blue" } }).png().toBuffer();
    form.append("photos", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "photo.png");
    form.append("consent", JSON.stringify(consent));
    return handlers.upload(req("/api/movie-assets", { cookie, token, method: "POST", body: form, origin: token ? null : base }));
  };
  return { config, directory, store, media, handlers, establish, photo };
}
function jobInput(id: string) {
  return {
    schema_version: 1, session_id: "robot-session", customer_reference_asset_ids: [id], primary_reference_asset_id: id,
    consent, product_id: "demo", personalization_profile: { signals: [] }, idempotency_key: randomUUID(),
  };
}
const jobRequest = (cookie: string, value: unknown) => req("/api/movie-jobs", {
  method: "POST", cookie, body: JSON.stringify(value), headers: { "content-type": "application/json" },
});

test("config DTO exposes the downloaded Toyota and Lexus catalog as ready", async t => {
  const { handlers } = await fixture(t, false);
  const response = await handlers.config(req("/api/movie-config"));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(Object.keys(data).sort(), ["products", "providers", "renderer", "templates", "worker"]);
  assert.equal(data.templates.length, 4);
  assert.deepEqual(data.products, vehicleChoices.map(({ id, name }) => ({ id, name, ready: true })));
  assert.equal(data.worker.available, false);
  assert.equal(data.renderer.message, "Explicit test renderer.");
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.match(response.headers.get("set-cookie")!, /HttpOnly/);
});

test("unknown hosts, DNS-rebinding domains, cross-origin and origin-less browser mutations fail closed", async t => {
  const { handlers, establish } = await fixture(t, false);
  const cookie = await establish();
  for (const host of ["attacker.example", "127.0.0.1.attacker.example", "localhost.attacker.example", "192.168.1.5:3200", "user@localhost:3200"]) {
    const response = await handlers.config(req("/api/movie-config", { headers: { host } }));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "UNTRUSTED_HOST");
  }
  assert.throws(() => validateHost(new Request("http://attacker.example", { headers: { host: "attacker.example" } })), /loopback/);
  assert.throws(() => validateHost(new Request(base)), /loopback/);
  const cross = await handlers.submit(req("/api/movie-jobs", { method: "POST", cookie, origin: "https://attacker.example", body: "{}" }));
  assert.equal(cross.status, 403);
  const missing = await handlers.submit(req("/api/movie-jobs", { method: "POST", cookie, origin: null, body: "{}" }));
  assert.equal(missing.status, 403);
  const read = await handlers.config(req("/api/movie-config", { headers: { origin: "null" } }));
  assert.equal(read.status, 403);
});

test("Next's normalized localhost URL honors the real loopback Host and browser Origin", async () => {
  const normalized = new Request("http://localhost:3200/api/movie-config", {
    headers: { host: "127.0.0.1:3200", origin: "http://127.0.0.1:3200" },
  });
  assert.equal(validateHost(normalized).origin, "http://127.0.0.1:3200");
  assert.throws(() => validateHost(new Request("http://localhost:3200/api/movie-config", {
    headers: { host: "127.0.0.1:3201", origin: "http://127.0.0.1:3201" },
  })), /loopback/);
  assert.throws(() => validateHost(new Request("http://localhost:3200/api/movie-config", {
    headers: { host: "127.0.0.1:3200", origin: "http://localhost:3200" },
  })), /Cross-origin/);
});

test("unguessable persisted sessions are not replaced by submitted owner/session identifiers", async t => {
  const { handlers, establish, photo } = await fixture(t);
  const first = await establish();
  const second = await establish();
  assert.notEqual(first, second);
  const upload = await photo(first);
  assert.equal(upload.status, 201);
  const asset = (await upload.json()).assets[0];
  assert.deepEqual(Object.keys(asset).sort(), ["height", "id", "mime", "width"]);
  const missingOwner = await handlers.getAsset(req(`/api/movie-assets/${asset.id}`), asset.id);
  assert.equal(missingOwner.status, 401);
  const forbidden = await handlers.getAsset(req(`/api/movie-assets/${asset.id}`, { cookie: second }), asset.id);
  assert.equal(forbidden.status, 404);
  const allowed = await handlers.getAsset(req(`/api/movie-assets/${asset.id}`, { cookie: first }), asset.id);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("content-type"), "image/jpeg");
  assert.ok((await allowed.arrayBuffer()).byteLength > 0);
  const forged = await handlers.getAsset(req(`/api/movie-assets/${asset.id}`, { cookie: `movie_session=${"a".repeat(64)}` }), asset.id);
  assert.equal(forged.status, 401);
  const withOwner = await handlers.submit(jobRequest(first, { ...jobInput(asset.id), ownerId: "someone-else" }));
  assert.equal(withOwner.status, 400);
});

test("bearer machine principal works without Origin and cannot read a browser principal's assets", async t => {
  const { config, handlers, photo, establish } = await fixture(t);
  const uploaded = await photo(undefined, config.apiToken);
  assert.equal(uploaded.status, 201);
  const asset = (await uploaded.json()).assets[0];
  const own = await handlers.getAsset(req(`/api/movie-assets/${asset.id}`, { token: config.apiToken }), asset.id);
  assert.equal(own.status, 200);
  await own.arrayBuffer();
  const cookie = await establish();
  assert.equal((await handlers.getAsset(req(`/api/movie-assets/${asset.id}`, { cookie }), asset.id)).status, 404);
  assert.equal((await handlers.getAsset(req(`/api/movie-assets/${asset.id}`, { token: "wrong" }), asset.id)).status, 401);
  assert.equal((await handlers.config(req("/api/movie-config", { token: config.apiToken, headers: { host: "remote.example" } }))).status, 403);
  assert.equal((await handlers.config(req("/api/movie-config", { token: config.apiToken }))).headers.get("set-cookie"), null);
});

test("job API checks references and worker readiness, freezes product, returns DTOs and handles idempotent retries", async t => {
  const { config, handlers, photo, establish, store, media } = await fixture(t);
  const cookie = await establish();
  const other = await establish();
  const uploaded = await photo(cookie);
  const asset = (await uploaded.json()).assets[0];
  const input = jobInput(asset.id);
  const inactive = await handlers.submit(jobRequest(cookie, input));
  assert.equal(inactive.status, 503);
  assert.equal((await inactive.json()).code, "WORKER_NOT_READY");
  assert.equal((await store.list()).length, 0);
  const token = await store.acquireWorker();
  try {
    const unowned = await handlers.submit(jobRequest(other, input));
    assert.equal(unowned.status, 404);
    const created = await handlers.submit(jobRequest(cookie, input));
    assert.equal(created.status, 202);
    const accepted = await created.json();
    assert.deepEqual(Object.keys(accepted).sort(), ["job_id", "status", "status_url"]);
    assert.equal(accepted.status_url, `/api/movie-jobs/${accepted.job_id}`);
    const job = await store.get(accepted.job_id);
    assert.equal(job.request.preferred_template, "DREAM_ROUTE");
    assert.equal(job.product.referenceImages.length, 2);
    assert.notEqual(job.ownerId, input.session_id);
    assert.equal((await handlers.getJob(req(accepted.status_url, { cookie: other }), job.id)).status, 404);
    const response = await handlers.getJob(req(accepted.status_url, { cookie }), job.id);
    const view = (await response.json()).job;
    assert.equal(view.sessionId, input.session_id);
    assert.equal(view.ownerId, undefined);
    assert.equal(view.request, undefined);
    assert.equal(view.operations, undefined);
    const retry = await handlers.submit(jobRequest(cookie, input));
    assert.equal((await retry.json()).job_id, accepted.job_id);
    const conflict = await handlers.submit(jobRequest(cookie, { ...input, session_id: "changed" }));
    assert.equal(conflict.status, 409);
    const activeDelete = await handlers.deleteJob(req(accepted.status_url, { cookie, method: "DELETE" }), job.id);
    assert.equal(activeDelete.status, 409);
    await store.update(job.id, current => { current.status = "FAILED"; });
    assert.equal((await handlers.deleteJob(req(accepted.status_url, { cookie: other, method: "DELETE" }), job.id)).status, 404);
    assert.equal((await handlers.deleteJob(req(accepted.status_url, { cookie, method: "DELETE" }), job.id)).status, 204);
    await assert.rejects(media.getAsset(asset.id), /not found/);
    assert.equal((await handlers.getJob(req(accepted.status_url, { cookie }), job.id)).status, 404);
    assert.ok(config.dataDir);
  } finally { await store.releaseWorker(token); }
});

test("duplicate photos uploaded in separate requests and invalid JSON/primary references cannot queue jobs", async t => {
  const { handlers, photo, establish, store } = await fixture(t);
  const cookie = await establish();
  const first = (await (await photo(cookie)).json()).assets[0];
  const second = (await (await photo(cookie)).json()).assets[0];
  const input = jobInput(first.id);
  const duplicate = await handlers.submit(jobRequest(cookie, { ...input, customer_reference_asset_ids: [first.id, second.id] }));
  assert.equal(duplicate.status, 400);
  assert.equal((await duplicate.json()).code, "DUPLICATE_PHOTO");
  assert.equal((await handlers.submit(jobRequest(cookie, { ...input, primary_reference_asset_id: randomUUID() }))).status, 400);
  const malformed = await handlers.submit(req("/api/movie-jobs", {
    cookie, method: "POST", body: "{broken", headers: { "content-type": "application/json" },
  }));
  assert.equal(malformed.status, 400);
  const giant = await handlers.submit(req("/api/movie-jobs", {
    cookie, method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json", "content-length": "65537" },
  }));
  assert.equal(giant.status, 413);
  assert.equal((await store.list()).length, 0);
});

test("video GET is owner-authorized and supports single, suffix, open-ended and invalid byte ranges", async t => {
  const { config, media, handlers, establish } = await fixture(t, false);
  const cookie = await establish();
  const { ownerId } = await new SessionAuth(config).authenticate(req("/", { cookie }));
  const asset = await media.saveAsset({ ownerId, jobId: randomUUID(), kind: "video", mime: "video/mp4", bytes: new TextEncoder().encode("0123456789") });
  for (const [range, expected, contentRange] of [
    ["bytes=2-5", "2345", "bytes 2-5/10"], ["bytes=-3", "789", "bytes 7-9/10"], ["bytes=7-", "789", "bytes 7-9/10"],
    ["bytes=7-999", "789", "bytes 7-9/10"],
  ]) {
    const result = await handlers.getAsset(req(`/api/movie-assets/${asset.id}`, { cookie, headers: { range } }), asset.id);
    assert.equal(result.status, 206);
    assert.equal(result.headers.get("content-range"), contentRange);
    assert.equal(await result.text(), expected);
  }
  for (const range of ["bytes=99-", "bytes=2-1", "bytes=0-1,4-5", "bytes=-0", "bytes=-", "garbage", "bytes=9007199254740992-"]) {
    const response = await handlers.getAsset(req(`/api/movie-assets/${asset.id}`, { cookie, headers: { range } }), asset.id);
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("content-range"), "bytes */10");
    assert.equal((await response.json()).code, "INVALID_RANGE");
  }
  assert.deepEqual(parseRange("bytes=-100", 10), { start: 0, end: 9 });
  assert.throws(() => parseRange("bytes=0-", 0), /not available/);
});
