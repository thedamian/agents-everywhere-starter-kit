import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import sharp from "sharp";
import examples from "../integration/dwight/examples.json";
import type { MediaSubmitRequest } from "../integration/dwight/types";
import { decodeParticipantImage, parseSubmission } from "../src/media-service/contracts";
import type { MediaExecutor } from "../src/media-service/executor";
import { createLiveExecutor } from "../src/media-service/executor";
import { createMediaHttpServer } from "../src/media-service/http";
import { escapeSvg, generateSample, sceneFrames, validateMp4 } from "../src/media-service/render";
import { MediaService, type ServiceOptions } from "../src/media-service/service";
import { runDurableMediaCommand, settleMediaProcesses } from "../src/media-service/process";

const root = path.resolve(`.media-tests-${randomUUID().slice(0, 8)}`);
const sample = path.join(root, "sample.mp4");
const token = "server-only-test-media-token";
before(async () => {
  await mkdir(root, { recursive: true });
  await generateSample(sample);
});
after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

function request(): MediaSubmitRequest {
  const value = structuredClone(examples.mediaSubmission) as MediaSubmitRequest;
  value.jobId = value.idempotencyKey = randomUUID();
  return value;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until<T>(get: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await get();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for test state");
}
async function fixture(executor?: MediaExecutor, overrides: Partial<ServiceOptions> = {}) {
  const directory = path.join(root, randomUUID().slice(0, 8));
  let calls = 0;
  const options: ServiceOptions = {
    directory, executor: executor ?? {
      ready: async () => true,
      execute: async context => { calls++; await copyFile(sample, context.output); },
    }, ...overrides,
  };
  const service = new MediaService(options);
  await service.start();
  const server = createMediaHttpServer(service, token);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const send = (target: string, init: RequestInit = {}) =>
    fetch(`${base}${target}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  const submit = (value: MediaSubmitRequest, key = value.jobId) => send("/jobs", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(value),
  });
  return {
    service, options, directory, base, send, submit, calls: () => calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await service.close();
    },
  };
}

test("authenticated exact capabilities, job acceptance, MIME and real six-second MP4", async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.base}/capabilities`)).status, 401);
    assert.equal((await f.send("/capabilities", { headers: { Authorization: "Bearer wrong" } })).status, 401);
    assert.deepEqual(await (await f.send("/capabilities")).json(), { schemaVersion: 1, cancelByKey: true, deleteAssets: true });
    const input = request();
    const accepted = await f.submit(input);
    assert.equal(accepted.status, 202);
    const { providerJobId } = await accepted.json() as { providerJobId: string };
    assert.equal(providerJobId, `render-${input.jobId}`);
    const ready = await until(() => f.service.status(providerJobId), state => state.status === "ready");
    assert.deepEqual(ready, { status: "ready", result: {
      assetPath: `assets/${providerJobId}.mp4`, mimeType: "video/mp4", durationSeconds: 6,
    } });
    const asset = await f.send(`/assets/${providerJobId}.mp4`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("content-type"), "video/mp4");
    assert.equal(asset.headers.get("location"), null);
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), await readFile(sample));
    assert.equal((await fetch(`${f.base}/assets/${providerJobId}.mp4`)).status, 401);
    assert.equal((await f.send("/assets/%2e%2e%2fsecret.mp4")).status, 404);
    assert.equal(f.calls(), 1);
    assert.equal(await validateMp4(sample, 6), 6);
  } finally { await f.close(); }
});

test("missing live credentials returns 503 before participant submission; no mock fallback", async () => {
  const f = await fixture(createLiveExecutor({}));
  try {
    assert.equal((await f.send("/capabilities")).status, 503);
    assert.equal((await f.submit(request())).status, 503);
    assert.deepEqual(await readdir(path.join(f.directory, "receipts")), []);
    assert.deepEqual(await readdir(path.join(f.directory, "work")), []);
  } finally { await f.close(); }
});

