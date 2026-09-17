import { z } from "zod";
import type { GoogleCalendarConfig } from "./config.js";
import { Rfc3339Schema, validateInterval, type AppointmentDraft, type AvailabilityInterval, type CalendarAvailability } from "./domain.js";
import { CalendarError } from "./errors.js";
import { calendarFetch, calendarJson, discardResponse, type CalendarHttpDependencies } from "./http.js";
import type { CalendarAccessTokenSource } from "./oauth.js";

export const CALENDAR_APP_OWNER = "magicpitch-showroom-v1";
export interface CalendarEventIdentity { eventId: string; confirmationKey: string; fingerprint: string }
const eventSchema = z.object({
  id: z.string(), status: z.enum(["confirmed", "tentative", "cancelled"]),
  etag: z.string().optional(), htmlLink: z.string().optional(),
  summary: z.string().optional(), location: z.string().optional(),
  start: z.object({ dateTime: Rfc3339Schema.optional(), timeZone: z.string().optional() }).optional(),
  end: z.object({ dateTime: Rfc3339Schema.optional(), timeZone: z.string().optional() }).optional(),
  attendees: z.array(z.object({ email: z.string() })).optional(),
  organizer: z.object({ self: z.boolean().optional() }).optional(),
  extendedProperties: z.object({ private: z.record(z.string(), z.string()).optional() }).optional(),
});
export type GoogleCalendarEvent = z.infer<typeof eventSchema>;
export interface CalendarProvider {
  checkAvailability(interval: AvailabilityInterval): Promise<CalendarAvailability>;
  getEvent(eventId: string): Promise<GoogleCalendarEvent | undefined>;
  insertEvent(draft: AppointmentDraft, identity: CalendarEventIdentity): Promise<GoogleCalendarEvent>;
  deleteEvent(eventId: string, etag: string): Promise<void>;
}
export interface GoogleCalendarDependencies extends CalendarHttpDependencies {
  auth: CalendarAccessTokenSource;
  clock?: () => Date;
}

export function verifyCalendarEvent(event: GoogleCalendarEvent, identity: CalendarEventIdentity, draft?: AppointmentDraft): void {
  const properties = event.extendedProperties?.private;
  if (event.id !== identity.eventId || properties?.app !== CALENDAR_APP_OWNER ||
      properties.confirmationKey !== identity.confirmationKey || properties.fingerprint !== identity.fingerprint ||
      event.organizer?.self !== true) {
    throw new CalendarError("CALENDAR_OWNERSHIP_MISMATCH", "The calendar event does not match this app-owned booking. No event was modified.", 409);
  }
  if (event.status === "cancelled") return;
  if (draft && (event.summary !== draft.subject || (event.location ?? "") !== draft.location ||
      Date.parse(event.start?.dateTime ?? "") !== Date.parse(draft.startTime) ||
      Date.parse(event.end?.dateTime ?? "") !== Date.parse(draft.endTime) ||
      (event.start?.timeZone !== undefined && event.start.timeZone !== draft.timeZone) ||
      (event.end?.timeZone !== undefined && event.end.timeZone !== draft.timeZone) ||
      JSON.stringify([...(event.attendees ?? [])].map((attendee) => attendee.email.toLowerCase()).sort()) !== JSON.stringify(draft.attendees))) {
    throw new CalendarError("CALENDAR_EVENT_CHANGED", "The existing calendar event differs from the confirmed appointment. Operator review is required.", 409);
  }
}

