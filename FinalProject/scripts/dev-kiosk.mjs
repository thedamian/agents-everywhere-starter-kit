import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { integrationEnvironments, launchOptions, optionalEnvironment, studioReady, apiReady } from "./kiosk-config.mjs";
import { persistentStudioCredential } from "./studio-credential.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const movieRoot = resolve(root, "..", "MoviePart");
const children = [];
let closing = false;
let shutdown;
let resolveStopped;
const stopped = new Promise((resolve) => { resolveStopped = resolve; });
let failed = false;

async function freePort(port) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", () => reject(new Error(`Port ${port} is already in use. Choose another port; no existing process was stopped.`)));
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}

function start(name, args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env, shell: false, windowsHide: true, stdio: "inherit" });
  children.push({ name, child });
  child.once("error", () => {
    console.error(`${name} could not be started.`);
    failed = true;
    void stop();
  });
  child.once("exit", (code, signal) => {
    if (!closing) {
      console.error(`${name} exited before shutdown (status ${code ?? signal}).`);
      failed = true;
      void stop();
    }
  });
}

async function stop() {
  if (shutdown) return shutdown;
  closing = true;
  shutdown = (async () => {
    for (const { child } of [...children].reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exit = new Promise((resolve) => child.once("exit", resolve));
      if (process.platform === "win32") {
        // Next dev can own a worker process. Target only this launcher's child PID tree.
        await new Promise((resolve, reject) => {
          const taskkill = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
          taskkill.once("error", reject);
          taskkill.once("exit", (code) => code === 0 || child.exitCode !== null || child.signalCode !== null ? resolve() : reject(new Error("Could not stop owned child process tree.")));
        });
      } else {
        child.kill("SIGTERM");
      }
      await Promise.race([exit, delay(4_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([exit, delay(2_000)]);
      }
    }
  })().catch(() => {
    failed = true;
    console.error("An owned process did not shut down cleanly. Inspect its PID and any media cleanup receipts.");
  }).finally(() => resolveStopped());
  return shutdown;
}

async function waitFor(url, predicate, headers = {}, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !closing) {
    let response;
    try { response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(5_000) }); } catch {
      await delay(150);
      continue;
    }
    if (await predicate(response)) {
      if (!response.bodyUsed) await response.body?.cancel();
      return;
    }
    if (!response.bodyUsed) await response.body?.cancel();
    await delay(250);
  }
  throw new Error("A local service did not become ready. Review startup output; no participant image was submitted.");
}

try {
  const options = launchOptions(process.argv.slice(2));
  if (options.windowsBridge && process.platform !== "win32") {
    throw new Error("--windows-bridge requires the approved Windows Chrome operator host.");
  }
  for (const file of [resolve(root, "dist", "server.js"), resolve(movieRoot, "node_modules", "next", "dist", "bin", "next")]) {
    try { await access(file); } catch {
      throw new Error("Build FinalProject and install MoviePart dependencies first: npm --prefix FinalProject run build; npm --prefix MoviePart ci.");
    }
  }
  const finalEnv = await optionalEnvironment(resolve(root, ".env"));
  const movieEnv = options.liveMedia || options.liveStudio ? await optionalEnvironment(resolve(movieRoot, ".env")) : {};
  const robotEnv = options.liveVoice ? await optionalEnvironment(resolve(root, "..", "RobotPart", ".env")) : {};
  const deviceToken = randomBytes(32).toString("base64url");
  const mediaToken = randomBytes(32).toString("base64url");
  const studioToken = options.liveStudio ? await persistentStudioCredential(resolve(root, ".runtime"), [
    finalEnv.MOVIE_API_TOKEN, movieEnv.MOVIE_API_TOKEN,
  ]) : "";
  const operatorToken = randomBytes(32).toString("base64url");
  const env = integrationEnvironments({ options, deviceToken, mediaToken, studioToken, operatorToken, finalEnv, movieEnv, robotEnv });
  for (const port of [options.apiPort, options.uiPort, ...(options.liveMedia ? [options.mediaPort] : [])]) await freePort(port);
  await mkdir(resolve(root, ".runtime"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(root, ".runtime", "device-token"), `${deviceToken}\n`, { mode: 0o600 });
  await writeFile(resolve(root, ".runtime", "showroom-operator-token"), `${operatorToken}\n`, { mode: 0o600 });
  if (options.liveMedia) await writeFile(resolve(root, ".runtime", "media-service-token"), `${mediaToken}\n`, { mode: 0o600 });
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  if (options.liveMedia) {
    start("MoviePart media", ["--import", "tsx", "scripts/media-service.ts"], movieRoot, env.media);
    await waitFor(`${env.mediaOrigin}/capabilities`, async (response) => {
      if (response.status === 401 || response.status === 503) {
        throw new Error("MoviePart media is not authorized or ready. Check MoviePart's key and FFmpeg configuration.");
      }
      if (!response.ok) return false;
      const value = await response.json();
      return value.schemaVersion === 1 && value.cancelByKey === true && value.deleteAssets === true;
    }, { Authorization: `Bearer ${mediaToken}` });
  }
  if (options.liveStudio) {
    start("MoviePart studio web", ["node_modules/next/dist/bin/next", "dev", "-H", "127.0.0.1", "-p", String(options.uiPort)], movieRoot, env.ui);
    start("MoviePart studio worker", ["--import", "tsx", "scripts/worker.ts"], movieRoot, env.worker);
    await waitFor(`${env.uiOrigin}/api/movie-config`, async (response) => {
      if (response.status === 401 || response.status === 403) throw new Error("The studio rejected its private machine token.");
      if (!response.ok) return false;
      return studioReady(await response.json());
    }, { Authorization: `Bearer ${studioToken}` }, options.startupTimeoutMs);
  }
  start("MagicPitch API", ["dist/server.js"], root, env.api);
  await waitFor(`${env.apiOrigin}/readyz`, async (response) => {
    if (!response.ok) return false;
    return apiReady(await response.json(), options);
  });
  if (!options.liveStudio) {
    start("MoviePart kiosk", ["node_modules/next/dist/bin/next", "dev", "-H", "127.0.0.1", "-p", String(options.uiPort)], movieRoot, env.ui);
  }
  await waitFor(`${env.uiOrigin}/kiosk`, async (response) => response.ok, {}, options.startupTimeoutMs);
  console.log(JSON.stringify({
    event: "kiosk_integration_ready",
    kiosk: `${env.publicOrigin}/kiosk`, localKiosk: `${env.uiOrigin}/kiosk`, api: env.apiOrigin,
    publicHttpsVerified: false,
    media: options.liveStudio ? "full creator studio worker" : options.liveMedia ? env.mediaOrigin : "synthetic mock fixture",
    pairingFile: resolve(root, ".runtime", "device-token"),
    operatorBootstrapFile: resolve(root, ".runtime", "showroom-operator-token"),
    operatorBridge: options.windowsBridge ? `${env.uiOrigin}/robot-bridge?apiPort=${options.apiPort}` : "disabled",
    capabilities: {
      studio: options.liveStudio, voice: options.liveVoice, calendar: options.googleCalendar, windowsBridge: options.windowsBridge,
    },
    mode: options.liveStudio ? "live-studio-opt-in" : options.liveMedia ? "live-media-opt-in" : "mock-film",
  }));
  if (env.publicOrigin !== env.uiOrigin) {
    console.log("Configure and verify the trusted HTTPS proxy separately when using a remote customer display. This launcher does not start a tunnel or verify tablet certificate trust.");
  }
  await stopped;
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : "Kiosk integration startup failed.");
  await stop();
}
process.exitCode = failed ? 1 : 0;
