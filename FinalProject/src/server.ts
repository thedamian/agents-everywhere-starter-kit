import { randomBytes } from "node:crypto";
import { Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { readConfig } from "./config.js";
import { createApp } from "./http/app.js";
import { ApiError, Orchestrator } from "./orchestrator/service.js";
import { createProviders } from "./providers/factory.js";
import { DEMO_MEDIA } from "./providers/demo-media.js";
import { createStudioProvider } from "./providers/studio.js";
import { createFixtureStudioProvider } from "./providers/studio-fixture.js";
import { ShowroomVoiceService } from "./providers/voice.js";
import { parseCalendarConfig } from "./calendar/config.js";
import { createCalendarIntegration } from "./http/calendar.js";
import { BridgeBroker, createBridgeRouter, attachBridgeWebSocket } from "./bridge/index.js";

async function main() {
  const config = readConfig();
  const root = process.cwd();
  const fixture = new Uint8Array(await readFile(resolve(root, "fixtures", "media", DEMO_MEDIA.filename)));
  const providers = createProviders(config, fixture);
  const studioProvider = config.SHOWROOM_MODE === "studio"
    ? createStudioProvider({ baseUrl: config.MOVIE_STUDIO_URL, token: config.MOVIE_API_TOKEN!, maxBytes: config.MAX_MEDIA_BYTES })
    : config.SHOWROOM_MODE === "fixture" ? createFixtureStudioProvider(fixture) : undefined;
  await studioProvider?.recoverCleanup();
  const calendarConfig = parseCalendarConfig(process.env);
  const calendar = createCalendarIntegration(calendarConfig, config.SHOWROOM_OPERATOR_TOKEN, root);
  let deviceToken = config.DEMO_DEVICE_TOKEN;
  if (!deviceToken) {
    deviceToken = randomBytes(32).toString("base64url");
    const directory = resolve(root, ".runtime");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, "device-token");
    await writeFile(path, `${deviceToken}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ event: "pairing_file", path }));
  }
  let orchestrator: Orchestrator;
  const bridge = config.SHOWROOM_BRIDGE_ENABLED ? new BridgeBroker({
    sessionSafety: id => {
      try {
        const snapshot = orchestrator.showroom!.snapshot(id);
        return { active: snapshot.state !== "cancelled" && snapshot.playback.status !== "playing", motionConsent: snapshot.consent?.motion === true };
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        return { active: false, motionConsent: false };
      }
    },
    onError: code => console.error(JSON.stringify({ event: "bridge_failed", code })),
  }) : undefined;
  orchestrator = new Orchestrator({
    ...providers,
    sessionTtlMs: config.SESSION_TTL_MS,
    jobTimeoutMs: config.JOB_TIMEOUT_MS,
    maxSessions: config.MAX_SESSIONS,
    maxQueuedJobs: config.MAX_QUEUED_JOBS,
    allowFallbacks: config.ALLOW_DEMO_FALLBACKS,
    studioProvider, showroomMode: config.SHOWROOM_MODE === "disabled" ? undefined : config.SHOWROOM_MODE,
    calendar: calendar.service,
    motion: bridge ? {
      authorizeMotion: (id, intent) => bridge.authorizeMotion(id, intent),
      stopSession: (id, reason) => bridge.stopSession(id, reason),
      sessionState: id => bridge.sessionState(id).bridge,
    } : undefined,
  });
  const voice = config.VOICE_ENABLED ? new ShowroomVoiceService({
    apiKey: config.OPENAI_API_KEY!, voiceModel: config.VOICE_MODEL, regularModel: config.regularModel,
    snapshot: id => orchestrator.showroom!.snapshot(id),
  }) : undefined;
  orchestrator.onSessionEnded(id => voice?.end(id));
  const app = createApp({
    orchestrator, config, deviceToken, root, voice,
    extensions: [
      ...(calendar.router ? [calendar.router] : []),
      ...(bridge ? [createBridgeRouter({
        broker: bridge, operatorToken: config.SHOWROOM_OPERATOR_TOKEN!, allowedOrigins: config.bridgeOrigins,
        authorizeSession: (id, token) => orchestrator.authorize(id, token),
      })] : []),
    ],
    calendarProvider: calendarConfig.provider,
  });
  const server = serve({ fetch: app.fetch, hostname: config.HOST, port: config.PORT }, (info) => {
    console.log(JSON.stringify({ event: "server_started", host: config.HOST, port: info.port }));
  });
  if (!(server instanceof Server)) throw new Error("The local runner requires an HTTP/1 Node server.");
  const bridgeControl = bridge ? attachBridgeWebSocket(server, {
    broker: bridge, allowedOrigins: config.bridgeOrigins,
    onError: code => console.error(JSON.stringify({ event: "bridge_failed", code })),
  }) : undefined;
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    voice?.dispose();
    bridgeControl?.close();
    orchestrator.dispose();
    server.close(() => { process.exitCode = 0; });
    server.closeIdleConnections();
    setTimeout(() => {
      server.closeAllConnections();
      process.exitCode = 0;
    }, 2_000).unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(JSON.stringify({ event: "server_error", code: error.code ?? "LISTEN_FAILED" }));
    voice?.dispose();
    bridgeControl?.close();
    orchestrator.dispose();
    process.exitCode = 1;
  });
}

main().catch((error: unknown) => {
  // Startup errors come from local configuration/file setup, not provider responses.
  const message = error instanceof Error ? error.message : "Unable to start the API.";
  console.error(JSON.stringify({ event: "startup_failed", message }));
  process.exitCode = 1;
});
