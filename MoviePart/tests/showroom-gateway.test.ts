import assert from "node:assert/strict";
import test from "node:test";
import { showroomGateway, type ShowroomGatewayOptions } from "../src/server/showroom-gateway";

const origin = "https://kiosk.example.test";
const base = `${origin}/api/showroom`;
const snapshot = "/v1/sessions/session-1/showroom";
const actions = `${snapshot}/actions`;
const asset = "/v1/sessions/session-1/assets/film-1";
const authorization = "Bearer session-capability";
const eventQuery = "&eventId=550e8400-e29b-41d4-a716-446655440000";
const options: ShowroomGatewayOptions = { publicOrigin: origin };
function request(path = snapshot, init: RequestInit = {}) {
  return new Request(`${base}${path}`, {
    ...init, headers: { Authorization: authorization, Origin: origin, ...Object.fromEntries(new Headers(init.headers)) },
  });
}
function success(value = { revision: 1 }) { return Response.json(value); }

test("one-time pairing exchange does not forward a master token or require a session credential", async () => {
  const response = await showroomGateway(new Request(`${base}/v1/kiosk/pair`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Authorization: "Bearer must-not-forward" },
    body: JSON.stringify({ pairingCode: "ABCD1234" }),
  }), {
    ...options, fetch: async (url, init) => {
      assert.ok(url.endsWith("/v1/kiosk/pair"));
      assert.equal(new Headers(init.headers).get("authorization"), null);
      return Response.json({ sessionId: "session-1", sessionToken: "session-scoped-only", serverInstanceId: "server-1", expiresAt: 1 });
    },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sessionToken, "session-scoped-only");
});

test("voice uses the real SDP exchange unchanged and supports explicit teardown", async () => {
  const body = JSON.stringify({ sdp: "v=0\r\n", generation: 1 });
  const response = await showroomGateway(request(`${snapshot}/voice`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  }), {
    ...options, fetch: async (_url, init) => {
      assert.equal(Buffer.from(init.body as Uint8Array).toString(), body);
      return Response.json({ session: { id: "live-1" }, transport: { type: "webrtc", sdp: "answer" } });
    },
  });
  assert.equal((await response.json()).transport.sdp, "answer");
  const closed = await showroomGateway(request(`${snapshot}/voice`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ generation: 1 }),
  }), {
    ...options, fetch: async (_url, init) => {
      assert.equal(Buffer.from(init.body as Uint8Array).toString(), '{"generation":1}');
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(closed.status, 204);
  assert.equal((await showroomGateway(request(`${snapshot}/voice`, { method: "DELETE" }), options)).status, 415);
});

test("voice permits canonical SDP above the ordinary JSON cap but bounds its encoded envelope", async () => {
  const sdp = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" +
    "a=candidate:1 1 UDP 2122260223 192.0.2.1 10000 typ host\r\n".repeat(1200);
  assert.ok(Buffer.byteLength(sdp) > 16_384 && Buffer.byteLength(sdp) <= 131_072);
  const payload = JSON.stringify({ sdp, generation: 1 });
  const response = await showroomGateway(request(`${snapshot}/voice`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: payload,
  }), {
    ...options, fetch: async (_url, init) => {
      assert.equal(Buffer.from(init.body as Uint8Array).toString(), payload);
      return Response.json({ session: { id: "live-1" }, transport: { type: "webrtc", sdp } });
    },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).transport.sdp, sdp);
  const oversized = await showroomGateway(request(`${snapshot}/voice`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sdp: "x".repeat(1_048_576) }),
  }), { ...options, fetch: async () => assert.fail("oversize voice envelope forwarded") });
  assert.equal(oversized.status, 413);
  const escaped = JSON.stringify({ transport: { type: "webrtc", sdp: "\u0001".repeat(131_072) } });
  assert.ok(Buffer.byteLength(escaped) > 524_288 && Buffer.byteLength(escaped) < 1_048_576);
  const largeAnswer = await showroomGateway(request(`${snapshot}/voice`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: payload,
  }), { ...options, fetch: async () => new Response(escaped, { headers: { "Content-Type": "application/json" } }) });
  assert.equal(await largeAnswer.text(), escaped);
});

