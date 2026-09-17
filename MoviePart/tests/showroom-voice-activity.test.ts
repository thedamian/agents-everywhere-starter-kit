import assert from "node:assert/strict";
import test from "node:test";
import { audioActivity } from "../src/kiosk/voice-activity";

test("the face only speaks for actual audible samples and never for muted/paused audio", () => {
  assert.equal(audioActivity(new Float32Array(128), true), 0);
  assert.equal(audioActivity(new Float32Array(128).fill(0.005), true), 0);
  assert.equal(audioActivity(new Float32Array(128).fill(0.1), false), 0);
  assert.ok(audioActivity(new Float32Array(128).fill(0.1), true) > 0.5);
  assert.equal(audioActivity(new Float32Array(128).fill(1), true), 1);
  assert.equal(audioActivity(new Float32Array([NaN]), true), 0);
});
