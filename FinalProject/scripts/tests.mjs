import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const valueOptions = new Set([
  "--test-name-pattern", "--test-skip-pattern", "--test-reporter",
  "--test-reporter-destination", "--test-concurrency", "--test-timeout",
  "--test-shard", "--test-isolation",
]);
const options = [];
const paths = [];
const args = process.argv.slice(2);

async function discover(path) {
  const entry = await stat(path);
  if (!entry.isDirectory()) {
    if (!path.endsWith(".test.ts")) throw new Error("Test paths must select .test.ts files.");
    return [path];
  }
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter((item) => !item.isSymbolicLink() && (item.isDirectory() || item.name.endsWith(".test.ts")))
    .map((item) => discover(resolve(path, item.name))));
  return nested.flat();
}

try {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument.startsWith("-")) {
      options.push(argument);
      if (valueOptions.has(argument)) {
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
        options.push(value);
      }
    } else {
      paths.push(resolve(process.cwd(), argument));
    }
  }
  const files = [...new Set((await Promise.all(
    (paths.length ? paths : [resolve(root, "test"), resolve(root, "src")]).map(discover),
  )).flat())].sort();
  if (!files.length) throw new Error("No .test.ts files found.");
  const child = spawn(process.execPath, [
    "--import", "./scripts/offline-network-guard.mjs",
    "--import", "tsx", "--test", ...options, ...files,
  ], { cwd: root, stdio: "inherit", shell: false });
  child.once("error", () => {
    console.error("Could not start the Node test runner.");
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => { process.exitCode = signal ? 1 : (code ?? 1); });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
