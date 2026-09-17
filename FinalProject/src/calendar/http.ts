import { responseBytes } from "../providers/http-client.js";
import { CalendarError } from "./errors.js";

export type CalendarFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface CalendarHttpDependencies { fetch?: CalendarFetch; timeoutMs?: number }
export async function calendarFetch(
  dependencies: CalendarHttpDependencies, url: string, init: RequestInit, effectful = false,
): Promise<Response> {
  try {
    return await (dependencies.fetch ?? globalThis.fetch)(url, {
      ...init, redirect: "error", signal: AbortSignal.timeout(dependencies.timeoutMs ?? 10_000),
    });
  } catch {
    throw new CalendarError("CALENDAR_UNREACHABLE", "Calendar request failed or timed out.", 503, true, effectful);
  }
}
export async function calendarJson(response: Response, effectful = false): Promise<unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(await responseBytes(response, 512_000)));
  } catch {
    throw new CalendarError("CALENDAR_INVALID_RESPONSE", "Calendar returned an invalid response.", 502, false, effectful);
  }
}
export async function discardResponse(response: Response, effectful = false): Promise<void> {
  try { await response.body?.cancel(); } catch {
    throw new CalendarError("CALENDAR_INVALID_RESPONSE", "Calendar response could not be read.", 502, false, effectful);
  }
}
