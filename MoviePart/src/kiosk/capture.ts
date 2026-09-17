export const CAPTURE_LIMITS = Object.freeze({
  count: 4,
  imageBytes: 5 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  minimumWidth: 320,
  minimumHeight: 320,
  maximumPixels: 24_000_000,
  minimumLight: 45,
  maximumLight: 225,
  minimumSharpness: 80,
  duplicateDistance: 6,
  stableMs: 800,
  maximumSampleAgeMs: 500,
});

export type CaptureView = "front_face" | "half_body" | "profile" | "three_quarter";
export interface CaptureMetrics {
  timestamp: number;
  people: number;
  tracked: boolean;
  stable: boolean;
  robotStopped: boolean;
  view: CaptureView | null;
  light: number;
  sharpness: number;
  perceptualHash: string;
}
export interface LocalReference {
  id: string;
  blob: Blob;
  url: string;
  sha256: string;
  perceptualHash: string;
  view: CaptureView;
  width: number;
  height: number;
}
export interface NormalizedPhoto {
  blob: Blob;
  width: number;
  height: number;
  sha256: string;
}
export type CaptureStatus = "off" | "collecting" | "paused" | "complete" | "frozen";
export interface CaptureState {
  status: CaptureStatus;
  references: readonly LocalReference[];
  primaryId: string | null;
  revision: number;
  message: string | null;
}

export function hashDistance(left: string, right: string): number {
  if (!/^[01]{64}$/.test(left) || !/^[01]{64}$/.test(right)) return Infinity;
  return Array.from(left).reduce((count, bit, index) => count + Number(bit !== right[index]), 0);
}

export function qualityProblem(metrics: CaptureMetrics, now: number): string | null {
  if (metrics.people !== 1 || !metrics.tracked) return "Camera paused: one clearly tracked participant is needed.";
  if (!metrics.robotStopped) return "Camera paused while the robot is moving or its stop is unconfirmed.";
  if (!metrics.stable) return "Waiting for a still, clear view.";
  if (metrics.timestamp > now || now - metrics.timestamp > CAPTURE_LIMITS.maximumSampleAgeMs) return "Waiting for a fresh camera view.";
  if (!metrics.view) return "Waiting for a clear face or upper-body view.";
  if (!Number.isFinite(metrics.light) || metrics.light < CAPTURE_LIMITS.minimumLight || metrics.light > CAPTURE_LIMITS.maximumLight) {
    return "Try more even lighting for a usable photo.";
  }
  if (!Number.isFinite(metrics.sharpness) || metrics.sharpness < CAPTURE_LIMITS.minimumSharpness) return "Waiting for a sharper photo.";
  if (!/^[01]{64}$/.test(metrics.perceptualHash)) return "Photo quality could not be checked.";
  return null;
}

export class ReferenceCapture {
  private state: CaptureState = { status: "off", references: [], primaryId: null, revision: 0, message: null };
  private listeners = new Set<() => void>();
  private consent = false;
  private epoch = 0;
  private processing = false;
  private stableSince: number | null = null;
  private stableView: CaptureView | null = null;