test("cancel-before-POST tombstones a global UUID and delayed/restarted POST cannot resurrect it", async () => {
  const f = await fixture();
  const input = request();
  try {
    const deleted = await f.send(`/jobs/by-key/${input.jobId}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { status: "cancelled", assetsDeleted: true });
    assert.equal((await f.submit(input)).status, 409);
    assert.equal((await f.send(`/jobs/by-key/${input.jobId}`, { method: "DELETE" })).status, 200);
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
  const restarted = new MediaService({
    directory: f.directory, executor: { ready: async () => true, execute: async () => assert.fail("Paid retry") },
  });
  await restarted.start();
  try {
    await assert.rejects(restarted.submit(input), { code: "JOB_CANCELLED" });
    assert.deepEqual(await restarted.cancel(input.jobId), { status: "cancelled", assetsDeleted: true });
  } finally { await restarted.close(); }
});

test("canonical payload dedup and changed payload conflict survive restart without paid retry", async () => {
  const f = await fixture();
  const input = request();
  let id = "";
  try {
    const responses = await Promise.all(Array.from({ length: 5 }, () => f.submit(input)));
    assert.ok(responses.every(response => response.status === 202));
    const ids = await Promise.all(responses.map(response => response.json() as Promise<{ providerJobId: string }>));
    id = ids[0].providerJobId;
    assert.ok(ids.every(value => value.providerJobId === id));
    const reordered = Object.fromEntries(Object.entries(input).reverse()) as MediaSubmitRequest;
    assert.equal((await f.submit(reordered)).status, 202);
    const changed = structuredClone(input);
    changed.brief.callToAction = "A different CTA";
    assert.equal((await f.submit(changed)).status, 409);
    await until(() => f.service.status(id), value => value.status === "ready");
    assert.equal(f.calls(), 1);
  } finally { await f.close(); }
  let retried = false;
  const service = new MediaService({ directory: f.directory, executor: {
    ready: async () => true, execute: async () => { retried = true; },
  } });
  await service.start();
  try {
    assert.deepEqual(await service.submit(input), { providerJobId: id });
    assert.equal((await service.status(id)).status, "ready");
    assert.equal(retried, false);
    await service.cancel(input.jobId);
    const receipt = await readFile(path.join(f.directory, "receipts", `${input.jobId}.json`), "utf8");
    assert.ok(!receipt.includes(input.brief.objective));
    assert.ok(!receipt.includes(input.image.base64));
    assert.ok(!receipt.includes(input.brief.sessionId));
    assert.deepEqual(await readdir(path.join(f.directory, "work")), []);
  } finally { await service.close(); }
});

test("header and body IDs must match exactly; strict brief, duration and image validation", async () => {
  const f = await fixture();
  try {
    const input = request();
    assert.equal((await f.submit(input, randomUUID())).status, 400);
    assert.equal((await f.submit({ ...input, idempotencyKey: randomUUID() })).status, 400);
    assert.equal((await f.submit({ ...input, extra: "not allowed" } as MediaSubmitRequest)).status, 400);
    const duration = structuredClone(input);
    duration.brief.durationSeconds = 18;
    assert.equal((await f.submit(duration)).status, 400);
    const template = structuredClone(input);
    (template.brief as unknown as { templateId: string }).templateId = "unsupported-template";
    assert.equal((await f.submit(template)).status, 400);
    const mime = structuredClone(input);
    mime.image.mimeType = "image/jpeg";
    assert.equal((await f.submit(mime)).status, 400);
    assert.equal((await f.submit({ ...input, image: { ...input.image, base64: "not base64" } })).status, 400);
    const invalid = Buffer.from("not a real image").toString("base64");
    assert.equal((await f.submit({ ...input, image: { ...input.image, base64: invalid } })).status, 400);
    assert.throws(() => parseSubmission(input, input.jobId.toUpperCase()), { code: "INVALID_SUBMISSION" });
    assert.equal(f.calls(), 0);
    assert.deepEqual(await readdir(path.join(f.directory, "work")), []);
  } finally { await f.close(); }
});

test("normalization strips metadata and checks actual PNG/JPEG rather than claimed MIME", async () => {
  const original = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#426080" } })
    .jpeg().withExif({ IFD0: { Artist: "private participant metadata" } }).toBuffer();
  assert.ok((await sharp(original).metadata()).exif);
  const normalized = await decodeParticipantImage({ mimeType: "image/jpeg", base64: original.toString("base64") });
  assert.equal((await sharp(normalized).metadata()).exif, undefined);
  assert.equal((await sharp(normalized).metadata()).format, "jpeg");
  await assert.rejects(decodeParticipantImage({ mimeType: "image/png", base64: original.toString("base64") }));
});

test("active cancellation waits for executor settlement, deletes late files and retains no PII", async () => {
  const started = deferred();
  const aborted = deferred();
  const release = deferred();
  let work = "";
  const f = await fixture({
    ready: async () => true,
    execute: async context => {
      work = context.directory;
      started.resolve();
      await new Promise<void>(resolve => {
        if (context.signal.aborted) resolve();
        else context.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      aborted.resolve();
      await release.promise;
      // Simulates a decoder/provider completing its last write while cancellation is settling.
      await writeFile(path.join(context.directory, "late-private-image"), "private participant data");
    },
  });
  try {
    const input = request();
    assert.equal((await f.submit(input)).status, 202);
    await started.promise;
    let completed = false;
    const cancel = f.send(`/jobs/by-key/${input.jobId}`, { method: "DELETE" }).then(response => { completed = true; return response; });
    await aborted.promise;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(completed, false);
    assert.equal((await f.submit(input)).status, 409);
    release.resolve();
    const response = await cancel;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "cancelled", assetsDeleted: true });
    await assert.rejects(readdir(work), { code: "ENOENT" });
    const persisted = await readFile(path.join(f.directory, "receipts", `${input.jobId}.json`), "utf8");
    assert.equal(JSON.parse(persisted).cleanup, "deleted");
    assert.ok(!persisted.includes("private participant"));
    assert.ok(!persisted.includes("brief"));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(await readdir(path.join(f.directory, "work")), []);
  } finally { release.resolve(); await f.close(); }
});

test("cleanup failure cannot claim assetsDeleted; receipt is pending until independent retry succeeds", async () => {
  let fail = true;
  const f = await fixture(undefined, { removeWork: async (directory, signal) => {
    assert.equal(signal.aborted, false);
    if (fail) throw new Error("sensitive vendor log must not escape");
    await rm(directory, { recursive: true, force: true });
  } });
  try {
    const input = request();
    await f.submit(input);
    await until(() => f.service.status(`render-${input.jobId}`), value => value.status === "ready");
    const failed = await f.send(`/jobs/by-key/${input.jobId}`, { method: "DELETE" });
    assert.equal(failed.status, 503);
    const text = await failed.text();
    assert.ok(!text.includes("assetsDeleted"));
    assert.ok(!text.includes("sensitive"));
    const receipt = JSON.parse(await readFile(path.join(f.directory, "receipts", `${input.jobId}.json`), "utf8"));
    assert.equal(receipt.status, "cancelled");
    assert.equal(receipt.cleanup, "pending");
    assert.equal((await f.send(`/assets/render-${input.jobId}.mp4`)).status, 404);
    fail = false;
    assert.deepEqual(await f.service.cancel(input.jobId), { status: "cancelled", assetsDeleted: true });
    assert.deepEqual(await readdir(path.join(f.directory, "work")), []);
  } finally { fail = false; await f.close(); }
});

test("timed-out cancellation retains a tombstone and only acknowledges after a later settled cleanup", async () => {
  const started = deferred();
  const released = deferred();
  const f = await fixture({
    ready: async () => true,
    execute: async context => {
      started.resolve();
      await released.promise;
      await writeFile(path.join(context.directory, "late.txt"), "private");
    },
  }, { cleanupTimeoutMs: 100 });
  try {
    const input = request();
    await f.submit(input);
    await started.promise;
    const failed = await f.send(`/jobs/by-key/${input.jobId}`, { method: "DELETE" });
    assert.equal(failed.status, 503);
    assert.ok(!(await failed.text()).includes("assetsDeleted"));
    assert.equal((await f.submit(input)).status, 409);
    // The first deadline tests timeout behavior, not the filesystem speed of
    // the subsequent successful cleanup under concurrent encoder load.
    f.options.cleanupTimeoutMs = 30_000;
    released.resolve();
    assert.deepEqual(await f.service.cancel(input.jobId), { status: "cancelled", assetsDeleted: true });
    assert.deepEqual(await readdir(path.join(f.directory, "work")), []);
  } finally { released.resolve(); await f.close(); }
});

test("restart fails interrupted jobs, scrubs work, preserves dedup receipt and takes a single worker lease", async () => {
  const f = await fixture();
  const input = request();
  try {
    const competing = new MediaService({ directory: f.directory, executor: { ready: async () => true, execute: async () => {} } });
    await assert.rejects(competing.start(), { code: "WORKER_ALREADY_RUNNING" });
    await f.submit(input);
    await until(() => f.service.status(`render-${input.jobId}`), value => value.status === "ready");
  } finally { await f.close(); }
  const filename = path.join(f.directory, "receipts", `${input.jobId}.json`);
  const receipt = JSON.parse(await readFile(filename, "utf8"));
  receipt.status = "running";
  await writeFile(filename, JSON.stringify(receipt));
  let calls = 0;
  const restarted = new MediaService({ directory: f.directory, executor: {
    ready: async () => true, execute: async () => { calls++; },
  } });
  await restarted.start();
  try {
    assert.deepEqual(await restarted.status(`render-${input.jobId}`), { status: "failed" });
    assert.deepEqual(await restarted.submit(input), { providerJobId: `render-${input.jobId}` });
    assert.deepEqual(await readdir(path.join(f.directory, "work")), []);
    assert.equal(calls, 0);
  } finally { await restarted.close(); }
});

test("queued cancellation never invokes the executor; worker stays serial", async () => {
  const firstStarted = deferred();
  const release = deferred();
  let count = 0;
  const f = await fixture({ ready: async () => true, execute: async context => {
    count++;
    firstStarted.resolve();
    await release.promise;
    context.signal.throwIfAborted();
    await copyFile(sample, context.output);
  } });
  try {
    const first = request();
    const second = request();
    await f.submit(first);
    await firstStarted.promise;
    await f.submit(second);
    assert.equal((await f.service.status(`render-${second.jobId}`)).status, "queued");
    await f.service.cancel(second.jobId);
    release.resolve();
    await until(() => f.service.status(`render-${first.jobId}`), value => value.status === "ready");
    assert.equal(count, 1);
  } finally { release.resolve(); await f.close(); }
});

test("fake MP4 output fails validation and no unpaid ready result is exposed", async () => {
  const f = await fixture({
    ready: async () => true, execute: async context => { await writeFile(context.output, "fake mp4"); },
  });
  try {
    const input = request();
    await f.submit(input);
    await until(() => f.service.status(`render-${input.jobId}`), value => value.status === "failed");
    assert.equal((await f.send(`/assets/render-${input.jobId}.mp4`)).status, 404);
    assert.deepEqual(await readdir(path.join(f.directory, "work")), []);
  } finally { await f.close(); }
});

test("scene frame counts follow variable brief duration, not a fixed 18-second plan", () => {
  const brief = request().brief;
  brief.scenes[0].durationSeconds = 1.1;
  brief.scenes[1].durationSeconds = 2.2;
  brief.durationSeconds = 3.3;
  assert.deepEqual(sceneFrames(brief), [26, 53]);
  assert.equal(sceneFrames(brief).reduce((sum, count) => sum + count, 0), Math.round(3.3 * 24));
  assert.throws(() => sceneFrames({ ...brief, scenes: [{ ...brief.scenes[0], durationSeconds: 0.001 }] }),
    { code: "SCENE_SHORTER_THAN_FRAME" });
});

test("aborting a native encoder waits for its process exit before cleanup", async () => {
  const directory = path.join(root, "process-abort");
  await mkdir(directory);
  const output = path.join(directory, "writing.txt");
  const signal = new AbortController();
  const started = runDurableMediaCommand(process.execPath, ["-e",
    `const fs = require('node:fs'); setInterval(() => fs.appendFileSync(${JSON.stringify(output)}, 'x'), 20);`,
  ], directory, signal.signal);
  const failure = assert.rejects(started);
  await until(() => readFile(output).catch(() => Buffer.alloc(0)), data => data.length > 0);
  signal.abort();
  await failure;
  await settleMediaProcesses(directory, AbortSignal.timeout(5000));
  const before = await readFile(output);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(await readFile(output), before);
  assert.ok(!(await readdir(directory)).some(name => name.startsWith(".media-process-")));
});

test("HTTP process crash disconnects and reaps orphan encoder before restart cleanup", async () => {
  const directory = path.join(root, "process-crash");
  await mkdir(directory);
  const output = path.join(directory, "writing.txt");
  const module = pathToFileURL(path.resolve("src", "media-service", "process.ts")).href;
  const code = `const fs = require('node:fs'); setInterval(() => fs.appendFileSync(${JSON.stringify(output)}, 'x'), 20);`;
  const parent = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import { runDurableMediaCommand } from ${JSON.stringify(module)};
     await runDurableMediaCommand(process.execPath, ${JSON.stringify(["-e", code])}, ${JSON.stringify(directory)}, new AbortController().signal);`,
  ], { stdio: "ignore", windowsHide: true });
  const exited = new Promise<void>(resolve => parent.once("exit", () => resolve()));
  try {
    await until(() => readFile(output).catch(() => Buffer.alloc(0)), data => data.length > 0);
    parent.kill("SIGKILL");
    await exited;
    await settleMediaProcesses(directory, AbortSignal.timeout(5000));
    await rm(directory, { recursive: true, force: true });
    await new Promise(resolve => setTimeout(resolve, 100));
    await assert.rejects(readdir(directory), { code: "ENOENT" });
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    await exited;
  }
});

