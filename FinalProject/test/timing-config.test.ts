import assert from "node:assert/strict";
import test from "node:test";
import { readConfig, SHOWROOM_SESSION_TTL_MS } from "../src/config.js";

test("showroom session and media safety defaults do not enforce the advisory two-minute target", () => {
  const config = readConfig({});
  assert.equal(config.SESSION_TTL_MS, 8 * 60 * 60_000);
  assert.equal(config.SESSION_TTL_MS, SHOWROOM_SESSION_TTL_MS);
  assert.equal(config.JOB_TIMEOUT_MS, 15 * 60_000);
  assert.ok(config.SESSION_TTL_MS > config.JOB_TIMEOUT_MS);
  assert.ok(config.JOB_TIMEOUT_MS > 120_000);
});

test("operators retain bounded control of job and session lifetimes", () => {
  const configured = readConfig({ JOB_TIMEOUT_MS: "600000", SESSION_TTL_MS: String(SHOWROOM_SESSION_TTL_MS) });
  assert.equal(configured.JOB_TIMEOUT_MS, 600_000);
  assert.equal(configured.SESSION_TTL_MS, SHOWROOM_SESSION_TTL_MS);
  assert.throws(() => readConfig({ JOB_TIMEOUT_MS: "1800001" }), /JOB_TIMEOUT_MS/);
  assert.throws(() => readConfig({ SESSION_TTL_MS: String(SHOWROOM_SESSION_TTL_MS + 1) }), /SESSION_TTL_MS/);
  assert.throws(() => readConfig({ JOB_TIMEOUT_MS: "0" }), /JOB_TIMEOUT_MS/);
});
