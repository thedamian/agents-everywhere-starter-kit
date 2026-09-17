import assert from "node:assert/strict";
import test from "node:test";
import { participantView, stableParticipant, trackingDiscontinuity } from "../src/kiosk/vision-metrics";
import type { Landmark } from "../src/kiosk/vision-metrics";

function face(width = 0.3, yaw = 0): Landmark[] {
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.4 }));
  landmarks[234] = { x: 0.5 - width / 2, y: 0.4 };
  landmarks[454] = { x: 0.5 + width / 2, y: 0.4 };
  landmarks[1] = { x: 0.5 + width / 2 * yaw, y: 0.45 };
  return landmarks;
}
function pose(): Landmark[] {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.4, visibility: 0 }));
  landmarks[11] = { x: 0.3, y: 0.4, visibility: 1 };
  landmarks[12] = { x: 0.7, y: 0.4, visibility: 1 };
  landmarks[23] = { x: 0.4, y: 0.75, visibility: 1 };
  landmarks[24] = { x: 0.6, y: 0.75, visibility: 1 };
  return landmarks;
}
test("front face, three-quarter and profile use local landmarks rather than a universal 32% trigger", () => {
  assert.equal(participantView({ faces: [face(0.2)], poses: [] }).view, "front_face");
  assert.equal(participantView({ faces: [face(0.3, 0.3)], poses: [] }).view, "three_quarter");
  assert.equal(participantView({ faces: [face(0.3, 0.6)], poses: [] }).view, "profile");
  assert.equal(participantView({ faces: [face(0.07)], poses: [] }).view, null);
});
test("half-body needs visible shoulders and hips; face width alone is not evidence", () => {
  assert.equal(participantView({ faces: [face(0.15)], poses: [pose()] }).view, "half_body");
  assert.equal(participantView({ faces: [face(0.15)], poses: [] }).view, null);
  const clipped = pose(); clipped[24].visibility = 0.5;
  assert.equal(participantView({ faces: [face(0.15)], poses: [clipped] }).view, null);
  assert.equal(participantView({ faces: [], poses: [pose()] }).view, null);
});
test("multiple people and track jumps are unsafe, without identifying anyone", () => {
  assert.equal(participantView({ faces: [face(), face()], poses: [] }).people, 2);
  assert.equal(participantView({ faces: [face()], poses: [pose(), pose()] }).view, null);
  const initial = participantView({ faces: [face()], poses: [] });
  assert.equal(stableParticipant(initial, initial), true);
  assert.equal(stableParticipant(initial, { ...initial, faceWidth: initial.faceWidth + 0.02 }), false);
  assert.equal(trackingDiscontinuity(initial, { ...initial, center: { x: 0.7, y: 0.4 } }), true);
  assert.equal(trackingDiscontinuity(initial, { ...initial, center: null }), true);
});
