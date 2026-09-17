import { CAPTURE_LIMITS, ReferenceCapture, pixelQuality } from "./capture";
import type { NormalizedPhoto } from "./capture";
import { participantView, stableParticipant, trackingDiscontinuity } from "./vision-metrics";
import type { ParticipantView, VisionObservation } from "./vision-metrics";
import type { FaceLandmarker, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { FramingTracking } from "../../../FinalProject/src/contracts/bridge";

export interface VisionModels {
  observe(source: HTMLVideoElement | HTMLCanvasElement, time: number): VisionObservation;
  close(): void;
}

export async function loadVisionModels(): Promise<VisionModels> {
  const { FilesetResolver, FaceLandmarker, PoseLandmarker } = await import("@mediapipe/tasks-vision");
  const files = await FilesetResolver.forVisionTasks("/showroom-models/wasm");
  let face: FaceLandmarker | undefined;
  let pose: PoseLandmarker | undefined;
  try {
    face = await FaceLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: "/showroom-models/face_landmarker.task" },
      runningMode: "VIDEO", numFaces: 2, minFaceDetectionConfidence: 0.65,
      minTrackingConfidence: 0.65, minFacePresenceConfidence: 0.65,
    });
    pose = await PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: "/showroom-models/pose_landmarker_lite.task" },
      runningMode: "VIDEO", numPoses: 2, minPoseDetectionConfidence: 0.65,
      minTrackingConfidence: 0.65, minPosePresenceConfidence: 0.65,
    });
    const readyFace = face, readyPose = pose;
    return {
      observe: (source, time) => ({
        faces: readyFace.detectForVideo(source, time).faceLandmarks,
        poses: readyPose.detectForVideo(source, time).landmarks,
      }),
      close: () => { readyFace.close(); readyPose.close(); },
    };
  } catch (error) {
    face?.close(); pose?.close();
    throw error;
  }
}

export async function normalizeCanvas(canvas: HTMLCanvasElement): Promise<NormalizedPhoto> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(value => value ? resolve(value) : reject(new Error("The photo could not be normalized.")), "image/jpeg", 0.9));
  if (blob.size > CAPTURE_LIMITS.imageBytes) throw new Error("This photo exceeds the 5 MiB limit.");
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return {
    blob, width: canvas.width, height: canvas.height,
    sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""),
  };
}

function canvasFor(source: CanvasImageSource, width: number, height: number, maximum: number) {
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, maximum / Math.max(width, height));
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Photo processing is unavailable. Try another browser.");
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return { canvas, context };
}

export class ShowroomCamera {
  private stream: MediaStream | null = null;
  private models: VisionModels | null = null;
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private previous: ParticipantView | null = null;
  private sawParticipant = false;
  private lastTime = 0;

  constructor(private readonly capture: ReferenceCapture, private readonly options: {
    video: HTMLVideoElement;
    permitted(): boolean;
    robotStopped(): boolean;
    onUnsafe(): void;
    onStatus(active: boolean): void;
    onError(message: string): void;
    models?: () => Promise<VisionModels>;
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  }) {}

