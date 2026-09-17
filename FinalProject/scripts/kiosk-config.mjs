import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

export async function optionalEnvironment(path) {
  try { return parseEnv(await readFile(path, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function port(value, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("Use a port between 1 and 65535.");
  return parsed;
}

export function launchOptions(args) {
  const result = {
    liveMedia: false, liveStudio: false, liveVoice: false, googleCalendar: false, windowsBridge: false,
    apiPort: 3101, uiPort: 3200, mediaPort: 3201, publicOrigin: undefined, startupTimeoutMs: 300_000,
  };
  const flags = {
    "--live-media": "liveMedia", "--live-studio": "liveStudio", "--live-voice": "liveVoice",
    "--google-calendar": "googleCalendar", "--windows-bridge": "windowsBridge",
  };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (Object.hasOwn(flags, name)) { result[flags[name]] = true; continue; }
    if (!["--api-port", "--ui-port", "--media-port", "--public-origin", "--startup-timeout-ms"].includes(name)) throw new Error(`Unsupported option: ${name}`);
    const value = args[++index];
    if (!value) throw new Error(`Missing value for ${name}.`);
    if (name === "--startup-timeout-ms") {
      const timeout = Number(value);
      if (!Number.isInteger(timeout) || timeout < 30_000 || timeout > 600_000) {
        throw new Error("Use a startup timeout between 30000 and 600000 milliseconds.");
      }
      result.startupTimeoutMs = timeout;
      continue;
    }
    if (name === "--public-origin") { result.publicOrigin = trustedPublicOrigin(value); continue; }
    const key = { "--api-port": "apiPort", "--ui-port": "uiPort", "--media-port": "mediaPort" }[name];
    result[key] = port(value);
  }
  if (new Set([result.apiPort, result.uiPort, result.mediaPort]).size !== 3) throw new Error("API, kiosk and media ports must be distinct.");
  if (result.liveMedia && result.liveStudio) throw new Error("Choose --live-studio or legacy --live-media, not both.");
  return result;
}

function trustedPublicOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Use an exact trusted HTTPS origin for --public-origin."); }
  if (value !== url.origin || url.username || url.password ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new Error("Use an exact trusted HTTPS origin (or local loopback origin) for --public-origin.");
  }
  return url.origin;
}

export function integrationEnvironments({
  parent = process.env, finalEnv = {}, movieEnv = {}, robotEnv = {}, options, deviceToken, mediaToken, studioToken = mediaToken, operatorToken,
}) {
  // An allowlist also blocks inherited NEXT_PUBLIC_* and new provider variables.
  const common = Object.fromEntries(Object.entries(parent).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|LANG|LC_[A-Z_]+|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|TERM|CI)$/i.test(key)));
  const apiOrigin = `http://127.0.0.1:${options.apiPort}`;
  const uiOrigin = `http://127.0.0.1:${options.uiPort}`;
  const publicOrigin = options.publicOrigin ? trustedPublicOrigin(options.publicOrigin) : uiOrigin;
  const mediaOrigin = `http://127.0.0.1:${options.mediaPort}`;
  const blockedSecrets = {
    OPENAI_API_KEY: "", EXA_API_KEY: "", GOOGLE_API_KEY: "", GEMINI_API_KEY: "",
    OPENROUTER_API_KEY: "", ANTHROPIC_API_KEY: "", MOVIE_API_TOKEN: "", MEDIA_SERVICE_TOKEN: "",
    GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", GOOGLE_REFRESH_TOKEN: "",
  };
  const anyLive = options.liveMedia || options.liveStudio || options.liveVoice || options.googleCalendar;
  const regularModel = finalEnv.REGULAR_MODEL || finalEnv.REASONING_MODEL ||
    (options.liveVoice ? robotEnv.REGULAR_MODEL : "") || "gpt-5.6-luna";
  const api = {
    ...common, ...blockedSecrets,
    HOST: "127.0.0.1", PORT: String(options.apiPort),
    BRIEF_PROVIDER: "mock", PROFILE_PROVIDER: "mock",
    MEDIA_PROVIDER: options.liveMedia ? "http" : "mock",
    JOB_PROVIDER: "local", FOLLOWUP_PROVIDER: "disabled",
    ALLOW_DEMO_FALLBACKS: "false", MOCK_ONLY: anyLive ? "false" : "true",
    DEMO_DEVICE_TOKEN: deviceToken,
    ALLOWED_HOSTS: "127.0.0.1,localhost",
    ALLOWED_ORIGINS: [...new Set([apiOrigin, uiOrigin, publicOrigin])].join(","),
    MEDIA_SERVICE_URL: options.liveMedia ? mediaOrigin : "",
    MEDIA_SERVICE_TOKEN: options.liveMedia ? mediaToken : "",
    SHOWROOM_MODE: options.liveStudio ? "studio" : "fixture",
    MOVIE_STUDIO_URL: options.liveStudio ? uiOrigin : "",
    MOVIE_API_TOKEN: options.liveStudio ? studioToken : "",
    VOICE_ENABLED: String(Boolean(options.liveVoice)),
    OPENAI_API_KEY: options.liveVoice ? finalEnv.OPENAI_API_KEY || robotEnv.OPENAI_API_KEY || "" : "",
    VOICE_MODEL: finalEnv.VOICE_MODEL || (options.liveVoice ? robotEnv.VOICE_MODEL : "") || "gpt-live-1",
    REASONING_MODEL: regularModel,
    REGULAR_MODEL: regularModel,
    SHOWROOM_BRIDGE_ENABLED: String(Boolean(options.windowsBridge)),
    SHOWROOM_OPERATOR_TOKEN: operatorToken || "",
    SHOWROOM_BRIDGE_ORIGINS: options.windowsBridge ? uiOrigin : "",
    CALENDAR_PROVIDER: options.googleCalendar ? "google" : "disabled",
    GOOGLE_CLIENT_ID: options.googleCalendar ? finalEnv.GOOGLE_CLIENT_ID || "" : "",
    GOOGLE_CLIENT_SECRET: options.googleCalendar ? finalEnv.GOOGLE_CLIENT_SECRET || "" : "",
    GOOGLE_REFRESH_TOKEN: options.googleCalendar ? finalEnv.GOOGLE_REFRESH_TOKEN || "" : "",
    GOOGLE_OAUTH_REDIRECT_URI: finalEnv.GOOGLE_OAUTH_REDIRECT_URI || `${apiOrigin}/oauth/google/callback`,
    GOOGLE_CALENDAR_ID: finalEnv.GOOGLE_CALENDAR_ID || "primary",
    SCHEDULING_TIME_ZONE: finalEnv.SCHEDULING_TIME_ZONE || "America/New_York",
    SCHEDULING_DURATION_MINUTES: "60",
    SCHEDULING_STAFF_EMAILS: options.googleCalendar ? finalEnv.SCHEDULING_STAFF_EMAILS || "" : "",
    SCHEDULING_LOCATION: finalEnv.SCHEDULING_LOCATION || "",
    SESSION_TTL_MS: finalEnv.SESSION_TTL_MS || "1800000",
    JOB_TIMEOUT_MS: finalEnv.JOB_TIMEOUT_MS || "60000",
  };
  const studioConfig = {};
  for (const key of [
    "OPENAI_VISION_MODEL", "OPENAI_DIRECTOR_MODEL", "OPENAI_IMAGE_MODEL", "OPENAI_VIDEO_MODEL", "VEO_MODEL",
    "CONTINUITY_POLICY", "STORYBOARD_MAX_ATTEMPTS", "STORYBOARD_CONCURRENCY", "MOVIE_DATA_DIR",
    "FFMPEG_PATH", "FFPROBE_PATH", "MOVIE_MUSIC_PATH",
  ]) {
    if (options.liveStudio && movieEnv[key]) studioConfig[key] = movieEnv[key];
  }
  const studio = {
    ...common, ...blockedSecrets, ...studioConfig,
    OPENAI_API_KEY: options.liveStudio ? movieEnv.OPENAI_API_KEY || "" : "",
    GEMINI_API_KEY: options.liveStudio ? movieEnv.GEMINI_API_KEY || "" : "",
    GOOGLE_API_KEY: options.liveStudio ? movieEnv.GOOGLE_API_KEY || "" : "",
    MOVIE_API_TOKEN: options.liveStudio ? studioToken : "",
  };
  const ui = {
    ...studio, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1",
    // Next otherwise reloads MoviePart/.env and defeats offline secret isolation.
    __NEXT_PROCESSED_ENV: "true",
    SHOWROOM_API_UPSTREAM: apiOrigin, SHOWROOM_PUBLIC_ORIGIN: publicOrigin,
  };
  const media = {
    ...common, ...blockedSecrets,
    OPENAI_API_KEY: options.liveMedia ? movieEnv.OPENAI_API_KEY || "" : "",
    OPENAI_IMAGE_MODEL: movieEnv.OPENAI_IMAGE_MODEL || "",
    MEDIA_SERVICE_TOKEN: options.liveMedia ? mediaToken : "",
    MEDIA_SERVICE_PORT: String(options.mediaPort),
    MOVIE_DATA_DIR: movieEnv.MOVIE_DATA_DIR || ".movie-data",
    ...(movieEnv.FFMPEG_PATH ? { FFMPEG_PATH: movieEnv.FFMPEG_PATH } : {}),
    ...(movieEnv.FFPROBE_PATH ? { FFPROBE_PATH: movieEnv.FFPROBE_PATH } : {}),
  };
  if (options.liveMedia && !media.OPENAI_API_KEY.trim()) {
    throw new Error("Live media requires OPENAI_API_KEY in MoviePart's private .env. Offline kiosk mode needs no provider credentials.");
  }
  if (options.liveStudio && (!studio.OPENAI_API_KEY.trim() || !(studio.GEMINI_API_KEY || studio.GOOGLE_API_KEY).trim() || !studioToken.trim())) {
    throw new Error("Live studio requires MoviePart's OpenAI and Google video keys and a private studio token.");
  }
  if (options.liveVoice && !api.OPENAI_API_KEY.trim()) {
    throw new Error("Live voice requires OPENAI_API_KEY in FinalProject's or RobotPart's private .env.");
  }
  if (options.googleCalendar && [api.GOOGLE_CLIENT_ID, api.GOOGLE_CLIENT_SECRET].some((value) => !value.trim())) {
    throw new Error("Google Calendar requires FinalProject's private Google client ID and client secret; connect OAuth before scheduling.");
  }
  if (options.windowsBridge && !operatorToken?.trim()) {
    throw new Error("The Windows bridge requires a private operator bootstrap token.");
  }
  return { api, ui, media, worker: studio, apiOrigin, uiOrigin, publicOrigin, mediaOrigin };
}

export function studioReady(value) {
  if (value?.providers?.openai?.available !== true || value?.providers?.veo?.available !== true) {
    throw new Error("The studio requires configured OpenAI models and Google Veo providers.");
  }
  if (value.renderer?.available !== true) throw new Error("The studio renderer is unavailable. Check private FFmpeg configuration.");
  if (!Array.isArray(value.products) || !value.products.some((product) => product.ready === true)) {
    throw new Error("No studio vehicle has a ready authorized reference pack. Prepare one before launching live studio.");
  }
  return value.worker?.available === true;
}

export function apiReady(value, options) {
  return value?.status === "ready" &&
    value.providers?.media === (options.liveMedia ? "http" : "mock") &&
    value.showroom?.mode === (options.liveStudio ? "studio" : "fixture") &&
    value.showroom?.voice?.enabled === Boolean(options.liveVoice) &&
    value.showroom?.calendar?.provider === (options.googleCalendar ? "google" : "disabled") &&
    value.showroom?.bridge?.enabled === Boolean(options.windowsBridge);
}
