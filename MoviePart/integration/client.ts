import type {
  ConfigView, Consent, JobResponse, JobView, MovieJobAccepted,
  MovieJobRequest, MovieRetryAccepted, MovieRetryRequest, UploadResponse, FrameDecisionRequest, HeroEndpointSelectionRequest,
} from "./contracts";

export class MovieMagicHttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "MovieMagicHttpError";
  }
}

/**
 * Fetch-based client for Node.js 22+ or a same-origin browser.
 * A bearer token is for trusted server/robot code, never frontend source.
 */
export class MovieMagicClient {
  private readonly base: string;

  constructor(private readonly options: {
    baseUrl: string;
    token?: string;
    fetch?: typeof fetch;
  }) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Use an HTTP(S) service base URL without credentials, query or fragment.");
    }
    this.base = url.toString().replace(/\/$/, "");
  }

  private async response(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.options.token) headers.set("Authorization", `Bearer ${this.options.token}`);
    const response = await (this.options.fetch ?? fetch)(`${this.base}${path}`, {
      ...init, headers, credentials: "same-origin", cache: "no-store", redirect: "error",
    });
    if (!response.ok) {
      const text = await response.text();
      let value: unknown;
      try { value = JSON.parse(text); } catch { value = null; }
      const message = value && typeof value === "object" && "error" in value && typeof value.error === "string"
        ? value.error : `Movie Magic returned HTTP ${response.status}.`;
      const code = value && typeof value === "object" && "code" in value && typeof value.code === "string"
        ? value.code : "HTTP_ERROR";
      throw new MovieMagicHttpError(response.status, code, message);
    }
    return response;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await this.response(path, init)).json() as Promise<T>;
  }

  getConfig(signal?: AbortSignal): Promise<ConfigView> {
    return this.json("/api/movie-config", { signal });
  }

  uploadPhotos(photos: File[], consent: Consent, signal?: AbortSignal): Promise<UploadResponse> {
    if (photos.length < 1 || photos.length > 4) throw new Error("Upload one to four customer photos.");
    const body = new FormData();
    photos.forEach(photo => body.append("photos", photo));
    body.append("consent", JSON.stringify(consent));
    return this.json("/api/movie-assets", { method: "POST", body, signal });
  }

  createJob(request: MovieJobRequest, signal?: AbortSignal): Promise<MovieJobAccepted> {
    return this.json("/api/movie-jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request), signal,
    });
  }

  async getJob(jobId: string, signal?: AbortSignal): Promise<JobView> {
    return (await this.json<JobResponse>(`/api/movie-jobs/${encodeURIComponent(jobId)}`, { signal })).job;
  }

  retryJob(jobId: string, request: MovieRetryRequest, signal?: AbortSignal): Promise<MovieRetryAccepted> {
    return this.json(`/api/movie-jobs/${encodeURIComponent(jobId)}/retry`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request), signal,
    });
  }

  async decideFrame(jobId: string, assetId: string, request: FrameDecisionRequest, signal?: AbortSignal): Promise<JobView> {
    const response = await this.json<JobResponse>(`/api/movie-jobs/${encodeURIComponent(jobId)}/frames/${encodeURIComponent(assetId)}/decision`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal,
    });
    return response.job;
  }

  async selectHeroEndpoint(jobId: string, request: HeroEndpointSelectionRequest, signal?: AbortSignal): Promise<JobView> {
    const response = await this.json<JobResponse>(`/api/movie-jobs/${encodeURIComponent(jobId)}/hero-endpoints`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal,
    });
    return response.job;
  }

  async waitForJob(jobId: string, options: {
    signal?: AbortSignal;
    intervalMs?: number;
    maxPolls?: number;
    onProgress?: (job: JobView) => void;
  } = {}): Promise<JobView> {
    const interval = options.intervalMs ?? 2000;
    const maxPolls = options.maxPolls ?? 300;
    if (!Number.isFinite(interval) || interval < 100 || !Number.isSafeInteger(maxPolls) || maxPolls < 1) {
      throw new Error("Polling needs a positive maxPolls and an interval of at least 100 ms.");
    }
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      options.signal?.throwIfAborted();
      const job = await this.getJob(jobId, options.signal);
      options.onProgress?.(job);
      if (job.status === "COMPLETED" || job.status === "FAILED") return job;
      if (attempt + 1 < maxPolls) await new Promise<void>((resolve, reject) => {
        const finish = () => { options.signal?.removeEventListener("abort", abort); resolve(); };
        const timer = setTimeout(finish, interval);
        const abort = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); reject(options.signal?.reason); };
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
      });
    }
    throw new MovieMagicHttpError(408, "POLL_LIMIT", "Polling stopped; the movie may still be running. Resume with the same job ID, not a new submission.");
  }

  /** For token-authenticated playback, download a Blob and create a local object URL. */
  async downloadAsset(assetId: string, signal?: AbortSignal): Promise<Blob> {
    return (await this.response(`/api/movie-assets/${encodeURIComponent(assetId)}`, { signal })).blob();
  }

  async deleteJob(jobId: string, signal?: AbortSignal): Promise<void> {
    await this.response(`/api/movie-jobs/${encodeURIComponent(jobId)}`, { method: "DELETE", signal });
  }
}