  async start() {
    if (!this.options.permitted()) throw new Error("Photography and likeness permission are required before starting the camera.");
    this.stop();
    const epoch = this.epoch;
    try {
      const models = await (this.options.models ?? loadVisionModels)();
      if (epoch !== this.epoch || !this.options.permitted()) { models.close(); return; }
      this.models = models;
      const stream = await (this.options.getUserMedia ?? (constraints => navigator.mediaDevices.getUserMedia(constraints)))({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 1600 } }, audio: false,
      });
      if (epoch !== this.epoch || !this.options.permitted()) {
        stream.getTracks().forEach(track => track.stop());
        if (epoch === this.epoch) this.stop();
        return;
      }
      this.stream = stream;
      for (const track of stream.getVideoTracks()) track.addEventListener("ended", () => {
        if (epoch !== this.epoch) return;
        this.stop();
        this.capture.pause("Camera access ended. Resume when you are ready.");
        this.options.onUnsafe();
      }, { once: true });
      this.options.video.srcObject = stream;
      await this.options.video.play();
      if (epoch !== this.epoch || !this.options.permitted()) {
        if (epoch === this.epoch) this.stop();
        return;
      }
      this.capture.resume();
      this.options.onStatus(true);
      this.tick(epoch);
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.stop();
      this.capture.pause("Camera unavailable. You can upload a photo instead.");
      this.options.onError(error instanceof Error ? error.message : "Camera unavailable. Check permission or upload a photo.");
    }
  }

  private tick(epoch: number) {
    this.timer = setTimeout(() => { void this.sample(epoch); }, 250);
  }

  private async sample(epoch: number) {
    if (epoch !== this.epoch || !this.options.permitted() || !this.models) return;
    const video = this.options.video;
    try {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        this.lastTime = Math.max(performance.now(), this.lastTime + 1);
        const participant = participantView(this.models.observe(video, this.lastTime));
        const lost = trackingDiscontinuity(this.previous, participant);
        if (participant.people > 1 || lost || (this.sawParticipant && !participant.center)) {
          this.capture.pause("Camera paused: the participant is no longer clearly tracked. Resume when only you are in view.");
          this.options.onUnsafe();
          this.stop();
          return;
        }
        if (participant.center) {
          this.sawParticipant = true;
          const { canvas, context } = canvasFor(video, video.videoWidth, video.videoHeight, 256);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
          const quality = pixelQuality(pixels.data, canvas.width, canvas.height);
          pixels.data.fill(0); canvas.width = 0; canvas.height = 0;
          if (this.options.robotStopped()) await this.capture.consider({
            ...quality, timestamp: Date.now(), people: participant.people, tracked: !lost,
            stable: stableParticipant(this.previous, participant), robotStopped: true, view: participant.view,
          }, async () => {
            const { canvas: full } = canvasFor(video, video.videoWidth, video.videoHeight, 1600);
            try { return await normalizeCanvas(full); }
            finally { full.width = 0; full.height = 0; }
          });
        }
        this.previous = participant;
        if (["complete", "frozen", "paused"].includes(this.capture.getState().status)) { this.stop(); return; }
      }
    } catch (error) {
      this.stop();
      this.capture.pause("Camera paused because this frame could not be checked.");
      this.options.onUnsafe();
      this.options.onError(error instanceof Error ? error.message : "Camera processing failed. Upload a photo or retry.");
      return;
    }
    if (epoch === this.epoch) this.tick(epoch);
  }

  async upload(file: File) {
    if (!this.options.permitted()) throw new Error("Photography and likeness permission are required before opening a photo.");
    if (!["image/jpeg", "image/png"].includes(file.type) || file.size < 1 || file.size > CAPTURE_LIMITS.imageBytes) {
      throw new Error("Choose a JPEG or PNG no larger than 5 MiB.");
    }
    const epoch = this.epoch;
    const image = await createImageBitmap(file, { imageOrientation: "from-image" });
    let models: VisionModels | null = null;
    let canvas: HTMLCanvasElement | null = null;
    try {
      if (epoch !== this.epoch || !this.options.permitted()) return;
      if (image.width * image.height > CAPTURE_LIMITS.maximumPixels) throw new Error("Choose a photo smaller than 24 megapixels.");
      models = await (this.options.models ?? loadVisionModels)();
      if (epoch !== this.epoch || !this.options.permitted()) return;
      canvas = canvasFor(image, image.width, image.height, 1600).canvas;
      const participant = participantView(models.observe(canvas, performance.now()));
      const sample = canvasFor(canvas, canvas.width, canvas.height, 256);
      const pixels = sample.context.getImageData(0, 0, sample.canvas.width, sample.canvas.height);
      const quality = pixelQuality(pixels.data, sample.canvas.width, sample.canvas.height);
      pixels.data.fill(0); sample.canvas.width = 0; sample.canvas.height = 0;
      const normalized = canvas;
      await this.capture.addManual({
        ...quality, timestamp: Date.now(), people: participant.people, tracked: !!participant.center,
        stable: true, robotStopped: this.options.robotStopped(), view: participant.view,
      }, () => normalizeCanvas(normalized));
    } finally {
      image.close(); models?.close();
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    }
  }

  tracking(): FramingTracking | null {
    if (!this.options.permitted() || !this.models || !this.stream || !this.options.robotStopped()) return null;
    const video = this.options.video;
    if (video.readyState < 2) return null;
    this.lastTime = Math.max(performance.now(), this.lastTime + 1);
    const observation = this.models.observe(video, this.lastTime);
    const participant = participantView(observation);
    if (!participant.center || participant.people !== 1 || !stableParticipant(this.previous, participant)) return null;
    const pose = observation.poses[0];
    if (!pose) return null;
    const confidence = Math.min(pose[11]?.visibility ?? 0, pose[12]?.visibility ?? 0);
    if (confidence < 0.75) return null;
    const visible = [0, 11, 12, 23, 24].map(index => pose[index]).filter(point =>
      point && (point.visibility ?? 0) >= 0.75 && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1);
    const width = Math.max(...visible.map(point => point.x)) - Math.min(...visible.map(point => point.x));
    const height = Math.max(...visible.map(point => point.y)) - Math.min(...visible.map(point => point.y));
    return {
      capturedAt: new Date().toISOString(), confidence, personCount: 1, goal: "half_body",
      centerX: participant.center.x, centerY: participant.center.y, bodyOccupancy: Math.max(0, Math.min(1, width * height)),
    };
  }

  stop() {
    this.epoch++;
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.options.video.pause();
    this.options.video.srcObject = null;
    this.models?.close(); this.models = null;
    this.previous = null; this.sawParticipant = false;
    this.options.onStatus(false);
  }
}