test("live adapter sends consented image and every scene to image edits; overlays copy/CTA using rasterized escaped SVG", async () => {
  const directory = path.join(root, "live-transport-stub");
  await mkdir(directory);
  const submission = request();
  const input = path.join(directory, "participant.jpg");
  const output = path.join(directory, "synthetic-transport-test.mp4");
  await writeFile(input, await decodeParticipantImage(submission.image));
  const syntheticFrame = await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#365f80" } }).png().toBuffer();
  const prompts: string[] = [];
  const stages: string[] = [];
  const executor = createLiveExecutor({
    apiKey: "test-only-not-a-real-key",
    fetch: async (resource, init) => {
      if (resource === "data:,") return new Response("");
      const req = new Request(resource, init);
      assert.equal(req.url, "https://api.openai.com/v1/images/edits");
      const form = await req.formData();
      prompts.push(String(form.get("prompt")));
      assert.equal(form.get("n"), "1");
      const image = form.get("image") ?? form.get("image[]");
      assert.ok(image instanceof File);
      assert.equal(image.type, "image/jpeg");
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), await readFile(input));
      return Response.json({ created: 1, data: [{ b64_json: syntheticFrame.toString("base64") }] });
    },
  });
  await executor.execute({
    directory, input, output, brief: submission.brief, signal: new AbortController().signal,
    progress: async stage => { stages.push(stage); },
  });
  assert.equal(prompts.length, 2);
  for (let index = 0; index < 2; index++) {
    assert.ok(prompts[index].includes(submission.brief.scenes[index].visual));
    assert.ok(prompts[index].includes(submission.brief.scenes[index].onScreenText));
    assert.ok(prompts[index].includes(submission.brief.audiencePreferences[0]));
    assert.ok(prompts[index].includes(submission.brief.callToAction));
    assert.ok(prompts[index].includes("original unbranded concept vehicle"));
  }
  assert.ok(stages.includes("generating") && stages.includes("encoding") && stages.includes("finalizing"));
  assert.equal(await validateMp4(output, 6), 6);
  const finalCopy = await sharp(path.join(directory, "frame-1.png")).extract({ left: 30, top: 610, width: 1180, height: 100 }).stats();
  assert.ok(finalCopy.channels.some(channel => channel.stdev > 30), "Visible raster text must contrast against its background");
  assert.equal(escapeSvg('<image href="https://invalid"/>&'), "&lt;image href=&quot;https://invalid&quot;/&gt;&amp;");
});

test("provider failure is sanitized and never automatically retried or replaced with a fake frame", async () => {
  let calls = 0;
  const executor = createLiveExecutor({
    apiKey: "test-only-not-a-real-key",
    fetch: async resource => {
      if (resource === "data:,") return new Response("");
      calls++;
      return new Response("private provider diagnostic", { status: 429 });
    },
  });
  const directory = path.join(root, "failed-transport");
  await mkdir(directory);
  const input = path.join(directory, "participant.jpg");
  await writeFile(input, await decodeParticipantImage(request().image));
  await assert.rejects(executor.execute({
    directory, input, output: path.join(directory, "missing.mp4"), brief: request().brief,
    signal: new AbortController().signal, progress: async () => {},
  }), { code: "IMAGE_GENERATION_FAILED", message: "IMAGE_GENERATION_FAILED" });
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(directory), ["participant.jpg"]);
});
