import {
  KioskPairExchangeSchema, ShowroomSessionCreatedSchema, ShowroomSnapshotSchema,
  ShowroomCatalogSchema, ShowroomActionSchema,
  ShowroomReferenceUploadQuerySchema, ShowroomReferenceUploadedSchema,
  ShowroomVoiceSetupInputSchema, ShowroomVoiceSetupSchema,
} from "../../FinalProject/src/contracts/showroom";
import type {
  ShowroomSessionCreated, ShowroomSnapshot, ShowroomCatalog, ShowroomAction, StudioStatus, ShowroomReferenceUploadQuery,
} from "../../FinalProject/src/contracts/showroom";

export const SHOWROOM_API = "/api/showroom";
export const MAX_SHOWROOM_MOVIE_BYTES = 100 * 1024 * 1024;

export class ShowroomClientError extends Error {
  constructor(message: string, readonly status = 0, readonly code = "NETWORK_ERROR") {
    super(message); this.name = "ShowroomClientError";
  }
  get terminal() { return [401, 403, 404, 410].includes(this.status); }
}

export class ShowroomClient {
  private capability: ShowroomSessionCreated | null = null;
  constructor(private readonly transport: typeof fetch = (...args) => fetch(...args)) {}

  join(capability: ShowroomSessionCreated) {
    this.capability = ShowroomSessionCreatedSchema.parse(capability);
  }
  forget() { this.capability = null; }
  private path(suffix = "") {
    if (!this.capability) throw new ShowroomClientError("Pair this tablet with the operator first.");
    return `/v1/sessions/${this.capability.sessionId}${suffix}`;
  }

