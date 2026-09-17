import assert from "node:assert/strict";
import test from "node:test";
import { ShowroomCamera } from "../src/kiosk/camera";
import type { VisionModels } from "../src/kiosk/camera";
import { ReferenceCapture } from "../src/kiosk/capture";

function fakeVideo() {
  return Object.assign(new EventTarget(), {
    srcObject: null, readyState: 0, videoWidth: 0, videoHeight: 0,
    play: async () => {}, pause: () => {},
  }) as HTMLVideoElement;
}
function fakeStream() {
  let stopped = 0;
  const track = Object.assign(new EventTarget(), { stop: () => { stopped++; } }) as MediaStreamTrack;
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as MediaStream;
  return { stream, track, stopped: () => stopped };
}

test("camera does not load models, open hardware or decode manual files before consent", async () => {
  const capture = new ReferenceCapture();
  let models = 0, media = 0;
  const camera = new ShowroomCamera(capture, {
    video: fakeVideo(), permitted: () => false, robotStopped: () => true,
    onUnsafe() {}, onStatus() {}, onError() {},
    models: async () => { models++; throw new Error("Must not load"); },
    getUserMedia: async () => { media++; throw new Error("Must not open"); },
  });
  await assert.rejects(camera.start(), /permission/);
  await assert.rejects(camera.upload(new File(["not an image"], "photo.jpg", { type: "image/jpeg" })), /permission/);
  assert.equal(models, 0); assert.equal(media, 0);
  camera.stop();
});

test("revoked permission during model setup closes models before any media request", async () => {
  let permitted = true, closed = 0, media = 0;
  let resolve!: (models: VisionModels) => void;
  const capture = new ReferenceCapture(); capture.authorize(true, true);
  const camera = new ShowroomCamera(capture, {
    video: fakeVideo(), permitted: () => permitted, robotStopped: () => true,
    onUnsafe() {}, onStatus() {}, onError() {},
    models: () => new Promise(r => { resolve = r; }),
    getUserMedia: async () => { media++; return fakeStream().stream; },
  });
  const pending = camera.start();
  permitted = false; capture.clear();
  resolve({ observe: () => ({ faces: [], poses: [] }), close: () => { closed++; } });
  await pending;
  assert.equal(closed, 1); assert.equal(media, 0);
  camera.stop();
});

test("late getUserMedia after revocation stops every track and never publishes active", async () => {
  let permitted = true, closed = 0;
  let resolve!: (stream: MediaStream) => void;
  const media = fakeStream(), statuses: boolean[] = [], capture = new ReferenceCapture();
  capture.authorize(true, true);
  const camera = new ShowroomCamera(capture, {
    video: fakeVideo(), permitted: () => permitted, robotStopped: () => true,
    onUnsafe() {}, onStatus: status => statuses.push(status), onError() {},
    models: async () => ({ observe: () => ({ faces: [], poses: [] }), close: () => { closed++; } }),
    getUserMedia: () => new Promise(r => { resolve = r; }),
  });
  const pending = camera.start();
  await Promise.resolve();
  permitted = false; capture.clear();
  resolve(media.stream); await pending;
  assert.equal(media.stopped(), 1);
  assert.equal(closed, 1);
  assert.equal(statuses.includes(true), false);
  camera.stop();
});

test("ended camera track stops capture, requests Stop, and releases resources", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const capture = new ReferenceCapture(); capture.authorize(true, true);
  const media = fakeStream(), video = fakeVideo();
  let unsafe = 0, closed = 0;
  const camera = new ShowroomCamera(capture, {
    video, permitted: () => true, robotStopped: () => true,
    onUnsafe: () => { unsafe++; }, onStatus() {}, onError() {},
    models: async () => ({ observe: () => ({ faces: [], poses: [] }), close: () => { closed++; } }),
    getUserMedia: async () => media.stream,
  });
  t.after(() => camera.stop());
  await camera.start();
  assert.equal(video.srcObject, media.stream);
  media.track.dispatchEvent(new Event("ended"));
  assert.equal(video.srcObject, null);
  assert.equal(capture.getState().status, "paused");
  assert.equal(unsafe, 1); assert.equal(closed, 1); assert.equal(media.stopped(), 1);
});
