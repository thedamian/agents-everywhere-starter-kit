import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { integrationEnvironments, launchOptions, apiReady } from "../../FinalProject/scripts/kiosk-config.mjs";

const movieRoot = fileURLToPath(new URL("..", import.meta.url));
const publicOrigin = "https://kiosk.example.test";
const finalRoot = fileURLToPath(new URL("../../FinalProject", import.meta.url));
const nextServer = `
  import next from "next";
  import { createServer } from "node:http";
  const app = next({ dev: false, hostname: "127.0.0.1", port: 0, dir: process.cwd() });
  await app.prepare();
  const handle = app.getRequestHandler();
  const server = createServer((request, response) => handle(request, response));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  process.send({ port: server.address().port });
  process.on("message", async message => {
    if (message?.type !== "shutdown") return;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await app.close();
    process.disconnect();
  });
`;
const apiServer = `
  const log = console.log;
  console.log = (...messages) => {
    log(...messages);
    for (const message of messages) {
      if (typeof message !== "string" || !message.startsWith("{")) continue;
      const event = JSON.parse(message);
      if (event.event === "server_started") process.send({ port: event.port });
    }
  };
  process.on("message", message => {
    if (message?.type !== "shutdown") return;
    process.emit("SIGTERM");
    process.disconnect();
  });
  await import("./dist/server.js");
`;

