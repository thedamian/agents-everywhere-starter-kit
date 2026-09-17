import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { MovieError } from "../domain";
import type { MovieConfig } from "../domain/services";
import { atomicWrite, readJson } from "./files";

export const SESSION_COOKIE = "movie_session";
const SESSION_AGE_SECONDS = 7 * 24 * 60 * 60;
const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function validateHost(request: Request): URL {
  let url: URL;
  let host: URL;
  try {
    url = new URL(request.url);
    const header = request.headers.get("host");
    if (!header || /[\/\\@?#\s]/.test(header)) throw new Error("Invalid host");
    host = new URL(`${url.protocol}//${header}`);
  } catch {
    throw new MovieError("UNTRUSTED_HOST", "Only direct loopback requests are allowed.", 403);
  }
  if (!["http:", "https:"].includes(url.protocol) || !allowedHosts.has(url.hostname) ||
      !allowedHosts.has(host.hostname) || host.port !== url.port) {
    throw new MovieError("UNTRUSTED_HOST", "Only direct loopback requests are allowed.", 403);
  }
  // Next normalizes request.url to localhost; the validated HTTP Host preserves
  // the origin the browser actually visited. Both names must still be loopback.
  url.host = host.host;
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) {
    throw new MovieError("UNTRUSTED_ORIGIN", "Cross-origin requests are not allowed.", 403);
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new MovieError("UNTRUSTED_ORIGIN", "Cross-site requests are not allowed.", 403);
  }
  return url;
}

export class SessionAuth {
  constructor(private readonly config: MovieConfig) {}

  async authenticate(request: Request, options: { mutation?: boolean; createSession?: boolean } = {}): Promise<{ ownerId: string; cookie?: string }> {
    const url = validateHost(request);
    const authorization = request.headers.get("authorization");
    if (authorization !== null) {
      const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      const configured = this.config.apiToken ?? "";
      if (!supplied || !configured || !timingSafeEqual(Buffer.from(digest(supplied)), Buffer.from(digest(configured)))) {
        throw new MovieError("UNAUTHORIZED", "A valid API token is required.", 401);
      }
      const scope = request.headers.get("x-movie-session-id");
      if (scope !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(scope)) {
        throw new MovieError("INVALID_SESSION_SCOPE", "Use a valid private movie session scope.", 400);
      }
      return { ownerId: `machine:${digest(configured)}${scope === null ? "" : `:${digest(scope)}`}` };
    }
    if (request.headers.has("x-movie-session-id")) {
      throw new MovieError("UNAUTHORIZED", "Session-scoped machine requests require an API token.", 401);
    }
    if (options.mutation && request.headers.get("origin") !== url.origin) {
      throw new MovieError("UNTRUSTED_ORIGIN", "Browser mutations require the same Origin as the app.", 403);
    }
    const cookies = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim());
    const tokens = cookies.filter(value => value.startsWith(`${SESSION_COOKIE}=`)).map(value => value.slice(SESSION_COOKIE.length + 1));
    const token = tokens.length === 1 ? tokens[0] : "";
    if (/^[a-f0-9]{64}$/.test(token)) {
      const session = await readJson(path.join(this.config.dataDir, "sessions", `${digest(token)}.json`)).catch(() => null) as
        { ownerId?: string; expiresAt?: number } | null;
      if (typeof session?.ownerId === "string" && typeof session.expiresAt === "number" && session.expiresAt > Date.now()) {
        return { ownerId: session.ownerId };
      }
    }
    if (!options.createSession) throw new MovieError("UNAUTHORIZED", "Open the app to establish a private session first.", 401);
    const fresh = randomBytes(32).toString("hex");
    const ownerId = `browser:${randomUUID()}`;
    await atomicWrite(path.join(this.config.dataDir, "sessions", `${digest(fresh)}.json`), JSON.stringify({
      ownerId, expiresAt: Date.now() + SESSION_AGE_SECONDS * 1000,
    }));
    return {
      ownerId,
      cookie: `${SESSION_COOKIE}=${fresh}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_AGE_SECONDS}${url.protocol === "https:" ? "; Secure" : ""}`,
    };
  }
}
