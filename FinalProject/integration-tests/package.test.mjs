import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const runFile = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const repository = resolve(root, "..");
const runtimeRoot = resolve(repository, "packages", "showroom-runtime");
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOME|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA)$/i.test(name)));
Object.assign(environment, {
  SHOWROOM_MODE: "disabled", VOICE_ENABLED: "false", SHOWROOM_BRIDGE_ENABLED: "false",
  CALENDAR_PROVIDER: "disabled", CI: "true", NO_COLOR: "1",
});

function inside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

async function run(command, args, cwd, timeout = 120_000) {
  try {
    return await runFile(command, args, {
      cwd, env: environment, encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`${command} failed: ${error.stderr ?? ""}\n${error.stdout ?? ""}`, { cause: error });
  }
}

async function canonicalRuntimeFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) files.push(...await canonicalRuntimeFiles(resolve(directory, entry.name), `${name}/`));
    else files.push(name);
  }
  return files;
}

test("demo archive restores and starts outside the checkout with its canonical runtime", { timeout: 900_000 }, async (t) => {
  const originalManifest = await readFile(resolve(root, "package.json"));
  const originalLock = await readFile(resolve(root, "package-lock.json"));
  await run(process.execPath, ["scripts/package.mjs"], root);
  assert.deepEqual(await readFile(resolve(root, "package.json")), originalManifest);
  assert.deepEqual(await readFile(resolve(root, "package-lock.json")), originalLock);

  const extracted = await mkdtemp(resolve(tmpdir(), "magicpitch-package-test-"));
  t.after(() => rm(extracted, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  assert.equal(inside(repository, await realpath(extracted)), false, "The archive must be tested outside the checkout.");
  await run("tar", ["-xzf", resolve(root, "artifacts", "magicpitch-demo.tgz"), "-C", extracted], root);

  const manifest = JSON.parse(await readFile(resolve(extracted, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(resolve(extracted, "package-lock.json"), "utf8"));
  const dependency = "@magicpitch/showroom-runtime";
  assert.equal(manifest.dependencies[dependency], "file:vendor/showroom-runtime");
  assert.equal(lock.packages[""].dependencies[dependency], manifest.dependencies[dependency]);
  assert.equal(lock.packages[`node_modules/${dependency}`].resolved, "vendor/showroom-runtime");
  assert.equal(lock.packages[`node_modules/${dependency}`].link, true);
  assert.ok(lock.packages["vendor/showroom-runtime"]);
  assert.equal(Object.hasOwn(lock.packages, "../packages/showroom-runtime"), false);
  const restoredManifest = structuredClone(manifest);
  const restoredLock = structuredClone(lock);
  restoredManifest.dependencies[dependency] = "file:../packages/showroom-runtime";
  restoredLock.packages[""].dependencies[dependency] = "file:../packages/showroom-runtime";
  restoredLock.packages[`node_modules/${dependency}`].resolved = "../packages/showroom-runtime";
  restoredLock.packages["../packages/showroom-runtime"] = restoredLock.packages["vendor/showroom-runtime"];
  delete restoredLock.packages["vendor/showroom-runtime"];
  assert.deepEqual(restoredManifest, JSON.parse(originalManifest));
  assert.deepEqual(restoredLock, JSON.parse(originalLock), "Registry dependency locks must be preserved.");

  const expectedRuntime = [
    "package.json", "README.md",
    ...await canonicalRuntimeFiles(resolve(runtimeRoot, "browser"), "browser/"),
    ...await canonicalRuntimeFiles(resolve(runtimeRoot, "server"), "server/"),
  ].sort();
  const vendored = resolve(extracted, "vendor", "showroom-runtime");
  assert.deepEqual((await canonicalRuntimeFiles(vendored)).sort(), expectedRuntime);
  for (const file of expectedRuntime) {
    assert.deepEqual(await readFile(resolve(vendored, file)), await readFile(resolve(runtimeRoot, file)), `Changed canonical runtime file: ${file}`);
  }

  // Use npm's JS entry point, not a Windows command shell or a checkout-local install.
  const npmCli = process.env.npm_execpath ?? (process.platform === "win32"
    ? resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : await realpath(resolve(dirname(process.execPath), "npm")));
  await run(process.execPath, [npmCli, "ci", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], extracted, 600_000);
  assert.equal((await readdir(resolve(extracted, "node_modules"))).includes("tsx"), false);
  assert.deepEqual(await readFile(resolve(extracted, "package.json")), Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  assert.deepEqual(JSON.parse(await readFile(resolve(extracted, "package-lock.json"), "utf8")), lock);
  await run(process.execPath, [npmCli, "ls", "--omit=dev", "--all", "--json"], extracted);

  const probe = `
    import assert from "node:assert/strict";
    import { realpath } from "node:fs/promises";
    import { relative, isAbsolute, sep } from "node:path";
    import { fileURLToPath } from "node:url";
    const root = await realpath(process.cwd());
    for (const name of ["@magicpitch/showroom-runtime/server", "@magicpitch/showroom-runtime/assets",
      "@hono/node-server", "ffprobe-static", "hono", "sharp", "ws", "zod"]) {
      const resolved = await realpath(fileURLToPath(import.meta.resolve(name)));
      const path = relative(root, resolved);
      assert.ok(!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep), name + " escaped extraction");
      await import(name);
    }
    await import("./dist/providers/voice.js");
    console.log("isolated_runtime_import_ok");
  `;
  const imported = await run(process.execPath, ["--import", "./scripts/offline-network-guard.mjs", "--input-type=module", "-e", probe], extracted);
  assert.match(imported.stdout, /isolated_runtime_import_ok/);
  const smoke = await run(process.execPath, ["--import", "./scripts/offline-network-guard.mjs", "scripts/smoke.mjs"], extracted);
  assert.match(smoke.stdout, /"event":"smoke_passed"/);
  assert.doesNotMatch(smoke.stderr, /network_blocked/);
});
