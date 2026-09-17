import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ShowroomClient, ShowroomClientError } from "../integration/showroom-client";
import { ShowroomSnapshotSchema } from "../../FinalProject/src/contracts/showroom";
import type { StudioStatus } from "../../FinalProject/src/contracts/showroom";

const examples = JSON.parse(await readFile(new URL("../integration/dwight/showroom-v1/examples.json", import.meta.url), "utf8"));
const id = "11111111-1111-4111-8111-111111111111";
const capability = { sessionId: id, serverInstanceId: id, sessionToken: "session-capability-only-in-memory", expiresAt: 1_800_000_300_000 };
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

test("client has a fixed same-origin gateway, bounded code pairing, and memory-only authorization", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new ShowroomClient(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return String(url).endsWith("/pair") ? json(capability) : json(examples.ShowroomSnapshotSchema);
  });
  await client.exchange(" abcd1234 ");
  assert.equal(calls[0].url, "/api/showroom/v1/kiosk/pair");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { pairingCode: "ABCD1234" });
  assert.equal(new Headers(calls[0].init.headers).has("Authorization"), false);
  client.join(capability); await client.snapshot();
  assert.equal(calls[1].url, `/api/showroom/v1/sessions/${id}/showroom`);
  assert.equal(new Headers(calls[1].init.headers).get("Authorization"), `Bearer ${capability.sessionToken}`);
  assert.equal(calls[1].init.redirect, "error");
  assert.equal(calls[1].init.credentials, "omit");
  client.forget();
  assert.throws(() => client.snapshot(), /Pair/);
  assert.throws(() => client.exchange("https://untrusted.test"), /string|pattern|Invalid/i);
});

test("raw normalized references use exact stable event/revision query and no multipart body", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const client = new ShowroomClient(async (url, init = {}) => {
    captured = { url: String(url), init };
    return json({ assetId: id, snapshot: examples.ShowroomSnapshotSchema });
  });
  client.join(capability);
  const photo = new Blob(["photo"], { type: "image/jpeg" }), eventId = randomUUID();
  await client.upload(photo, { expectedRevision: 3, eventId });
  assert.equal(captured!.url, `/api/showroom/v1/sessions/${id}/showroom/references?expectedRevision=3&eventId=${eventId}`);
  assert.equal(captured!.init.body, photo);
  assert.equal(new Headers(captured!.init.headers).get("Content-Type"), "image/jpeg");
  assert.throws(() => client.upload(new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "image/jpeg" }), { expectedRevision: 3, eventId }), /5 MiB/);
  assert.throws(() => client.upload(new Blob(["x"], { type: "image/webp" }), { expectedRevision: 3, eventId }), /JPEG or PNG/);
});

test("voice uses canonical Live SDP response and stale-safe generation DELETE", async () => {
  const calls: RequestInit[] = [];
  const client = new ShowroomClient(async (_url, init = {}) => {
    calls.push(init);
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return json({ sessionId: id, generation: 42, session: { id: "live-run" }, transport: { type: "webrtc", sdp: "v=0\r\n" } });
  });
  client.join(capability);
  const setup = await client.voice("v=0\r\n", 42);
  assert.equal(setup.transport.type, "webrtc");
  assert.deepEqual(JSON.parse(String(calls[0].body)), { sdp: "v=0\r\n", generation: 42 });
  await client.terminateVoice(42);
  assert.deepEqual(JSON.parse(String(calls[1].body)), { generation: 42 });
});

test("movie bytes must match authorized MIME, exact length and checksum", async () => {
  const result: Extract<StudioStatus, { status: "ready" }> = {
    status: "ready", snapshotId: id, jobId: id, assetId: id, mimeType: "video/mp4", durationSeconds: 1,
    provenance: "generated", byteLength: 5, checksum: createHash("sha256").update("movie").digest("hex"),
  };
  const client = new ShowroomClient(async () => new Response("movie", { headers: { "Content-Type": "video/mp4", "Content-Length": "5" } }));
  client.join(capability);
  assert.equal(await (await client.movie(result)).text(), "movie");
  await assert.rejects(client.movie({ ...result, checksum: "f".repeat(64) }), /integrity/);
  await assert.rejects(client.movie({ ...result, byteLength: 4 }), /limit|length/);
  const invalid = new ShowroomClient(async () => new Response("movie", { headers: { "Content-Type": "text/html" } }));
  invalid.join(capability);
  await assert.rejects(invalid.movie(result), /MP4/);
});

test("invalid server data and errors never echo remote capabilities into the UI", async () => {
  const malformed = new ShowroomClient(async () => json({ sessionToken: "secret" }));
  malformed.join(capability);
  await assert.rejects(malformed.snapshot(), /invalid response/);
  const failed = new ShowroomClient(async () => new Response(JSON.stringify({ error: { code: "REVISION_CONFLICT", message: capability.sessionToken } }), { status: 409 }));
  failed.join(capability);
  await assert.rejects(failed.snapshot(), error => {
    assert.ok(error instanceof ShowroomClientError);
    assert.equal(error.status, 409);
    assert.equal(error.message.includes(capability.sessionToken), false);
    return true;
  });
});

test("Stop uses keepalive and survives an already-aborted ordinary action signal", async () => {
  let init: RequestInit | undefined;
  const client = new ShowroomClient(async (_url, input) => { init = input; return json(ShowroomSnapshotSchema.parse(examples.ShowroomSnapshotSchema)); });
  client.join(capability);
  const signal = AbortSignal.abort();
  await client.action({ schemaVersion: 1, eventId: randomUUID(), expectedRevision: 3, type: "stop_requested", payload: { reason: "disconnect" } }, signal);
  assert.equal(init!.keepalive, true);
  assert.equal(init!.signal?.aborted, false);
});
