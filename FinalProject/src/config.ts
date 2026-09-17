import { z } from "zod";

const flag = z.enum(["true", "false"]).transform((value) => value === "true");
export const SHOWROOM_SESSION_TTL_MS = 8 * 60 * 60_000;
const positive = (fallback: number, max: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback);
const settings = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3101),
  BRIEF_PROVIDER: z.enum(["mock", "openai"]).default("mock"),
  PROFILE_PROVIDER: z.enum(["mock", "exa"]).default("mock"),
  MEDIA_PROVIDER: z.enum(["mock", "http"]).default("mock"),
  SHOWROOM_MODE: z.enum(["disabled", "fixture", "studio"]).default("disabled"),
  MOVIE_STUDIO_URL: z.url().default("http://127.0.0.1:3200"),
  MOVIE_API_TOKEN: z.string().optional(),
  VOICE_ENABLED: flag.default(false),
  VOICE_MODEL: z.string().min(1).default("gpt-live-1"),
  REGULAR_MODEL: z.string().min(1).optional(),
  REASONING_MODEL: z.string().min(1).optional(),
  SHOWROOM_BRIDGE_ENABLED: flag.default(false),
  SHOWROOM_OPERATOR_TOKEN: z.string().regex(/^[A-Za-z0-9._~-]{24,256}$/).optional(),
  SHOWROOM_BRIDGE_ORIGINS: z.string().optional(),
  JOB_PROVIDER: z.literal("local").default("local"),
  FOLLOWUP_PROVIDER: z.literal("disabled").default("disabled"),
  ALLOW_DEMO_FALLBACKS: flag.default(false),
  MOCK_ONLY: flag.default(false),
  DEMO_DEVICE_TOKEN: z.string().regex(/^[A-Za-z0-9._~-]{24,256}$/).optional(),
  ALLOWED_ORIGINS: z.string().optional(),
  ALLOWED_HOSTS: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  MODEL: z.string().optional(),
  EXA_API_KEY: z.string().optional(),
  MEDIA_SERVICE_URL: z.url().optional(),
  MEDIA_SERVICE_TOKEN: z.string().optional(),
  SESSION_TTL_MS: positive(SHOWROOM_SESSION_TTL_MS, SHOWROOM_SESSION_TTL_MS),
  JOB_TIMEOUT_MS: positive(15 * 60_000, 30 * 60_000),
  MAX_SESSIONS: positive(32, 128),
  MAX_QUEUED_JOBS: positive(4, 16),
  MAX_UPLOAD_BYTES: positive(5 * 1024 * 1024, 10 * 1024 * 1024),
  MAX_MEDIA_BYTES: positive(20 * 1024 * 1024, 100 * 1024 * 1024),
});

export type Config = ReturnType<typeof readConfig>;
export const isLoopback = (host: string) =>
  ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);

export function readConfig(environment: NodeJS.ProcessEnv = process.env) {
  const values = Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [key, value?.trim() || undefined]),
  );
  const parsed = settings.safeParse(values);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}. Trigger and follow-up deployment are not enabled; use JOB_PROVIDER=local and FOLLOWUP_PROVIDER=disabled.`);
  }
  const config = parsed.data;
  const origins = (config.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const origin of origins) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new Error("ALLOWED_ORIGINS must contain exact HTTP(S) origins."); }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin || url.username || url.password) {
      throw new Error("ALLOWED_ORIGINS must contain exact HTTP(S) origins without paths or credentials.");
    }
  }
  const hosts = (config.ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (hosts.some((host) => host.includes("*") || /[/?#@\s]/.test(host))) {
    throw new Error("ALLOWED_HOSTS must be exact hostnames/IPs without wildcards or paths.");
  }
  if (!isLoopback(config.HOST) && (!config.DEMO_DEVICE_TOKEN || !origins.length || !hosts.length)) {
    throw new Error("LAN access requires DEMO_DEVICE_TOKEN, ALLOWED_HOSTS and ALLOWED_ORIGINS.");
  }
  if (config.MOCK_ONLY && (config.BRIEF_PROVIDER !== "mock" || config.PROFILE_PROVIDER !== "mock" || config.MEDIA_PROVIDER !== "mock")) {
    throw new Error("MOCK_ONLY forbids real providers.");
  }
  if (config.BRIEF_PROVIDER === "openai" && (!config.OPENAI_API_KEY || !config.MODEL)) {
    throw new Error("OpenAI brief mode requires OPENAI_API_KEY and MODEL.");
  }
  if (config.PROFILE_PROVIDER === "exa" && !config.EXA_API_KEY) {
    throw new Error("Exa profile mode requires EXA_API_KEY.");
  }
  if (config.MEDIA_PROVIDER === "http") {
    if (!config.MEDIA_SERVICE_URL || !config.MEDIA_SERVICE_TOKEN) {
      throw new Error("HTTP media mode requires MEDIA_SERVICE_URL and MEDIA_SERVICE_TOKEN.");
    }
    const url = new URL(config.MEDIA_SERVICE_URL);
    if (url.username || url.password || url.search || url.hash ||
        (!isLoopback(url.hostname) && url.protocol !== "https:") ||
        !["http:", "https:"].includes(url.protocol)) {
      throw new Error("Media service must use HTTPS (or loopback HTTP), without credentials, query or fragment in its URL.");
    }
  }
  if (config.SHOWROOM_MODE === "studio") {
    const url = new URL(config.MOVIE_STUDIO_URL);
    if (!config.MOVIE_API_TOKEN || !isLoopback(url.hostname) || !["http:", "https:"].includes(url.protocol)
        || url.pathname !== "/" || url.username || url.password || url.search || url.hash || config.MOCK_ONLY) {
      throw new Error("Studio showroom mode requires a loopback MOVIE_STUDIO_URL and MOVIE_API_TOKEN; MOCK_ONLY cannot use it.");
    }
  }
  if (config.VOICE_ENABLED && (!config.OPENAI_API_KEY || config.SHOWROOM_MODE === "disabled" || config.MOCK_ONLY)) {
    throw new Error("Live voice requires OPENAI_API_KEY and an enabled showroom; MOCK_ONLY cannot stream live voice.");
  }
  if (config.REGULAR_MODEL && config.REASONING_MODEL && config.REGULAR_MODEL !== config.REASONING_MODEL) {
    throw new Error("REGULAR_MODEL and its REASONING_MODEL compatibility alias must agree.");
  }
  const bridgeOrigins = (config.SHOWROOM_BRIDGE_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (config.SHOWROOM_BRIDGE_ENABLED && (!config.SHOWROOM_OPERATOR_TOKEN || !bridgeOrigins.length || config.SHOWROOM_MODE === "disabled")) {
    throw new Error("An enabled bridge requires SHOWROOM_OPERATOR_TOKEN, exact SHOWROOM_BRIDGE_ORIGINS and an enabled showroom.");
  }
  for (const origin of bridgeOrigins) {
    const url = new URL(origin);
    if (!isLoopback(url.hostname) || url.origin !== origin || !["http:", "https:"].includes(url.protocol)) {
      throw new Error("SHOWROOM_BRIDGE_ORIGINS must be exact loopback HTTP(S) origins.");
    }
  }
  return {
    ...config,
    regularModel: config.REGULAR_MODEL ?? config.REASONING_MODEL ?? "gpt-5.6-luna",
    bridgeOrigins,
    allowedOrigins: origins,
    allowedHosts: [...new Set(["localhost", "127.0.0.1", "[::1]", ...hosts])],
  };
}
