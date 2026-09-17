import { createHash, randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.js";
import { logEvent } from "../logging.js";
import { ApiError, Orchestrator } from "../orchestrator/service.js";
import { ProviderFailure } from "../providers/http-client.js";
import { bearer, tokenMatches } from "./auth.js";
import {
  KioskPairExchangeSchema, KioskPairingInputSchema, ShowroomContractError,
  ShowroomReferenceUploadQuerySchema,
} from "../contracts/showroom.js";
import { CalendarError } from "../calendar/errors.js";
import type { ShowroomVoiceService } from "../providers/voice.js";
import { BridgeError } from "../bridge/broker.js";

type AppEnvironment = { Variables: { requestId: string } };

async function boundedBytes(request: Request, limit: number): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
    throw new ApiError(413, "BODY_TOO_LARGE", "Request exceeds the configured size limit.");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError(413, "BODY_TOO_LARGE", "Request exceeds the configured size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export async function jsonBody(request: Request, limit = 16_384): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    throw new ApiError(415, "CONTENT_TYPE", "Use application/json for commands and events.");
  }
  const text = new TextDecoder().decode(await boundedBytes(request, limit));
  try { return JSON.parse(text); } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body is not valid JSON.");
  }
}

export function createApp(options: {
  orchestrator: Orchestrator;
  config: Config;
  deviceToken: string;
  root?: string;
  log?: typeof logEvent;
  voice?: ShowroomVoiceService;
  extensions?: Hono[];
  calendarProvider?: "disabled" | "google";
}) {
  const { orchestrator, config, deviceToken } = options;
  const root = options.root ?? process.cwd();
  const log = options.log ?? logEvent;
  const app = new Hono<AppEnvironment>();
  const showroom = () => {
    if (!orchestrator.showroom) throw new ApiError(503, "SHOWROOM_DISABLED", "The guided showroom is disabled.");
    return orchestrator.showroom;
  };
  const pairings = new Map<string, number>();
  const codeHash = (code: string) => createHash("sha256").update(code).digest("hex");
  let exchangeWindow = Date.now();
  let exchangeAttempts = 0;
  app.use("*", async (context, next) => {
    const requestId = randomUUID();
    context.set("requestId", requestId);
    context.header("X-Request-Id", requestId);
    context.header("Cache-Control", "no-store");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("Referrer-Policy", "no-referrer");
    context.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const started = performance.now();
    const url = new URL(context.req.url);
    const host = context.req.header("host") ?? url.host;
    let actual: URL;
    try { actual = new URL(`http://${host}`); } catch {
      throw new ApiError(403, "HOST_DENIED", "Host is not permitted.");
    }
    if (!config.allowedHosts.includes(actual.hostname) || actual.username || actual.password || actual.pathname !== "/") {
      throw new ApiError(403, "HOST_DENIED", "Host is not permitted.");
    }
    const origin = context.req.header("origin");
    const defaultOrigins = [`http://${host}`, `https://${host}`];
    const permitted = [...(config.allowedOrigins.length ? config.allowedOrigins : defaultOrigins),
      ...(config.SHOWROOM_BRIDGE_ENABLED ? config.bridgeOrigins : [])];
    if (origin && !permitted.includes(origin)) {
      throw new ApiError(403, "ORIGIN_DENIED", "Browser origin is not permitted.");
    }
    if (origin) {
      context.header("Access-Control-Allow-Origin", origin);
      context.header("Vary", "Origin");
      context.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      context.header("Access-Control-Allow-Headers", "Authorization,Content-Type,Range");
      context.header("Access-Control-Expose-Headers", "Content-Range,Content-Length,X-Request-Id");
    }
    if (context.req.method === "OPTIONS") return context.body(null, 204);
    await next();
    log({ event: "http_request", requestId, method: context.req.method, status: context.res.status, latencyMs: Math.round(performance.now() - started) });
  });

  app.onError((error, context) => {
    const requestId = context.get("requestId");
    const requestedStatus = error instanceof ApiError || error instanceof CalendarError || error instanceof BridgeError ? error.status : error instanceof ShowroomContractError ? 409 : error instanceof ProviderFailure ? 502 : error instanceof z.ZodError ? 400 : 500;
    const errorStatuses = [400, 401, 403, 404, 405, 409, 410, 413, 415, 422, 429, 500, 502, 503, 504] as const;
    const status = errorStatuses.find((candidate) => candidate === requestedStatus) ?? 500;
    const code = error instanceof ApiError || error instanceof ProviderFailure || error instanceof ShowroomContractError || error instanceof BridgeError ? error.code : error instanceof z.ZodError ? "INVALID_INPUT" : "INTERNAL_ERROR";
    const message = error instanceof ApiError || error instanceof ProviderFailure || error instanceof ShowroomContractError || error instanceof BridgeError ? error.message : error instanceof z.ZodError ? "Input does not match the versioned contract." : "The request failed. Use the request ID to inspect server diagnostics.";
    log({ event: "request_failed", requestId, status, code });
    return context.json({ error: { code, message, requestId } }, status);
  });

  app.get("/healthz", (context) => context.json({ status: "ok" }));
  app.get("/readyz", (context) => context.json({
    status: "ready",
    providers: { brief: config.BRIEF_PROVIDER, profile: config.PROFILE_PROVIDER, media: config.MEDIA_PROVIDER, job: "local", followup: "disabled" },
    showroom: {
      mode: config.SHOWROOM_MODE,
      voice: { enabled: !!options.voice, model: config.VOICE_MODEL },
      calendar: { provider: options.calendarProvider ?? "disabled" },
      bridge: { enabled: config.SHOWROOM_BRIDGE_ENABLED },
    },
    liveIntegrationVerified: false,
  }));
  const staticFiles: Record<string, [string, string]> = {
    "/dev": ["public/dev/index.html", "text/html; charset=utf-8"],
    "/dev/": ["public/dev/index.html", "text/html; charset=utf-8"],
    "/dev/app.js": ["public/dev/app.js", "text/javascript; charset=utf-8"],
    "/dev/styles.css": ["public/dev/styles.css", "text/css; charset=utf-8"],
    "/dev/sample.png": ["fixtures/media/sample.png", "image/png"],
  };
  for (const [route, [file, type]] of Object.entries(staticFiles)) {
    app.get(route, async () => new Response(new Uint8Array(await readFile(resolve(root, file))), {
      headers: { "Content-Type": type },
    }));
  }
  app.get("/", (context) => context.redirect("/dev"));

  for (const extension of options.extensions ?? []) app.route("/", extension);

  app.post("/v1/operator/kiosk-pairings", async (context) => {
    showroom();
    if (!config.SHOWROOM_OPERATOR_TOKEN || !tokenMatches(bearer(context.req.header("authorization")), config.SHOWROOM_OPERATOR_TOKEN)) {
      throw new ApiError(401, "OPERATOR_AUTH_REQUIRED", "A private operator credential is required.");
    }
    KioskPairingInputSchema.parse(await jsonBody(context.req.raw));
    for (const [key, expiresAt] of pairings) if (expiresAt <= Date.now()) pairings.delete(key);
    if (pairings.size >= 32) throw new ApiError(429, "PAIRING_LIMIT", "Too many active pairing codes.");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let pairingCode: string;
    do { pairingCode = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join(""); } while (pairings.has(codeHash(pairingCode)));
    const expiresAt = Date.now() + 120_000;
    pairings.set(codeHash(pairingCode), expiresAt);
    return context.json({ pairingCode, expiresAt }, 201);
  });
  app.post("/v1/kiosk/pair", async (context) => {
    showroom();
    if (Date.now() - exchangeWindow >= 60_000) { exchangeWindow = Date.now(); exchangeAttempts = 0; }
    if (++exchangeAttempts > 60) throw new ApiError(429, "PAIRING_RATE_LIMIT", "Wait before trying another pairing code.");
    const input = KioskPairExchangeSchema.parse(await jsonBody(context.req.raw));
    const key = codeHash(input.pairingCode);
    const expiry = pairings.get(key);
    if (!expiry || expiry <= Date.now()) throw new ApiError(401, "PAIRING_INVALID", "The pairing code is invalid or expired.");
    pairings.delete(key);
    const created = orchestrator.createSession();
    return context.json({ ...created, expiresAt: showroom().snapshot(created.sessionId).expiresAt }, 201);
  });

  app.post("/v1/sessions", async (context) => {
    if (!tokenMatches(bearer(context.req.header("authorization")), deviceToken)) {
      throw new ApiError(401, "DEVICE_AUTH_REQUIRED", "Pair this device before creating a session.");
    }
    const body = await boundedBytes(context.req.raw, 128);
    if (body.byteLength) {
      const parsed = await jsonBody(new Request("http://localhost", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: Buffer.from(body),
      }));
      z.object({}).strict().parse(parsed);
    }
    return context.json(await orchestrator.createSession(), 201);
  });
  app.use("/v1/sessions/:id", async (context, next) => {
    const id = context.req.param("id");
    const token = bearer(context.req.header("authorization"));
    if (!token || !orchestrator.authorize(id, token)) {
      throw new ApiError(401, "SESSION_AUTH_REQUIRED", "A valid session credential is required.");
    }
    await next();
  });
  app.use("/v1/sessions/:id/*", async (context, next) => {
    const id = context.req.param("id");
    const token = bearer(context.req.header("authorization"));
    if (!token || !orchestrator.authorize(id, token)) {
      throw new ApiError(401, "SESSION_AUTH_REQUIRED", "A valid session credential is required.");
    }
    await next();
  });
  app.get("/v1/sessions/:id", async (context) => {
    const after = context.req.query("afterRevision");
    if (after !== undefined && !/^\d{1,9}$/.test(after)) throw new ApiError(400, "INVALID_CURSOR", "Revision cursor must be a nonnegative integer.");
    return context.json(await orchestrator.snapshot(context.req.param("id"), after === undefined ? undefined : Number(after)));
  });
  app.get("/v1/sessions/:id/showroom", context => context.json(showroom().snapshot(context.req.param("id"))));
  app.get("/v1/sessions/:id/showroom/catalog", async context => context.json(await showroom().catalog(context.req.param("id"))));
  app.post("/v1/sessions/:id/showroom/actions", async context =>
    context.json(await showroom().action(context.req.param("id"), await jsonBody(context.req.raw))));
  const referenceQuery = (request: Request) => {
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some(key => !["expectedRevision", "eventId"].includes(key))
        || query.getAll("expectedRevision").length !== 1 || query.getAll("eventId").length !== 1
        || !/^\d{1,16}$/.test(query.get("expectedRevision") ?? "")) {
      throw new ApiError(400, "INVALID_INPUT", "Supply one expectedRevision and eventId for reference mutations.");
    }
    return ShowroomReferenceUploadQuerySchema.parse({ expectedRevision: Number(query.get("expectedRevision")), eventId: query.get("eventId") });
  };
  app.post("/v1/sessions/:id/showroom/references", async context => {
    const query = referenceQuery(context.req.raw);
    const bytes = await boundedBytes(context.req.raw, 5 * 1024 * 1024);
    return context.json(await showroom().upload(context.req.param("id"), bytes,
      context.req.header("content-type")?.split(";")[0]?.trim() ?? "", query.expectedRevision, query.eventId), 201);
  });
  app.delete("/v1/sessions/:id/showroom/references/:assetId", async context => {
    const query = referenceQuery(context.req.raw);
    return context.json(await showroom().deleteReference(context.req.param("id"), context.req.param("assetId"), query.expectedRevision, query.eventId));
  });
  app.post("/v1/sessions/:id/showroom/voice", async context => {
    if (!options.voice) throw new ApiError(503, "VOICE_DISABLED", "Live voice is disabled. Use touch controls.");
    return context.json(await options.voice.setup(context.req.param("id"), await jsonBody(context.req.raw, 768 * 1024), context.req.raw.signal));
  });
  app.delete("/v1/sessions/:id/showroom/voice", async context => {
    if (!options.voice) throw new ApiError(503, "VOICE_DISABLED", "Live voice is disabled.");
    const { generation } = z.object({ generation: z.number().int().nonnegative() }).strict().parse(await jsonBody(context.req.raw));
    options.voice.end(context.req.param("id"), generation);
    return context.body(null, 204);
  });
  app.post("/v1/sessions/:id/events", async (context) =>
    context.json(await orchestrator.event(context.req.param("id"), await jsonBody(context.req.raw))));
  app.post("/v1/sessions/:id/commands/:name", async (context) => {
    const name = context.req.param("name");
    const result = await orchestrator.command(context.req.param("id"), name, await jsonBody(context.req.raw));
    return context.json(result, name === "start_media_job" ? 202 : 200);
  });
  app.get("/v1/sessions/:id/jobs/:jobId", async (context) =>
    context.json(await orchestrator.command(context.req.param("id"), "get_media_status", { jobId: context.req.param("jobId") })));
  app.post("/v1/sessions/:id/assets", async (context) => {
    const type = context.req.header("content-type")?.split(";")[0]?.trim();
    if (type !== "image/png" && type !== "image/jpeg") {
      throw new ApiError(415, "IMAGE_TYPE", "Upload a PNG or JPEG image.");
    }
    const bytes = await boundedBytes(context.req.raw, config.MAX_UPLOAD_BYTES);
    return context.json(await orchestrator.uploadImage(context.req.param("id"), bytes, type), 201);
  });
  app.get("/v1/sessions/:id/assets/:assetId", async (context) => {
    const asset = await orchestrator.asset(context.req.param("id"), context.req.param("assetId"));
    const data = asset.bytes;
    const headers = new Headers({
      "Content-Type": asset.mimeType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Length": String(data.byteLength),
    });
    const range = context.req.header("range");
    if (!range) return context.newResponse(Buffer.from(data), { headers });
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const startText = match?.[1];
    const endText = match?.[2];
    let start = startText ? Number(startText) : 0;
    let end = endText ? Number(endText) : data.byteLength - 1;
    if (startText === "" && endText) {
      start = Math.max(0, data.byteLength - Number(endText));
      end = data.byteLength - 1;
    }
    if (!match || (!startText && !endText) || !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) || start >= data.byteLength || start > end ||
        (startText === "" && endText === "0")) {
      headers.set("Content-Range", `bytes */${data.byteLength}`);
      headers.set("Content-Length", "0");
      return context.newResponse(null, { status: 416, headers });
    }
    end = Math.min(end, data.byteLength - 1);
    headers.set("Content-Range", `bytes ${start}-${end}/${data.byteLength}`);
    headers.set("Content-Length", String(end - start + 1));
    return context.newResponse(Buffer.from(data.subarray(start, end + 1)), { status: 206, headers });
  });
  app.delete("/v1/sessions/:id", async (context) => {
    await orchestrator.deleteSession(context.req.param("id"));
    return context.body(null, 204);
  });
  app.notFound((context) => context.json({ error: { code: "NOT_FOUND", message: "Route not found.", requestId: context.get("requestId") } }, 404));
  return app;
}
