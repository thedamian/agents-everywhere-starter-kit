type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface ShowroomGatewayOptions {
  upstream?: string;
  publicOrigin?: string;
  fetch?: Fetcher;
  timeoutMs?: number;
  maxUploadBytes?: number;
  maxResponseBytes?: number;
}

type Route = { methods: string[]; body?: "json" | "image"; asset?: boolean; revision?: boolean; pairing?: boolean; voice?: boolean };
const prefix = "/api/showroom";
const identifier = "[A-Za-z0-9_-]{1,128}";
const session = `/v1/sessions/${identifier}`;
const routes: [RegExp, Route][] = [
  [/^\/v1\/kiosk\/pair$/, { methods: ["POST"], body: "json", pairing: true }],
  [new RegExp(`^${session}/showroom$`), { methods: ["GET"] }],
  [new RegExp(`^${session}/showroom/actions$`), { methods: ["POST"], body: "json" }],
  [new RegExp(`^${session}/showroom/catalog$`), { methods: ["GET"] }],
  [new RegExp(`^${session}/showroom/voice$`), { methods: ["POST", "DELETE"], body: "json", voice: true }],
  [new RegExp(`^${session}/showroom/references$`), { methods: ["POST"], body: "image", revision: true }],
  [new RegExp(`^${session}/showroom/references/${identifier}$`), { methods: ["DELETE"], revision: true }],
  [new RegExp(`^${session}$`), { methods: ["DELETE"] }],
  [new RegExp(`^${session}/assets$`), { methods: ["POST"], body: "image" }],
  [new RegExp(`^${session}/assets/${identifier}$`), { methods: ["GET", "HEAD"], asset: true }],
];

class GatewayError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "Pragma": "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function failure(status: number, code: string, message: string, headers?: HeadersInit) {
  return Response.json({ error: { code, message } }, {
    status, headers: { ...privateHeaders, ...Object.fromEntries(new Headers(headers)) },
  });
}

function configuredOrigin(value: string, upstream: boolean): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new GatewayError(503, "GATEWAY_CONFIGURATION", "The showroom gateway is not configured."); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      !(url.protocol === "https:" || (url.protocol === "http:" && loopback)) ||
      (!upstream && value !== url.origin)) {
    throw new GatewayError(503, "GATEWAY_CONFIGURATION", "The showroom gateway requires a trusted origin.");
  }
  return url.origin;
}

function positiveLimit(value: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new GatewayError(503, "GATEWAY_CONFIGURATION", "The showroom gateway limits are invalid.");
  }
  return value;
}

async function boundedBody(request: Pick<Request, "headers" | "body">, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    throw new GatewayError(413, "BODY_TOO_LARGE", "The request exceeds the upload limit.");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new GatewayError(413, "BODY_TOO_LARGE", "The request exceeds the upload limit.");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

async function upstreamErrorCode(response: Response, signal: AbortSignal) {
  if (response.status !== 409) return "SHOWROOM_REQUEST_FAILED";
  try {
    const bytes = await boundedBody(response, 4096, signal);
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (payload && typeof payload === "object" && "error" in payload &&
        payload.error && typeof payload.error === "object" && "code" in payload.error &&
        payload.error.code === "REVISION_CONFLICT") return "REVISION_CONFLICT";
  } catch (error) {
    if (signal.aborted) throw error;
    // An unreadable or oversized error is not proof that an action was rejected before acceptance.
  }
  return "SHOWROOM_REQUEST_FAILED";
}

function responseStream(body: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal, cleanup: () => void) {
  const reader = body.getReader();
  let size = 0;
  let ended = false;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => {
    ended = true;
    signal.removeEventListener("abort", abort);
    cleanup();
  };
  const abort = () => {
    if (ended) return;
    finish();
    output.error(new Error("The showroom response was interrupted."));
    void reader.cancel().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (ended) return;
        if (done) { finish(); controller.close(); return; }
        size += value.byteLength;
        if (size > limit) {
          finish();
          controller.error(new Error("The showroom response exceeds the download limit."));
          await reader.cancel();
          return;
        }
        controller.enqueue(value);
      } catch {
        if (!ended) { finish(); controller.error(new Error("The showroom response was interrupted.")); }
      }
    },
    async cancel() { finish(); await reader.cancel(); },
  });
}