export class GoogleCalendarProvider implements CalendarProvider {
  private readonly baseUrl: string;
  private readonly clock: () => Date;
  constructor(private readonly config: GoogleCalendarConfig, private readonly dependencies: GoogleCalendarDependencies) {
    this.baseUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.calendarId)}/events`;
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async checkAvailability(interval: AvailabilityInterval): Promise<CalendarAvailability> {
    validateInterval(interval, this.clock());
    const body = await this.request("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST", body: JSON.stringify({
        timeMin: interval.startTime, timeMax: interval.endTime, timeZone: interval.timeZone,
        items: [{ id: this.config.calendarId }],
      }),
    });
    const errors = z.array(z.object({ domain: z.string().optional(), reason: z.string().optional() }));
    const result = z.object({
      timeMin: Rfc3339Schema, timeMax: Rfc3339Schema,
      calendars: z.record(z.string(), z.object({
        errors: errors.optional(), busy: z.array(z.object({ start: Rfc3339Schema, end: Rfc3339Schema })).optional(),
      })),
      groups: z.record(z.string(), z.object({ errors: errors.optional() })).optional(),
    }).safeParse(body);
    if (!result.success) throw new CalendarError("CALENDAR_INVALID_RESPONSE", "Google returned invalid calendar availability.", 502);
    const calendar = result.data.calendars[this.config.calendarId];
    if (!calendar || !calendar.busy || Object.values(result.data.calendars).some((item) => item.errors?.length) ||
        Object.values(result.data.groups ?? {}).some((item) => item.errors?.length)) {
      throw new CalendarError("CALENDAR_AVAILABILITY_FAILED", "Calendar availability could not be verified. No time is being offered as free.", 503);
    }
    if (Date.parse(result.data.timeMin) !== Date.parse(interval.startTime) || Date.parse(result.data.timeMax) !== Date.parse(interval.endTime) ||
        calendar.busy.some((item) => Date.parse(item.end) <= Date.parse(item.start))) {
      throw new CalendarError("CALENDAR_INVALID_RESPONSE", "Google returned mismatched calendar availability.", 502);
    }
    const busy = calendar.busy.filter((item) => Date.parse(item.start) < Date.parse(interval.endTime) && Date.parse(item.end) > Date.parse(interval.startTime))
      .map((item) => ({ startTime: item.start, endTime: item.end }));
    return { ...interval, available: busy.length === 0, busy, inventoryReserved: false };
  }

  async getEvent(eventId: string): Promise<GoogleCalendarEvent | undefined> {
    this.validateEventId(eventId);
    try {
      return this.parseEvent(await this.request(`${this.baseUrl}/${eventId}`, { method: "GET" }));
    } catch (error) {
      if (error instanceof CalendarError && [404, 410].includes(error.providerStatus ?? 0)) return undefined;
      throw error;
    }
  }

  async insertEvent(draft: AppointmentDraft, identity: CalendarEventIdentity): Promise<GoogleCalendarEvent> {
    this.validateEventId(identity.eventId);
    const body = await this.request(`${this.baseUrl}?sendUpdates=all`, {
      method: "POST",
      body: JSON.stringify({
        id: identity.eventId, summary: draft.subject,
        ...(draft.location ? { location: draft.location } : {}),
        start: { dateTime: draft.startTime, timeZone: draft.timeZone },
        end: { dateTime: draft.endTime, timeZone: draft.timeZone },
        attendees: draft.attendees.map((email) => ({ email })),
        transparency: "opaque", guestsCanModify: false,
        extendedProperties: { private: {
          app: CALENDAR_APP_OWNER, confirmationKey: identity.confirmationKey, fingerprint: identity.fingerprint,
        } },
      }),
    }, true);
    return this.parseEvent(body, true);
  }

  async deleteEvent(eventId: string, etag: string): Promise<void> {
    this.validateEventId(eventId);
    if (!etag || /[\r\n]/.test(etag)) throw new CalendarError("CALENDAR_INVALID_RESPONSE", "An event version is required for safe cancellation.", 502);
    await this.request(`${this.baseUrl}/${eventId}?sendUpdates=all`, {
      method: "DELETE", headers: { "if-match": etag },
    }, true);
  }

  private async request(url: string, init: RequestInit, effectful = false): Promise<unknown> {
    let token = await this.dependencies.auth.getAccessToken();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await calendarFetch(this.dependencies, url, {
        ...init, headers: { "content-type": "application/json", ...init.headers, authorization: `Bearer ${token}` },
      }, effectful);
      if (response.status === 401 && attempt === 0) {
        await discardResponse(response, effectful);
        token = await this.dependencies.auth.getAccessToken(true);
        continue;
      }
      if (!response.ok) {
        const status = response.status;
        await discardResponse(response, effectful);
        throw new CalendarError(
          status === 401 || status === 403 ? "CALENDAR_ACCESS_DENIED" : "CALENDAR_HTTP_ERROR",
          status === 401 || status === 403
            ? "Calendar access was denied; verify the account owns the calendar and reconnect if needed."
            : `Calendar returned HTTP ${status}.`,
          status === 409 || status === 412 ? 409 : 503, status === 429 || status >= 500,
          effectful && status >= 500, status,
        );
      }
      if (response.status === 204) return undefined;
      return calendarJson(response, effectful);
    }
    throw new CalendarError("CALENDAR_ACCESS_DENIED", "Calendar access was denied; reconnect the operator account.", 503);
  }
  private parseEvent(body: unknown, effectful = false): GoogleCalendarEvent {
    const parsed = eventSchema.safeParse(body);
    if (!parsed.success) throw new CalendarError("CALENDAR_INVALID_RESPONSE", "Google returned an invalid calendar event.", 502, false, effectful);
    return parsed.data;
  }
  private validateEventId(id: string): void {
    if (!/^[0-9a-v]{5,1024}$/.test(id)) throw new CalendarError("CALENDAR_INVALID_INPUT", "The calendar event identifier is invalid.", 400);
  }
}
