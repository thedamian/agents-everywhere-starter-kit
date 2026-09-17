export function audioActivity(samples: Float32Array, playing: boolean): number {
  if (!playing || !samples.length) return 0;
  const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  return Number.isFinite(rms) && rms >= 0.008 ? Math.min(1, rms * 6) : 0;
}

export class VoiceActivityMonitor {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;

  constructor(private readonly audio: HTMLAudioElement, private readonly onLevel: (level: number) => void,
    private readonly onError: (message: string) => void) {}

  async start() {
    this.stop();
    this.stopped = false;
    try {
      this.context = new AudioContext();
      await this.context.resume();
      if (this.stopped) return;
      this.sample();
    } catch {
      this.stop();
      this.onError("Live audio activity is unavailable. Captions remain available.");
    }
  }

  private sample() {
    if (this.stopped || !this.context) return;
    const stream = this.audio.srcObject;
    try {
      if (stream instanceof MediaStream && stream !== this.stream) {
        this.source?.disconnect();
        this.analyser?.disconnect();
        this.stream = stream;
        this.source = this.context.createMediaStreamSource(stream);
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = 512;
        this.source.connect(this.analyser);
      }
      const samples = new Float32Array(this.analyser?.fftSize ?? 0);
      this.analyser?.getFloatTimeDomainData(samples);
      this.onLevel(audioActivity(samples, !this.audio.paused && !this.audio.muted));
    } catch {
      this.stop();
      this.onError("Live audio activity was interrupted. Captions remain available.");
      return;
    }
    this.timer = setTimeout(() => this.sample(), 60);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.source?.disconnect(); this.source = null;
    this.analyser?.disconnect(); this.analyser = null;
    if (this.context && this.context.state !== "closed") void this.context.close().catch(() => {
      this.onError("Audio activity cleanup could not be confirmed.");
    });
    this.context = null; this.stream = null;
    this.onLevel(0);
  }
}