export async function showroomGateway(request: Request, options: ShowroomGatewayOptions = {}): Promise<Response> {
  let cleanup = () => {};
  let timedOut = false;
  try {
    const upstream = configuredOrigin(options.upstream ?? "http://127.0.0.1:3101", true);
    const publicOrigin = configuredOrigin(options.publicOrigin ?? "http://127.0.0.1:3200", false);
    const url = new URL(request.url);
    // Canonical ASCII paths only: no decoded separators, traversal, duplicate slashes, or double decoding.
    if (!url.pathname.startsWith(`${prefix}/`) || /[%\\]/.test(url.pathname)) {
      throw new GatewayError(404, "ROUTE_DENIED", "This showroom route is not available.");
    }
    const path = url.pathname.slice(prefix.length);
    const route = routes.find(([pattern]) => pattern.test(path))?.[1];
    if (!route) throw new GatewayError(404, "ROUTE_DENIED", "This showroom route is not available.");
    if (!route.methods.includes(request.method)) {
      return failure(405, "METHOD_DENIED", "This method is not available.", { Allow: route.methods.join(", ") });
    }
    const revision = url.searchParams.get("expectedRevision") ?? "";
    const eventId = url.searchParams.get("eventId") ?? "";
    const referenceQuery = route.revision && !/[%+]/.test(url.search) &&
      url.searchParams.size === 2 && /^(?:0|[1-9]\d{0,15})$/.test(revision) &&
      Number.isSafeInteger(Number(revision)) && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(eventId);
    if (url.search && !referenceQuery) {
      throw new GatewayError(400, "QUERY_DENIED", "Query parameters are not accepted on this route.");
    }
    if (route.revision && !referenceQuery) throw new GatewayError(400, "REVISION_REQUIRED", "Include the expected showroom revision and event ID.");
    const origin = request.headers.get("origin");
    const site = request.headers.get("sec-fetch-site");
    if ((origin && origin !== publicOrigin) || site === "cross-site" ||
        (!["GET", "HEAD"].includes(request.method) && origin !== publicOrigin)) {
      throw new GatewayError(403, "ORIGIN_DENIED", "Use the configured showroom origin.");
    }
    const authorization = request.headers.get("authorization");
    if (!route.pairing && (!authorization || !/^Bearer [A-Za-z0-9._~-]{1,2048}$/.test(authorization))) {
      throw new GatewayError(401, "SESSION_AUTH_REQUIRED", "Pair this kiosk before using the showroom.");
    }
    const headers = new Headers();
    if (!route.pairing && authorization) headers.set("Authorization", authorization);
    if (origin) headers.set("Origin", publicOrigin);
    if (route.asset && request.headers.has("range")) {
      const range = request.headers.get("range")!;
      if (!/^bytes=(?:\d{1,16}-\d{0,16}|-\d{1,16})$/.test(range)) {
        throw new GatewayError(416, "INVALID_RANGE", "Request one byte range.");
      }
      headers.set("Range", range);
    }
    const timeoutMs = positiveLimit(options.timeoutMs ?? 30_000, 120_000);
    const uploadLimit = positiveLimit(options.maxUploadBytes ?? 5_242_880, 33_554_432);
    const responseLimit = positiveLimit(options.maxResponseBytes ?? (route.asset ? 134_217_728 : route.voice ? 1_048_576 : 524_288), 268_435_456);
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    cleanup = () => { clearTimeout(timer); request.signal.removeEventListener("abort", abort); };
    let body: Uint8Array | undefined;
    if (route.body) {
      const contentType = request.headers.get("content-type") ?? "";
      const mime = contentType.split(";")[0].trim().toLowerCase();
      if (!(route.body === "json" ? mime === "application/json" : ["image/png", "image/jpeg"].includes(mime))) {
        throw new GatewayError(415, "CONTENT_TYPE", "Use the content type required by this showroom route.");
      }
      headers.set("Content-Type", contentType);
      body = await boundedBody(request, route.pairing ? 256 : route.voice ? 1_048_576 : route.body === "json" ? 16_384 : uploadLimit, controller.signal);
    }
    controller.signal.throwIfAborted();
    const response = await (options.fetch ?? fetch)(`${upstream}${path}${url.search}`, {
      method: request.method, headers, body: body ? Buffer.from(body) : undefined,
      signal: controller.signal, redirect: "manual", cache: "no-store", credentials: "omit",
    });
    const resultHeaders = new Headers(privateHeaders);
    for (const name of ["content-type", "content-range", "accept-ranges"]) {
      const value = response.headers.get(name);
      if (value) resultHeaders.set(name, value);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new GatewayError(502, "UPSTREAM_REDIRECT", "The showroom service returned an unexpected redirect.");
    }
    if (!response.ok) {
      const code = await upstreamErrorCode(response, controller.signal);
      await response.body?.cancel();
      cleanup();
      if (response.status === 416) {
        return new Response(null, { status: 416, headers: resultHeaders });
      }
      return failure(response.status, code, code === "REVISION_CONFLICT"
        ? "Refresh the showroom before retrying this action."
        : "The showroom service could not complete this request.");
    }
    const length = response.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > responseLimit)) {
      await response.body?.cancel();
      throw new GatewayError(502, "RESPONSE_TOO_LARGE", "The showroom response exceeds the download limit.");
    }
    if (!response.headers.has("content-encoding") && length) resultHeaders.set("Content-Length", length);
    if (request.method === "HEAD" || response.status === 204 || !response.body) {
      await response.body?.cancel();
      cleanup();
      return new Response(null, { status: response.status, headers: resultHeaders });
    }
    return new Response(responseStream(response.body, responseLimit, controller.signal, cleanup), {
      status: response.status, headers: resultHeaders,
    });
  } catch (error) {
    cleanup();
    if (error instanceof GatewayError) return failure(error.status, error.code, error.message);
    if (request.signal.aborted) return failure(499, "REQUEST_ABORTED", "The showroom request was cancelled.");
    if (timedOut) return failure(504, "UPSTREAM_TIMEOUT", "The showroom service did not respond in time.");
    return failure(502, "UPSTREAM_UNAVAILABLE", "The showroom service is unavailable.");
  }
}