  private async request<T>(path: string, init: RequestInit, parse: (response: Response) => Promise<T>,
    signal?: AbortSignal, timeout = 15000): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, timeout);
    try {
      const headers = new Headers(init.headers);
      if (this.capability) headers.set("Authorization", `Bearer ${this.capability.sessionToken}`);
      const response = await this.transport(`${SHOWROOM_API}${path}`, {
        ...init, headers, signal: controller.signal, credentials: "omit", redirect: "error", cache: "no-store",
      });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        let code = "HTTP_ERROR";
        if (payload && typeof payload === "object" && "error" in payload && payload.error &&
          typeof payload.error === "object" && "code" in payload.error && typeof payload.error.code === "string" &&
          /^[A-Z0-9_]{1,80}$/.test(payload.error.code)) code = payload.error.code;
        throw new ShowroomClientError(`Showroom request failed (${code === "HTTP_ERROR" ? `HTTP ${response.status}` : code}).`,
          response.status, code);
      }
      const value = await parse(response);
      if (controller.signal.aborted) throw new ShowroomClientError("Request stopped or timed out.", 0, "ABORTED");
      return value;
    } catch (error) {
      if (error instanceof ShowroomClientError) throw error;
      if (controller.signal.aborted) throw new ShowroomClientError("Request stopped or timed out.", 0, "ABORTED");
      throw new ShowroomClientError("Cannot reach the showroom. Check the trusted HTTPS connection; use touch controls after reconnecting.");
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
    }
  }

  private json<T>(path: string, method: string, body: unknown, schema: { parse(input: unknown): T }, signal?: AbortSignal) {
    return this.request(path, {
      method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    }, async response => {
      let input: unknown;
      try { input = await response.json(); return schema.parse(input); }
      catch { throw new ShowroomClientError("The showroom returned an invalid response. Reconnect before continuing.", 0, "INVALID_RESPONSE"); }
    }, signal);
  }

  exchange(pairingCode: string, signal?: AbortSignal): Promise<ShowroomSessionCreated> {
    const input = KioskPairExchangeSchema.parse({ pairingCode: pairingCode.trim().toUpperCase() });
    return this.json("/v1/kiosk/pair", "POST", input, ShowroomSessionCreatedSchema, signal);
  }
  snapshot(signal?: AbortSignal): Promise<ShowroomSnapshot> {
    return this.json(this.path("/showroom"), "GET", undefined, ShowroomSnapshotSchema, signal);
  }
  catalog(signal?: AbortSignal): Promise<ShowroomCatalog> {
    return this.json(this.path("/showroom/catalog"), "GET", undefined, ShowroomCatalogSchema, signal);
  }
  action(action: ShowroomAction, signal?: AbortSignal): Promise<ShowroomSnapshot> {
    if (action.type === "stop_requested") {
      return this.request(this.path("/showroom/actions"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ShowroomActionSchema.parse(action)), keepalive: true,
      }, async response => {
        const parsed = ShowroomSnapshotSchema.safeParse(await response.json());
        if (!parsed.success) throw new ShowroomClientError("The stop response was invalid.", 0, "INVALID_RESPONSE");
        return parsed.data;
      });
    }
    return this.json(this.path("/showroom/actions"), "POST", ShowroomActionSchema.parse(action), ShowroomSnapshotSchema, signal);
  }
  upload(photo: Blob, query: ShowroomReferenceUploadQuery, signal?: AbortSignal) {
    if (!["image/jpeg", "image/png"].includes(photo.type) || photo.size < 1 || photo.size > 5 * 1024 * 1024) {
      throw new ShowroomClientError("Upload a normalized JPEG or PNG no larger than 5 MiB.");
    }
    const input = ShowroomReferenceUploadQuerySchema.parse(query);
    return this.request(this.path(`/showroom/references?expectedRevision=${input.expectedRevision}&eventId=${input.eventId}`), {
      method: "POST", headers: { "Content-Type": photo.type }, body: photo,
    }, async response => {
      const parsed = ShowroomReferenceUploadedSchema.safeParse(await response.json());
      if (!parsed.success) throw new ShowroomClientError("The photo upload receipt was invalid.", 0, "INVALID_RESPONSE");
      return parsed.data;
    }, signal, 30000);
  }
  removeReference(assetId: string, query: ShowroomReferenceUploadQuery, signal?: AbortSignal) {
    if (!/^[a-f0-9-]{36}$/i.test(assetId)) throw new ShowroomClientError("Invalid photo reference.");
    const input = ShowroomReferenceUploadQuerySchema.parse(query);
    return this.json(this.path(`/showroom/references/${assetId}?expectedRevision=${input.expectedRevision}&eventId=${input.eventId}`),
      "DELETE", undefined, ShowroomSnapshotSchema, signal);
  }
  voice(sdp: string, generation: number, signal?: AbortSignal) {
    return this.json(this.path("/showroom/voice"), "POST", ShowroomVoiceSetupInputSchema.parse({ sdp, generation }), ShowroomVoiceSetupSchema, signal);
  }
  terminateVoice(generation: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(generation) || generation < 0) throw new ShowroomClientError("Invalid voice generation.");
    return this.request(this.path("/showroom/voice"), {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ generation }),
    }, async response => {
      if (response.status !== 204) throw new ShowroomClientError("Voice termination was not confirmed.", response.status, "VOICE_CLEANUP_UNCONFIRMED");
    }, signal);
  }
  movie(result: Extract<StudioStatus, { status: "ready" }>, signal?: AbortSignal): Promise<Blob> {
    if (result.byteLength > MAX_SHOWROOM_MOVIE_BYTES) throw new ShowroomClientError("The movie exceeds the supported 100 MiB limit.");
    return this.request(this.path(`/assets/${result.assetId}`), { method: "GET" }, async response => {
      if (response.status !== 200 || response.headers.get("Content-Type")?.split(";")[0].trim() !== "video/mp4") {
        await response.body?.cancel();
        throw new ShowroomClientError("The movie response was not a complete MP4.", 0, "INVALID_MEDIA");
      }
      const length = response.headers.get("Content-Length");
      if (length && (!/^\d+$/.test(length) || Number(length) !== result.byteLength)) {
        await response.body?.cancel();
        throw new ShowroomClientError("The movie exceeds the supported 100 MiB limit.", 0, "INVALID_MEDIA");
      }
      if (!response.body) throw new ShowroomClientError("The movie response was empty.", 0, "INVALID_MEDIA");
      const reader = response.body.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > result.byteLength) throw new ShowroomClientError("The movie exceeded its authorized length.", 0, "INVALID_MEDIA");
          chunks.push(new Uint8Array(value));
        }
        if (total < 1 || total !== result.byteLength) throw new ShowroomClientError("The movie download was incomplete.", 0, "INVALID_MEDIA");
        const blob = new Blob(chunks, { type: "video/mp4" });
        const bytes = await blob.arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        new Uint8Array(bytes).fill(0);
        const checksum = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
        if (checksum !== result.checksum) throw new ShowroomClientError("Movie integrity did not match its receipt.", 0, "INVALID_MEDIA");
        return blob;
      } finally {
        await reader.cancel();
        reader.releaseLock();
        for (const chunk of chunks) chunk.fill(0);
      }
    }, signal, 60000);
  }
  async revoke(signal?: AbortSignal) {
    return this.request(this.path(), { method: "DELETE" }, async response => {
      if (response.status !== 204) throw new ShowroomClientError("Server cleanup is not confirmed.", response.status, "CLEANUP_UNCONFIRMED");
    }, signal);
  }
}
