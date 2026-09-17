import { loadConfig } from "../src/server/config";

const config = loadConfig();
if (!config.googleKey) {
  console.error("FAIL: Set GEMINI_API_KEY (preferred) or GOOGLE_API_KEY in MoviePart/.env.");
  process.exitCode = 1;
} else if (!/^veo-3\.1-(?:fast-)?generate(?:-preview)?$/.test(config.veoModel)) {
  console.error(`FAIL: ${config.veoModel} is not supported by Movie Magic's first/last-frame workflow.`);
  process.exitCode = 1;
} else {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.veoModel)}`, {
    headers: { "x-goog-api-key": config.googleKey },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json() as {
    name?: string;
    displayName?: string;
    supportedGenerationMethods?: string[];
    error?: { code?: number; status?: string };
  };
  if (!response.ok) {
    console.error(`FAIL: Google returned HTTP ${response.status}${payload.error?.status ? ` (${payload.error.status})` : ""}.`);
    console.error(response.status === 401 || response.status === 403
      ? "Check the API key, Generative Language API restrictions, project access, and paid-tier billing."
      : response.status === 429
        ? "Check the project's Veo quota, spend limit, and billing in Google AI Studio."
        : "Check VEO_MODEL and Google service availability.");
    process.exitCode = 1;
  } else if (!payload.supportedGenerationMethods?.includes("predictLongRunning")) {
    console.error(`FAIL: ${payload.name ?? config.veoModel} does not advertise predictLongRunning video generation.`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: Credential can access ${payload.displayName ?? payload.name ?? config.veoModel}.`);
    console.log("PASS: Model advertises predictLongRunning video generation.");
    console.log("PASS: Movie Magic will submit 8s, 16:9, 720p, one video, adult-person enabled, native audio, prompt enhancement, and approved 1280x720 first/last frames.");
    console.log("NOTE: This no-charge check cannot prove paid-tier billing, remaining Veo quota, capacity, or that a specific prompt will pass safety review.");
    console.log("Verify those in https://aistudio.google.com/projects and https://aistudio.google.com/rate-limit?timeRange=last-28-days.");
  }
}