  constructor(private readonly options: {
    urls?: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
    uuid?: () => string;
    now?: () => number;
  } = {}) {}

  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(patch: Partial<CaptureState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private resetStability() { this.stableSince = null; this.stableView = null; }
  private urls() { return this.options.urls ?? URL; }

  authorize(capture: boolean, likeness: boolean) {
    if (!capture || !likeness) { this.clear(); return; }
    if (this.consent) return;
    this.consent = true;
    this.epoch++;
    this.set({ status: "collecting", message: null });
  }

  pause(message = "Camera paused. Resume when you are ready.") {
    this.epoch++;
    this.resetStability();
    if (this.consent && this.state.status !== "frozen") this.set({ status: "paused", message });
  }

  resume() {
    if (!this.consent) throw new Error("Photography and likeness permission are required first.");
    if (this.state.status === "frozen") throw new Error("Movie references are already frozen.");
    this.epoch++;
    this.resetStability();
    this.set({ status: this.state.references.length === CAPTURE_LIMITS.count ? "complete" : "collecting", message: null });
  }

  async consider(metrics: CaptureMetrics, snapshot: () => Promise<NormalizedPhoto>): Promise<boolean> {
    // The callback is the only full-resolution frame read; never invoke it before both permissions.
    if (!this.consent || this.state.status !== "collecting" || this.processing) return false;
    const now = (this.options.now ?? Date.now)();
    const problem = qualityProblem(metrics, now);
    if (problem) {
      this.resetStability();
      if (metrics.people !== 1 || !metrics.tracked || !metrics.robotStopped) this.pause(problem);
      else this.set({ message: problem });
      return false;
    }
    if (this.stableSince === null || this.stableView !== metrics.view) {
      this.stableSince = now;
      this.stableView = metrics.view;
    }
    if (now - this.stableSince < CAPTURE_LIMITS.stableMs) return false;
    if (this.state.references.some(ref => ref.view === metrics.view ||
      hashDistance(ref.perceptualHash, metrics.perceptualHash) <= CAPTURE_LIMITS.duplicateDistance)) return false;
    return this.accept(metrics, snapshot);
  }

  async addManual(metrics: CaptureMetrics, normalize: () => Promise<NormalizedPhoto>): Promise<boolean> {
    if (!this.consent) throw new Error("Photography and likeness permission are required before opening a photo.");
    if (this.state.status === "frozen") throw new Error("Movie references are already frozen.");
    if (this.processing) throw new Error("Wait for the current photo to finish.");
    if (this.state.references.length >= CAPTURE_LIMITS.count) throw new Error("Remove a photo before adding another; four is the maximum.");
    if (this.state.references.some(reference => reference.view === metrics.view)) {
      throw new Error("Remove the existing photo of this view before retaking it.");
    }
    const problem = qualityProblem(metrics, (this.options.now ?? Date.now)());
    if (problem) throw new Error(problem);
    return this.accept(metrics, normalize);
  }

  private async accept(metrics: CaptureMetrics, snapshot: () => Promise<NormalizedPhoto>): Promise<boolean> {
    const epoch = this.epoch;
    this.processing = true;
    try {
      const photo = await snapshot();
      if (epoch !== this.epoch || !this.consent || this.state.status === "frozen") return false;
      if (!["image/jpeg", "image/png"].includes(photo.blob.type) || photo.blob.size < 1 ||
        photo.blob.size > CAPTURE_LIMITS.imageBytes || photo.width < CAPTURE_LIMITS.minimumWidth ||
        photo.height < CAPTURE_LIMITS.minimumHeight || photo.width * photo.height > CAPTURE_LIMITS.maximumPixels ||
        !/^[a-f0-9]{64}$/.test(photo.sha256)) throw new Error("Use a valid JPEG or PNG, at least 320 by 320 pixels and no larger than 5 MiB.");
      if (this.state.references.length >= CAPTURE_LIMITS.count ||
        this.state.references.reduce((sum, ref) => sum + ref.blob.size, 0) + photo.blob.size > CAPTURE_LIMITS.totalBytes) {
        throw new Error("The photo set must contain at most four images and 20 MiB.");
      }
      if (this.state.references.some(ref => ref.sha256 === photo.sha256 ||
        hashDistance(ref.perceptualHash, metrics.perceptualHash) <= CAPTURE_LIMITS.duplicateDistance)) {
        this.set({ message: "That photo is too similar to one already selected." });
        return false;
      }
      const reference: LocalReference = {
        ...photo, id: (this.options.uuid ?? (() => crypto.randomUUID()))(),
        url: this.urls().createObjectURL(photo.blob), view: metrics.view!,
        perceptualHash: metrics.perceptualHash,
      };
      const references = [...this.state.references, reference];
      this.set({
        references, revision: this.state.revision + 1,
        primaryId: references.find(ref => ref.view === "front_face")?.id ?? references[0].id,
        status: references.length === CAPTURE_LIMITS.count ? "complete" : this.state.status,
        message: null,
      });
      this.resetStability();
      return true;
    } finally { this.processing = false; }
  }

  remove(id: string) {
    if (this.state.status === "frozen") throw new Error("Movie references are already frozen.");
    const reference = this.state.references.find(ref => ref.id === id);
    if (!reference) throw new Error("This photo is no longer selected.");
    this.epoch++;
    this.urls().revokeObjectURL(reference.url);
    const references = this.state.references.filter(ref => ref.id !== id);
    this.resetStability();
    this.set({
      references, revision: this.state.revision + 1,
      primaryId: references.find(ref => ref.view === "front_face")?.id ?? references[0]?.id ?? null,
      status: this.state.status === "complete" ? "collecting" : this.state.status, message: null,
    });
  }

  freeze(): readonly LocalReference[] {
    if (!this.consent || this.state.references.length < 1 || this.state.references.length > CAPTURE_LIMITS.count) {
      throw new Error("Select one to four consented photos before creating a movie.");
    }
    this.epoch++;
    this.resetStability();
    this.set({ status: "frozen", message: "These references are fixed for your confirmed movie." });
    return this.state.references;
  }

  clear() {
    this.epoch++;
    this.consent = false;
    this.resetStability();
    for (const ref of this.state.references) this.urls().revokeObjectURL(ref.url);
    this.set({ status: "off", references: [], primaryId: null, revision: this.state.revision + 1, message: null });
  }
}

export function pixelQuality(data: Uint8ClampedArray, width: number, height: number) {
  if (width < 9 || height < 8 || data.length !== width * height * 4) throw new Error("Invalid quality sample.");
  const grey = new Float64Array(width * height);
  for (let i = 0; i < grey.length; i++) grey[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
  const light = grey.reduce((sum, value) => sum + value, 0) / grey.length;
  let sum = 0, squares = 0, count = 0;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    const laplacian = grey[i - 1] + grey[i + 1] + grey[i - width] + grey[i + width] - 4 * grey[i];
    sum += laplacian; squares += laplacian * laplacian; count++;
  }
  let perceptualHash = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const row = Math.floor((y + 0.5) * height / 8) * width;
    perceptualHash += Number(grey[row + Math.floor(x * (width - 1) / 8)] > grey[row + Math.floor((x + 1) * (width - 1) / 8)]);
  }
  return { light, sharpness: squares / count - (sum / count) ** 2, perceptualHash };
}
