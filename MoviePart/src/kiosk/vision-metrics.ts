import type { CaptureView } from "./capture";

export interface Landmark { x: number; y: number; z?: number; visibility?: number }
export interface VisionObservation {
  faces: readonly (readonly Landmark[])[];
  poses: readonly (readonly Landmark[])[];
}
export interface ParticipantView {
  people: number;
  view: CaptureView | null;
  center: { x: number; y: number } | null;
  faceWidth: number;
}
const present = (point: Landmark | undefined): point is Landmark =>
  !!point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
  point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1 && (point.visibility ?? 1) >= 0.75;

export function participantView(observation: VisionObservation): ParticipantView {
  const faces = observation.faces.filter(face => face.length > 454);
  const poses = observation.poses.filter(pose => [11, 12, 23, 24].some(index => present(pose[index])));
  const people = Math.max(faces.length, poses.length);
  if (people !== 1) return { people, view: null, center: null, faceWidth: 0 };
  const face = faces[0], pose = poses[0];
  const shoulders = pose && present(pose[11]) && present(pose[12]);
  const hips = pose && present(pose[23]) && present(pose[24]);
  const halfBody = shoulders && hips &&
    Math.min(pose[23].y, pose[24].y) - Math.max(pose[11].y, pose[12].y) >= 0.22;
  if (!face || ![1, 33, 263, 234, 454].every(index => present(face[index]))) {
    // A pose alone is not reliable enough to establish whose profile is being photographed.
    return { people, view: null, center: null, faceWidth: 0 };
  }
  const left = Math.min(face[234].x, face[454].x), right = Math.max(face[234].x, face[454].x);
  const faceWidth = right - left;
  const center = { x: (left + right) / 2, y: (face[33].y + face[263].y) / 2 };
  if (pose && present(pose[0]) && Math.hypot(pose[0].x - face[1].x, pose[0].y - face[1].y) > 0.15) {
    return { people: 2, view: null, center: null, faceWidth: 0 };
  }
  if (faceWidth < 0.08 || faceWidth > 0.8) return { people, view: null, center, faceWidth };
  const yaw = Math.abs((face[1].x - center.x) / (faceWidth / 2));
  const view: CaptureView | null = halfBody && faceWidth < 0.25 ? "half_body"
    : yaw >= 0.48 ? "profile"
    : yaw >= 0.2 ? "three_quarter"
    : faceWidth >= 0.16 ? "front_face" : null;
  return { people, view, center, faceWidth };
}

export function stableParticipant(previous: ParticipantView | null, current: ParticipantView): boolean {
  if (!previous?.center || !current.center || previous.people !== 1 || current.people !== 1) return false;
  return Math.hypot(current.center.x - previous.center.x, current.center.y - previous.center.y) <= 0.018 &&
    Math.abs(current.faceWidth - previous.faceWidth) <= 0.015;
}

export function trackingDiscontinuity(previous: ParticipantView | null, current: ParticipantView): boolean {
  return !!previous?.center && (!current.center || current.people !== 1 ||
    Math.hypot(current.center.x - previous.center.x, current.center.y - previous.center.y) > 0.15);
}
