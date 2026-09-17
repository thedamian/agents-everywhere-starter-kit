import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
await rm(resolve(root, "dist"), { recursive: true, force: true });
const compiler = spawn(process.execPath, [
  resolve(root, "node_modules", "typescript", "bin", "tsc"), "-p", resolve(root, "tsconfig.build.json"),
], { cwd: root, stdio: "inherit", shell: false });
compiler.once("error", () => {
  console.error("Could not start the TypeScript production compiler.");
  process.exitCode = 1;
});
compiler.once("exit", (code, signal) => { process.exitCode = signal ? 1 : (code ?? 1); });