async function launchApplication(env, script = nextServer, cwd = movieRoot) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let diagnostics = "";
  for (const output of [child.stdout, child.stderr]) {
    output.on("data", (bytes) => { diagnostics = (diagnostics + bytes.toString()).slice(-8_192); });
  }
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.connected) child.send({ type: "shutdown" });
    const timer = setTimeout(() => child.kill(), 10_000);
    try { await stopped; } finally { clearTimeout(timer); }
  };
  try {
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`HTTP test server timed out.\n${diagnostics}`)), 90_000);
      const finish = (error, value) => {
        clearTimeout(timeout);
        if (error) reject(error); else resolve(value);
      };
      child.once("error", (error) => finish(error));
      child.once("exit", (code) => finish(new Error(`HTTP test server exited ${code}.\n${diagnostics}`)));
      child.once("message", (message) => {
        if (!Number.isInteger(message.port)) finish(new Error("The server did not report a bound ephemeral port."));
        else finish(undefined, message.port);
      });
    });
    return { base: `http://127.0.0.1:${port}`, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

test("built Next serves the bounded same-origin gateway over real loopback HTTP", { timeout: 180_000 }, async t => {
  await access(new URL("../.next/BUILD_ID", import.meta.url));
  const received = [];
  const film = Buffer.from([0, 1, 2, 128, 255, 3]);
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ method: request.method, path: request.url, headers: request.headers, body: Buffer.concat(chunks) });
    if (request.url.endsWith("/assets/film-1")) {
      response.writeHead(206, {
        "Content-Type": "video/mp4", "Content-Length": "3", "Content-Range": "bytes 2-4/6",
        "Accept-Ranges": "bytes", "Set-Cookie": "must-not-forward=1",
      });
      response.end(film.subarray(2, 5));
      return;
    }
    response.writeHead(request.url === "/v1/kiosk/pair" ? 201 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ fixture: true, revision: 1 }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  let gateway;
  try {
    const options = launchOptions(["--api-port", String(upstream.address().port), "--public-origin", publicOrigin]);
    const env = integrationEnvironments({ options, deviceToken: "test-device", mediaToken: "test-media" });
    gateway = await launchApplication({ ...env.ui, NODE_ENV: "production" });
    const headers = { Origin: publicOrigin, Authorization: "Bearer test-session" };
    const snapshot = `${gateway.base}/api/showroom/v1/sessions/session-1/showroom`;
    const response = await fetch(snapshot, {
      headers: { ...headers, Cookie: "must-not-forward=1", "X-Forwarded-Host": "evil.example.test", "X-Api-Key": "fake-secret" },
    });

    for (const bridgeEnabled of [false, true]) await t.test(`actual four-photo kiosk fixture with bridge ${bridgeEnabled ? "enabled but unpaired" : "disabled"}`, { timeout: 120_000 }, async () => {
      await access(new URL("../.next/BUILD_ID", import.meta.url));
      await access(new URL("../../FinalProject/dist/server.js", import.meta.url));
      const { ShowroomClient } = await import("../integration/showroom-client.ts");
      const { ShowroomController } = await import("../src/kiosk/showroom-controller.ts");
      const { default: sharp } = await import("sharp");
      const operatorToken = "test-operator-bootstrap-123456789012345678";
      const options = launchOptions(["--public-origin", publicOrigin, ...(bridgeEnabled ? ["--windows-bridge"] : [])]);
      const env = integrationEnvironments({
        options, deviceToken: "test-device-bootstrap-123456789012345678",
        mediaToken: "test-media-bootstrap-123456789012345678", operatorToken,
      });
      let api, gateway, controller;
      let lastAuthorization;
      try {
        api = await launchApplication({ ...env.api, PORT: "0" }, apiServer, finalRoot);
        const readiness = await (await fetch(`${api.base}/readyz`)).json();
        assert.equal(apiReady(readiness, options), true);
        assert.equal(readiness.showroom.bridge.enabled, bridgeEnabled);
        assert.equal(readiness.showroom.voice.enabled, false);
        gateway = await launchApplication({ ...env.ui, NODE_ENV: "production", SHOWROOM_API_UPSTREAM: api.base });
        const issued = await fetch(`${api.base}/v1/operator/kiosk-pairings`, {
          method: "POST", headers: { Authorization: `Bearer ${operatorToken}`, "Content-Type": "application/json" }, body: "{}",
        });
        assert.equal(issued.status, 201);
        const { pairingCode } = await issued.json();
        const client = new ShowroomClient((input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("Origin", publicOrigin);
          if (headers.has("Authorization")) lastAuthorization = headers.get("Authorization");
          return fetch(new URL(input, gateway.base), { ...init, headers });
        });
        controller = new ShowroomController({ api: client, pollMs: 100_000 });
        await controller.pair(pairingCode);
        assert.equal(controller.getState().connection, "active", controller.getState().error);
        assert.equal(controller.getState().catalog.mode, "fixture");
        const sessionId = controller.getState().snapshot.sessionId;
        assert.equal(controller.canCapture(), false);
        assert.equal(controller.robotStopped(), true, "An unpaired bridge must not block stationary capture.");
        const confirm = async () => {
          const pending = controller.pending();
          assert.ok(pending?.readback);
          await controller.confirm(pending, "approve", "touch");
        };
        await controller.consent({
          policyVersion: "showroom-v1", personalization: true, capture: true, likeness: true,
          providerTransfer: true, calendar: false, motion: false,
        });
        assert.equal(controller.canCapture(), false, "Proposing consent is not explicit confirmation.");
        await confirm();
        assert.equal(controller.canCapture(), true);
        await controller.propose({ field: "visitor", value: { displayName: "Fixture visitor" } });
        await confirm();
        await controller.propose({
          field: "context", value: { signals: [{ value: "Mountain hikes", source: "manual", visualUseAllowed: true, confidence: null }] },
        });
        await confirm();
        await controller.propose({ field: "selection", value: {
          productId: "tesla-model-y", templateId: "DREAM_ROUTE", heroMode: "LIKENESS",
          productionMode: "reviewed-storyboard", videoProvider: "google-veo", enableHeroVideo: true,
          storyFormat: "four-shot", renderLayout: "video-bookends", movieDurationSeconds: 15,
        } });
        await confirm();
        for (const [index, view] of ["front_face", "half_body", "profile", "three_quarter"].entries()) {
          const bytes = await sharp({ create: {
            width: 640, height: 480, channels: 3, background: ["red", "green", "blue", "yellow"][index],
          } }).jpeg().toBuffer();
          const accepted = await controller.capture.addManual({
            timestamp: Date.now(), people: 1, tracked: true, stable: true, robotStopped: true, view,
            light: 120, sharpness: 100,
            perceptualHash: Array.from({ length: 64 }, (_, n) => String(Math.floor(n / (2 ** index)) % 2)).join(""),
          }, async () => ({
            blob: new Blob([bytes], { type: "image/jpeg" }), width: 640, height: 480,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          }));
          assert.equal(accepted, true);
          await controller.syncPhotos();
          assert.equal(controller.getState().snapshot.captureSet.references.length, index + 1);
        }
        assert.equal(controller.getState().snapshot.captureSet.references.length, 4);
        await controller.requestStudio();
        assert.equal(controller.pending().kind, "studio");
        await confirm();
        const deadline = Date.now() + 15_000;
        while (controller.getState().snapshot.studio.status !== "ready" && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 100));
          await controller.refresh();
        }
        const studio = controller.getState().snapshot.studio;
        assert.equal(studio.status, "ready");
        assert.equal(studio.provenance, "mock_fixture");
        assert.equal(controller.getState().snapshot.playback.status, "idle");
        await controller.acceptPlayback();
        assert.ok(controller.getState().movieUrl, controller.getState().playbackError);
        assert.equal(controller.robotStopped(), true);
        // These are simulated browser media events, not a claim of physical playback.
        controller.onPlaying();
        await controller.onEnded();
        assert.equal(controller.getState().snapshot.playback.status, "ended");
        assert.equal(controller.getState().snapshot.state, "followup");
        assert.equal(controller.getState().movieUrl, null);
        await controller.end();
        assert.equal(controller.getState().connection, "ended");
        assert.equal(controller.capture.getState().references.length, 0);
        assert.match(lastAuthorization, /^Bearer [A-Za-z0-9._~-]+$/);
        const revoked = await fetch(`${gateway.base}/api/showroom/v1/sessions/${sessionId}/assets/${studio.assetId}`, {
          headers: { Origin: publicOrigin, Authorization: lastAuthorization },
        });
        assert.ok([401, 410].includes(revoked.status));
        assert.notEqual(revoked.headers.get("content-type"), "video/mp4");
        await revoked.arrayBuffer();
      } finally {
        controller?.dispose();
        await gateway?.stop();
        await api?.stop();
      }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { fixture: true, revision: 1 });
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(received[0].path, "/v1/sessions/session-1/showroom");
    assert.equal(received[0].headers.authorization, "Bearer test-session");
    assert.equal(received[0].headers.origin, publicOrigin);
    assert.equal(received[0].headers.cookie, undefined);
    assert.equal(received[0].headers["x-forwarded-host"], undefined);
    assert.equal(received[0].headers["x-api-key"], undefined);

    const paired = await fetch(`${gateway.base}/api/showroom/v1/kiosk/pair`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: '{"pairingCode":"ABCD1234"}',
    });
    assert.equal(paired.status, 201);
    await paired.arrayBuffer();
    assert.equal(received[1].headers.authorization, undefined);
    assert.equal(received[1].body.toString(), '{"pairingCode":"ABCD1234"}');

    const asset = await fetch(`${gateway.base}/api/showroom/v1/sessions/session-1/assets/film-1`, {
      headers: { ...headers, Range: "bytes=2-4" },
    });
    assert.equal(asset.status, 206);
    assert.equal(asset.headers.get("content-range"), "bytes 2-4/6");
    assert.equal(asset.headers.get("set-cookie"), null);
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), film.subarray(2, 5));

    const before = received.length;
    const denied = await fetch(`${gateway.base}/api/showroom/v1/operator/kiosk-pairings`, { method: "POST", headers });
    assert.equal(denied.status, 404);
    await denied.arrayBuffer();
    const badOrigin = await fetch(snapshot, { headers: { ...headers, Origin: "https://evil.example.test" } });
    assert.equal(badOrigin.status, 403);
    await badOrigin.arrayBuffer();
    const query = await fetch(`${snapshot}?token=must-not-forward`, { headers });
    assert.equal(query.status, 400);
    await query.arrayBuffer();
    assert.equal(received.length, before);
  } finally {
    await gateway?.stop();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