test("gateway forwards canonical JSON and only necessary headers to its fixed upstream", async () => {
  const bytes = '{ "eventId": "event-1", "expectedRevision": 0, "action": {"type":"begin"} }';
  const response = await showroomGateway(request(actions, {
    method: "POST", body: bytes, headers: {
      "Content-Type": "application/json", Cookie: "admin=secret", "X-Forwarded-Host": "evil.test",
      Host: "evil.test", "X-Api-Key": "secret", "Proxy-Authorization": "secret",
    },
  }), {
    ...options, fetch: async (url, init) => {
      assert.equal(url, "http://127.0.0.1:3101/v1/sessions/session-1/showroom/actions");
      assert.deepEqual(Object.fromEntries(new Headers(init.headers)), {
        authorization, origin, "content-type": "application/json",
      });
      assert.equal(Buffer.from(init.body as Uint8Array).toString(), bytes);
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "manual");
      assert.equal(init.cache, "no-store");
      return success();
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revision: 1 });
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("gateway denies arbitrary, encoded, operator and unknown paths before calling upstream", async () => {
  for (const path of [
    "/https://evil.test", "/v1/sessions", "/v1/operator/bootstrap", "/v1/bridge/control",
    "/v1/sessions/session-1/commands/start_media_job", "/v1/sessions/session-1/showroom/",
    "/v1/sessions/session-1%2f..%2fadmin/showroom", "/v1/sessions/%252e%252e/showroom",
    "/v1//sessions/session-1/showroom", "/v1/sessions/session-1/%73howroom",
    `${snapshot}?url=https://evil.test`, `${snapshot}?token=secret`, `${snapshot}?afterRevision=1`,
  ]) {
    const response = await showroomGateway(request(path), { ...options, fetch: async () => assert.fail(path) });
    assert.ok([400, 404].includes(response.status), path);
  }
});

test("gateway requires method, same-origin writes and session bearer rather than cookies", async () => {
  const fake = async () => assert.fail("must not contact upstream");
  const denied = await showroomGateway(request(snapshot, { method: "POST" }), { ...options, fetch: fake });
  assert.equal(denied.status, 405);
  assert.equal(denied.headers.get("allow"), "GET");
  const deniedHeaders: HeadersInit[] = [
    { Origin: "https://evil.test", Authorization: authorization },
    { Origin: origin, Cookie: "Authorization=session-capability" },
    { Origin: origin, Authorization: "Bearer token,other" },
    { Origin: origin, Authorization: authorization, "Sec-Fetch-Site": "cross-site" },
  ];
  for (const headers of deniedHeaders) {
    const response = await showroomGateway(new Request(`${base}${snapshot}`, { headers }), { ...options, fetch: fake });
    assert.ok([401, 403].includes(response.status));
  }
  const noOrigin = new Request(`${base}${actions}`, { method: "POST", headers: { Authorization: authorization } });
  assert.equal((await showroomGateway(noOrigin, { ...options, fetch: fake })).status, 403);
  const noOriginGet = new Request(`${base}${snapshot}`, { headers: { Authorization: authorization } });
  assert.deepEqual(await (await showroomGateway(noOriginGet, { ...options, fetch: async () => success() })).json(), { revision: 1 });
});

test("gateway passes raw image bytes with a single canonical revision and rejects multipart", async () => {
  const path = `${snapshot}/references`;
  const bytes = Uint8Array.of(0xff, 0xd8, 0x00, 0x80, 0xff, 0xd9);
  const response = await showroomGateway(request(`${path}?expectedRevision=12${eventQuery}`, {
    method: "POST", headers: { "Content-Type": "image/jpeg" }, body: bytes,
  }), {
    ...options, fetch: async (url, init) => {
      assert.ok(url.endsWith(`?expectedRevision=12${eventQuery}`));
      assert.deepEqual(new Uint8Array(init.body as Uint8Array), bytes);
      return success();
    },
  });
  assert.equal(response.status, 200);
  await response.body?.cancel();
  for (const query of ["", "?expectedRevision=1", "?expectedRevision=-1", "?expectedRevision=01", "?expectedRevision=1&expectedRevision=2", "?%65xpectedRevision=1", `?expectedRevision=9007199254740992${eventQuery}`, "?expectedRevision=0&eventId=invalid"]) {
    assert.equal((await showroomGateway(request(`${path}${query}`, { method: "POST" }), options)).status, 400);
  }
  const multipart = new FormData();
  multipart.set("image", new Blob([bytes], { type: "image/jpeg" }), "photo.jpg");
  assert.equal((await showroomGateway(request(`${path}?expectedRevision=0${eventQuery}`, { method: "POST", body: multipart }), options)).status, 415);
  const removal = await showroomGateway(request(`${path}/photo-1?expectedRevision=9007199254740991${eventQuery}`, { method: "DELETE" }), {
    ...options, fetch: async (url, init) => {
      assert.equal(init.method, "DELETE");
      assert.ok(url.endsWith(`/photo-1?expectedRevision=9007199254740991${eventQuery}`));
      assert.equal(init.body, undefined);
      return success();
    },
  });
  assert.equal(removal.status, 200);
  await removal.body?.cancel();
});

test("gateway enforces declared and streamed request limits before forwarding", async () => {
  const lengths: Record<string, string>[] = [{ "Content-Length": "999999" }, {}];
  for (const headers of lengths) {
    const response = await showroomGateway(request(actions, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "x".repeat(16_385),
    }), { ...options, fetch: async () => assert.fail("oversize body forwarded") });
    assert.equal(response.status, 413);
  }
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(8)); controller.close(); },
  });
  const streamed = new Request(`${base}${snapshot}/references?expectedRevision=0${eventQuery}`, {
    method: "POST", headers: { Origin: origin, Authorization: authorization, "Content-Type": "image/png" },
    body: stream, duplex: "half",
  } as RequestInit);
  assert.equal((await showroomGateway(streamed, { ...options, maxUploadBytes: 12 })).status, 413);
});

