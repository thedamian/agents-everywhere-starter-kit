import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { integrationEnvironments, launchOptions } from "../../FinalProject/scripts/kiosk-config.mjs";

test("Next environment loading cannot inject fixture dotenv secrets into an offline kiosk child", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "showroom-env-test-"));
  try {
    await writeFile(path.join(directory, ".env.local"), "OPENAI_API_KEY=fake-test-key\nNEXT_PUBLIC_FAKE_SECRET=fake-test-secret\n");
    const { ui } = integrationEnvironments({
      options: launchOptions([]), parent: process.env, deviceToken: "fake-device", mediaToken: "fake-media",
    });
    const output = execFileSync(process.execPath, ["-e", `
      const { loadEnvConfig } = require("@next/env");
      loadEnvConfig(process.argv[1]);
      console.log(JSON.stringify({
        key: process.env.OPENAI_API_KEY,
        injected: process.env.NEXT_PUBLIC_FAKE_SECRET,
        processed: process.env.__NEXT_PROCESSED_ENV
      }));
    `, directory], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: ui, encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(output), { key: "", processed: "true" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
