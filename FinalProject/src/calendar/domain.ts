import { createHash } from "node:crypto";
import { z } from "zod";
import { CalendarEmailSchema, CalendarTimeZoneSchema, type SchedulingConfig } from "./config.js";
import { CalendarError, invalidCalendarInput } from "./errors.js";

export const MAX_SCHEDULING_HORIZON_MS = 366 * 24 * 60 * 60_000;
export const MAX_AVAILABILITY_INTERVAL_MS = 24 * 60 * 60_000;
const text = z.string().trim().min(1).max(200).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
export const Rfc3339Schema = z.iso.datetime({ offset: true });
const draftInputSchema = z.object({
  startTime: Rfc3339Schema, customerEmail: CalendarEmailSchema,
  productId: text, productName: text,
}).strict();
export const AppointmentDraftSchema = z.object({
  startTime: Rfc3339Schema, endTime: Rfc3339Schema, timeZone: CalendarTimeZoneSchema,
  attendees: z.array(CalendarEmailSchema).min(1).max(21),
  subject: z.string().min(1).max(230).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  location: z.string().max(300).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  productId: text, productName: text,
}).strict();
export type AppointmentDraft = z.infer<typeof AppointmentDraftSchema>;
export type AppointmentDraftInput = z.infer<typeof draftInputSchema>;
export const ConfirmationIdSchema = z.string().regex(/^[A-Za-z0-9._~-]{8,200}$/);
export const ConfirmedAppointmentRequestSchema = z.object({
  confirmationId: ConfirmationIdSchema, confirmed: z.literal(true), draft: AppointmentDraftSchema,
}).strict();
export type ConfirmedAppointmentRequest = z.infer<typeof ConfirmedAppointmentRequestSchema>;
export const ConfirmedCancellationRequestSchema = z.object({
  confirmationId: ConfirmationIdSchema, confirmed: z.literal(true),
}).strict();
export type ConfirmedCancellationRequest = z.infer<typeof ConfirmedCancellationRequestSchema>;
export interface AvailabilityInterval { startTime: string; endTime: string; timeZone: string }
export interface CalendarAvailability extends AvailabilityInterval {
  available: boolean;
  busy: { startTime: string; endTime: string }[];
  inventoryReserved: false;
}

export function validateInterval(interval: AvailabilityInterval, now: Date): void {
  const parsed = z.object({ startTime: Rfc3339Schema, endTime: Rfc3339Schema, timeZone: CalendarTimeZoneSchema }).safeParse(interval);
  if (!parsed.success) invalidCalendarInput();
  const start = Date.parse(interval.startTime);
  const end = Date.parse(interval.endTime);
  if (!Number.isFinite(now.getTime()) || start <= now.getTime() || end <= start ||
      end - start > MAX_AVAILABILITY_INTERVAL_MS || end > now.getTime() + MAX_SCHEDULING_HORIZON_MS) {
    throw new CalendarError("CALENDAR_INTERVAL_INVALID", "Choose a future interval of at most 24 hours within the next 366 days.", 400);
  }
}

function offsetMatchesZone(startTime: string, timeZone: string): boolean {
  const date = new Date(startTime);
  const local = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${local.year}-${local.month}-${local.day}T${local.hour}:${local.minute}:${local.second}` === startTime.slice(0, 19);
}

export function createAppointmentDraft(config: SchedulingConfig, input: AppointmentDraftInput, now = new Date()): AppointmentDraft {
  const result = draftInputSchema.safeParse(input);
  if (!result.success) invalidCalendarInput();
  const parsed = result.data;
  if (!CalendarTimeZoneSchema.safeParse(config.timeZone).success ||
      !Number.isInteger(config.durationMinutes) || config.durationMinutes < 1 || config.durationMinutes > 240) invalidCalendarInput();
  // Explicit offsets disambiguate the repeated fall-back hour and reject spring-forward gaps.
  if (!offsetMatchesZone(parsed.startTime, config.timeZone)) {
    throw new CalendarError("CALENDAR_TIME_ZONE_MISMATCH", "The requested local time and UTC offset do not match the scheduling time zone.", 400);
  }
  const startTime = new Date(parsed.startTime).toISOString();
  const draft = {
    startTime, endTime: new Date(Date.parse(startTime) + config.durationMinutes * 60_000).toISOString(),
    timeZone: config.timeZone,
    attendees: [...new Set([parsed.customerEmail, ...config.staffEmails])].sort(),
    subject: `Showroom appointment: ${parsed.productName}`, location: config.location,
    productId: parsed.productId, productName: parsed.productName,
  };
  return validateAppointmentDraft(config, draft, now);
}

export function validateAppointmentDraft(config: SchedulingConfig, input: AppointmentDraft, now?: Date): AppointmentDraft {
  const result = AppointmentDraftSchema.safeParse(input);
  if (!result.success) invalidCalendarInput();
  const draft = result.data;
  if (draft.timeZone !== config.timeZone || Date.parse(draft.endTime) - Date.parse(draft.startTime) !== config.durationMinutes * 60_000 ||
      draft.location !== config.location || draft.subject !== `Showroom appointment: ${draft.productName}` ||
      new Set(draft.attendees).size > new Set(config.staffEmails).size + 1 ||
      config.staffEmails.some((email) => !draft.attendees.includes(email))) invalidCalendarInput();
  if (now) validateInterval(draft, now);
  return { ...draft, startTime: new Date(draft.startTime).toISOString(), endTime: new Date(draft.endTime).toISOString(), attendees: [...new Set(draft.attendees)].sort() };
}

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
export const confirmationKey = (id: string): string => sha256(id);
export const eventIdForConfirmation = (calendarId: string, id: string): string =>
  `mp${sha256(JSON.stringify(["magicpitch-showroom-v1", calendarId, id]))}`;
export function appointmentFingerprint(calendarId: string, draft: AppointmentDraft): string {
  return sha256(JSON.stringify([
    calendarId, new Date(draft.startTime).toISOString(), new Date(draft.endTime).toISOString(), draft.timeZone,
    [...new Set(draft.attendees.map((email) => email.toLowerCase()))].sort(), draft.subject, draft.location, draft.productId, draft.productName,
  ]));
}