test("gateway streams MP4 ranges unchanged and strips response credentials and internal headers", async () => {
  const bytes = Uint8Array.of(0, 1, 128, 255);
  const response = await showroomGateway(request(asset, { headers: { Range: "bytes=2-5", "If-Range": "untrusted" } }), {
    ...options, fetch: async (_url, init) => {
      assert.equal(new Headers(init.headers).get("range"), "bytes=2-5");
      assert.equal(new Headers(init.headers).get("if-range"), null);
      return new Response(bytes, { status: 206, headers: {
        "Content-Type": "video/mp4", "Content-Length": "4", "Content-Range": "bytes 2-5/20",
        "Accept-Ranges": "bytes", "Set-Cookie": "credential=secret", "X-Internal-Path": "private",
        "Access-Control-Allow-Origin": "*", "Content-Disposition": 'attachment; filename="private-secret.mp4"',
      } });
    },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 2-5/20");
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("content-length"), "4");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-internal-path"), null);
  assert.equal(response.headers.get("content-disposition"), null);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("gateway preserves unsatisfiable range status and no-content delete", async () => {
  const range = await showroomGateway(request(asset), {
    ...options, fetch: async () => new Response(null, { status: 416, headers: { "Content-Range": "bytes */20" } }),
  });
  assert.equal(range.status, 416);
  assert.equal(range.headers.get("content-range"), "bytes */20");
  const deleted = await showroomGateway(request("/v1/sessions/session-1", { method: "DELETE" }), {
    ...options, fetch: async () => new Response(null, { status: 204 }),
  });
  assert.equal(deleted.status, 204);
  const head = await showroomGateway(request(asset, { method: "HEAD" }), {
    ...options, fetch: async (_url, init) => {
      assert.equal(init.method, "HEAD");
      return new Response(null, { headers: { "Content-Type": "video/mp4", "Content-Length": "20" } });
    },
  });
  assert.equal(head.body, null);
  assert.equal(head.headers.get("content-length"), "20");
});

test("gateway sanitizes network errors, upstream errors and redirects without following them", async () => {
  for (const [status, fake] of [
    [502, async () => { throw new Error("http://127.0.0.1/private/secret"); }],
    [503, async () => Response.json({ error: { message: "secret internal path" } }, { status: 503 })],
    [502, async () => new Response(null, { status: 302, headers: { Location: "https://evil.test" } })],
  ] as const) {
    const response = await showroomGateway(request(), { ...options, fetch: fake });
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /secret|127\.0\.0\.1|evil/);
    assert.equal(response.headers.get("location"), null);
  }
});

test("only exact 409 revision conflicts expose a definitive retry classification", async () => {
  const cases = [
    { status: 409, body: '{"error":{"code":"REVISION_CONFLICT","message":"secret internal path"}}', expected: "REVISION_CONFLICT" },
    { status: 400, body: '{"error":{"code":"REVISION_CONFLICT"}}', expected: "SHOWROOM_REQUEST_FAILED" },
    { status: 409, body: '{"error":{"code":"EVENT_CONFLICT"}}', expected: "SHOWROOM_REQUEST_FAILED" },
    { status: 409, body: '{"error":{"code":"DUPLICATE_IMAGE"}}', expected: "SHOWROOM_REQUEST_FAILED" },
    { status: 409, body: '{"error":{"code":["REVISION_CONFLICT"]}}', expected: "SHOWROOM_REQUEST_FAILED" },
    { status: 409, body: '{"code":"REVISION_CONFLICT"}', expected: "SHOWROOM_REQUEST_FAILED" },
    { status: 409, body: '{"error":{"code":"REVISION_CONFLICT_SUFFIX"}}', expected: "SHOWROOM_REQUEST_FAILED" },
    { status: 409, body: '{"error":{"code":"REVISION_CONFLICT"', expected: "SHOWROOM_REQUEST_FAILED" },
    { status: 409, body: '{"error":{"code":"REVISION_CONFLICT","message":"' + "x".repeat(4096) + '"}}', expected: "SHOWROOM_REQUEST_FAILED" },
  ];
  for (const item of cases) {
    const response = await showroomGateway(request(), {
      ...options, fetch: async () => new Response(item.body, { status: item.status, headers: { "Content-Type": "application/json" } }),
    });
    assert.equal(response.status, item.status);
    const payload = await response.json();
    assert.equal(payload.error.code, item.expected);
    assert.doesNotMatch(payload.error.message, /secret|internal|xxxxx/);
  }
});

test("gateway rejects invalid upstreams, insecure public origins and invalid limits", async () => {
  for (const invalid of [
    { upstream: "http://evil.test" }, { upstream: "https://user:password@api.test" },
    { upstream: "https://api.test/v1" }, { upstream: "https://api.test?url=secret" },
    { publicOrigin: "*" }, { publicOrigin: "http://192.168.1.2:3202" }, { timeoutMs: NaN },
  ]) {
    const response = await showroomGateway(request(), { ...options, ...invalid, fetch: async () => assert.fail("invalid config") });
    assert.equal(response.status, 503);
  }
});

test("gateway aborts on timeout and caller cancellation, including a stalled request body", async () => {
  const stalledFetch: NonNullable<ShowroomGatewayOptions["fetch"]> = (_url, init) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(new Error("internal fetch details")), { once: true });
  });
  const timed = await showroomGateway(request(), { ...options, timeoutMs: 10, fetch: stalledFetch });
  assert.equal(timed.status, 504);
  const controller = new AbortController();
  const pending = showroomGateway(request(snapshot, { signal: controller.signal }), { ...options, fetch: stalledFetch });
  controller.abort();
  assert.equal((await pending).status, 499);
  const stalledBody = new Request(`${base}${actions}`, {
    method: "POST", headers: { Origin: origin, Authorization: authorization, "Content-Type": "application/json" },
    body: new ReadableStream(), duplex: "half",
  } as RequestInit);
  assert.equal((await showroomGateway(stalledBody, { ...options, timeoutMs: 10 })).status, 504);
});

