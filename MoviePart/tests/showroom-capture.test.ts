import assert from "node:assert/strict";
import test from "node:test";
import { CAPTURE_LIMITS, ReferenceCapture, hashDistance, qualityProblem, pixelQuality } from "../src/kiosk/capture";
import type { CaptureMetrics, CaptureView, NormalizedPhoto } from "../src/kiosk/capture";

const hash = (i: number) => Array.from({ length: 64 }, (_, n) => String((Math.floor(n / (2 ** i))) % 2)).join("");
function setup() {
  let now = 1000, serial = 0;
  const revoked: string[] = [];
  const capture = new ReferenceCapture({
    now: () => now, uuid: () => String(++serial),
    urls: { createObjectURL: () => `blob:${serial}`, revokeObjectURL: url => revoked.push(url) },
  });
  const metrics = (view: CaptureView = "front_face", index = 0): CaptureMetrics => ({
    timestamp: now, people: 1, tracked: true, stable: true, robotStopped: true, view,
    light: 120, sharpness: 100, perceptualHash: hash(index),
  });
  const photo = (index = 0, size = 30): NormalizedPhoto => ({
    blob: new Blob([new Uint8Array(size)], { type: "image/jpeg" }),
    width: 640, height: 480, sha256: String(index).padStart(64, "0"),
  });
  return { capture, metrics, photo, revoked, advance: (ms: number) => { now += ms; } };
}

test("never reads a full frame before both informed permissions", async () => {
  const f = setup(); let reads = 0;
  const read = async () => { reads++; return f.photo(); };
  await f.capture.consider(f.metrics(), read);
  f.capture.authorize(true, false);
  f.advance(1000);
  await f.capture.consider(f.metrics(), read);
  await assert.rejects(f.capture.addManual(f.metrics(), read), /permission/);
  assert.equal(reads, 0);
  f.capture.authorize(true, true);
  await f.capture.consider(f.metrics(), read);
  f.advance(799);
  await f.capture.consider(f.metrics(), read);
  assert.equal(reads, 0);
  f.advance(1);
  assert.equal(await f.capture.consider(f.metrics(), read), true);
  assert.equal(reads, 1);
});

test("requires 1-4 normalized photos, prefers front face, and freezes exact selection", async () => {
  const f = setup();
  f.capture.authorize(true, true);
  assert.throws(() => f.capture.freeze(), /one to four/);
  const views: CaptureView[] = ["half_body", "front_face", "profile", "three_quarter"];
  for (const [i, view] of views.entries()) await f.capture.addManual(f.metrics(view, i), async () => f.photo(i));
  assert.equal(f.capture.getState().references.length, 4);
  assert.equal(f.capture.getState().primaryId, "2");
  assert.equal(f.capture.getState().status, "complete");
  await assert.rejects(f.capture.addManual(f.metrics(), async () => f.photo(5)), /four/);
  const refs = f.capture.freeze();
  assert.equal(refs.length, 4);
  assert.throws(() => f.capture.remove("1"), /frozen/);
  await assert.rejects(f.capture.addManual(f.metrics(), async () => f.photo()), /frozen/);
  assert.equal(await f.capture.consider(f.metrics(), async () => f.photo()), false);
  assert.equal(f.capture.getState().references, refs);
});

test("rejects exact and near duplicates and supports explicit remove/retake", async () => {
  const f = setup(); f.capture.authorize(true, true);
  await f.capture.addManual(f.metrics(), async () => f.photo());
  assert.equal(await f.capture.addManual(f.metrics("profile", 1), async () => f.photo()), false);
  const near = f.metrics("profile");
  near.perceptualHash = near.perceptualHash.split("").map((v, i) => i < 6 ? String(1 - Number(v)) : v).join("");
  assert.equal(hashDistance(near.perceptualHash, f.metrics().perceptualHash), 6);
  assert.equal(await f.capture.addManual(near, async () => f.photo(1)), false);
  f.capture.remove("1");
  assert.deepEqual(f.revoked, ["blob:1"]);
  await f.capture.addManual(f.metrics(), async () => f.photo());
  assert.equal(f.capture.getState().references.length, 1);
});

test("multiple/lost people or unconfirmed motion pause until deliberate resume", async () => {
  for (const changes of [{ people: 2 }, { people: 0 }, { tracked: false }, { robotStopped: false }]) {
    const f = setup(); f.capture.authorize(true, true);
    let reads = 0;
    const read = async () => { reads++; return f.photo(); };
    await f.capture.consider({ ...f.metrics(), ...changes }, read);
    assert.equal(f.capture.getState().status, "paused");
    f.advance(1000);
    await f.capture.consider(f.metrics(), read);
    assert.equal(reads, 0);
    f.capture.resume();
    await f.capture.consider(f.metrics(), read);
    f.advance(800);
    await f.capture.consider(f.metrics(), read);
    assert.equal(reads, 1);
  }
});

test("revocation fences in-flight frames and releases every preview", async () => {
  const f = setup(); f.capture.authorize(true, true);
  await f.capture.addManual(f.metrics(), async () => f.photo());
  let resolve!: (photo: NormalizedPhoto) => void;
  const pending = f.capture.addManual(f.metrics("profile", 1), () => new Promise(r => { resolve = r; }));
  f.capture.authorize(false, true);
  resolve(f.photo(1));
  assert.equal(await pending, false);
  assert.deepEqual(f.revoked, ["blob:1"]);
  assert.equal(f.capture.getState().references.length, 0);
  assert.equal(f.capture.getState().status, "off");
});

test("quality limits include exact illumination/sharpness/sample age boundaries", () => {
  const f = setup();
  for (const [field, value] of [["light", 44], ["light", 226], ["sharpness", 79], ["timestamp", 499]] as const) {
    assert.ok(qualityProblem({ ...f.metrics(), [field]: value }, 1000));
  }
  assert.equal(qualityProblem({ ...f.metrics(), light: 45, sharpness: 80, timestamp: 500 }, 1000), null);
  assert.equal(qualityProblem({ ...f.metrics(), light: 225 }, 1000), null);
  assert.ok(qualityProblem({ ...f.metrics(), timestamp: 1001 }, 1000));
});

test("exact byte and pixel bounds are enforced without creating rejected previews", async () => {
  const f = setup(); f.capture.authorize(true, true);
  await assert.rejects(f.capture.addManual(f.metrics(), async () => f.photo(0, CAPTURE_LIMITS.imageBytes + 1)), /5 MiB/);
  await assert.rejects(f.capture.addManual(f.metrics(), async () => ({ ...f.photo(), width: 319 })), /320/);
  await assert.rejects(f.capture.addManual(f.metrics(), async () => ({ ...f.photo(), width: 6001, height: 4000 })), /5 MiB/);
  const views: CaptureView[] = ["front_face", "half_body", "profile", "three_quarter"];
  for (let i = 0; i < 4; i++) await f.capture.addManual(f.metrics(views[i], i), async () => f.photo(i, CAPTURE_LIMITS.imageBytes));
  assert.equal(f.capture.getState().references.reduce((bytes, ref) => bytes + ref.blob.size, 0), CAPTURE_LIMITS.totalBytes);
});

test("uniform low-detail sample is blurry rather than accepted as a face", () => {
  const sample = new Uint8ClampedArray(16 * 16 * 4).fill(100);
  const metrics = pixelQuality(sample, 16, 16);
  assert.ok(Math.abs(metrics.light - 100) < 0.001);
  assert.equal(metrics.sharpness, 0);
  assert.equal(metrics.perceptualHash.length, 64);
});