test("gateway bounds both declared and streamed response bytes and response duration", async () => {
  const declared = await showroomGateway(request(asset), {
    ...options, maxResponseBytes: 4,
    fetch: async () => new Response("too large", { headers: { "Content-Length": "9" } }),
  });
  assert.equal(declared.status, 502);
  const streamed = await showroomGateway(request(asset), {
    ...options, maxResponseBytes: 4, fetch: async () => new Response("too large"),
  });
  await assert.rejects(streamed.arrayBuffer(), /download limit/);
  const stalled = await showroomGateway(request(asset), {
    ...options, timeoutMs: 10, fetch: async () => new Response(new ReadableStream()),
  });
  await assert.rejects(stalled.arrayBuffer(), /interrupted/);
});

test("gateway cancels the upstream body when the consumer cancels or disconnects after headers", async () => {
  let cancelled = 0;
  const fake = async () => new Response(new ReadableStream({
    cancel() { cancelled++; },
  }));
  const cancelledResponse = await showroomGateway(request(asset), { ...options, fetch: fake });
  await cancelledResponse.body!.cancel();
  assert.equal(cancelled, 1);
  const controller = new AbortController();
  const disconnected = await showroomGateway(request(asset, { signal: controller.signal }), { ...options, fetch: fake });
  const result = disconnected.arrayBuffer();
  controller.abort();
  await assert.rejects(result, /interrupted/);
  assert.equal(cancelled, 2);
});
