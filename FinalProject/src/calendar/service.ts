import type { CalendarConfig } from "./config.js";
import {
  ConfirmedAppointmentRequestSchema, ConfirmedCancellationRequestSchema,
  appointmentFingerprint, confirmationKey, eventIdForConfirmation, validateAppointmentDraft,
  type AppointmentDraft, type CalendarAvailability, type ConfirmedAppointmentRequest, type ConfirmedCancellationRequest,
} from "./domain.js";
import { CalendarError, invalidCalendarInput } from "./errors.js";
import { verifyCalendarEvent, type CalendarProvider, type GoogleCalendarEvent } from "./provider.js";
import type { BookingReceipt, CalendarReceiptRecord, CalendarReceiptStore } from "./receipts.js";

export interface CalendarSchedulingDependencies {
  provider?: CalendarProvider;
  receipts: CalendarReceiptStore;
  clock?: () => Date;
}

const calendarWrites = new Map<string, Promise<void>>();
async function serializeCalendar<T>(calendarId: string, operation: () => Promise<T>): Promise<T> {
  const previous = calendarWrites.get(calendarId) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => turn);
  calendarWrites.set(calendarId, tail);
  await previous;
  try { return await operation(); } finally {
    release();
    if (calendarWrites.get(calendarId) === tail) calendarWrites.delete(calendarId);
  }
}
function safeEventLink(value?: string): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new CalendarError("CALENDAR_INVALID_RESPONSE", "Google returned an invalid event link.", 502, false, true); }
  if (url.protocol !== "https:" || !["www.google.com", "calendar.google.com"].includes(url.hostname) ||
      !url.pathname.startsWith("/calendar/") || url.username || url.password || url.port) {
    throw new CalendarError("CALENDAR_INVALID_RESPONSE", "Google returned an invalid event link.", 502, false, true);
  }
  return url.href;
}

export class CalendarSchedulingService {
  private readonly clock: () => Date;
  constructor(private readonly config: CalendarConfig, private readonly dependencies: CalendarSchedulingDependencies) {
    this.clock = dependencies.clock ?? (() => new Date());
  }
  async checkAvailability(draft: AppointmentDraft): Promise<CalendarAvailability> {
    const provider = this.requireProvider();
    return provider.checkAvailability(validateAppointmentDraft(this.config, draft, this.clock()));
  }

  async confirm(input: ConfirmedAppointmentRequest): Promise<BookingReceipt> {
    const provider = this.requireProvider();
    const result = ConfirmedAppointmentRequestSchema.safeParse(input);
    if (!result.success) invalidCalendarInput();
    const draft = validateAppointmentDraft(this.config, result.data.draft);
    const key = confirmationKey(result.data.confirmationId);
    const fingerprint = appointmentFingerprint(this.config.calendarId, draft);
    const eventId = eventIdForConfirmation(this.config.calendarId, result.data.confirmationId);
    return serializeCalendar(this.config.calendarId, async () => {
      let record = await this.dependencies.receipts.load(key);
      if (record) {
        if (record.fingerprint !== fingerprint || record.calendarId !== this.config.calendarId || record.eventId !== eventId) {
          throw new CalendarError("CALENDAR_CONFIRMATION_CONFLICT", "This confirmation is already bound to different appointment details.", 409);
        }
        if (record.state === "created") return this.receipt(record);
        if (record.state === "cancelled" || record.state === "cancelling") {
          throw new CalendarError("CALENDAR_BOOKING_CANCELLED", "This booking was cancelled or is being cancelled; it will not be recreated.", 409);
        }
      } else {
        validateAppointmentDraft(this.config, draft, this.clock());
        record = {
          version: 1, confirmationKey: key, fingerprint, calendarId: this.config.calendarId, eventId,
          state: "pending", invitationsRequested: false, cancellationUpdatesRequested: false,
          updatedAt: this.clock().toISOString(),
        };
        await this.dependencies.receipts.save(record);
      }
      const existing = await provider.getEvent(eventId);
      if (existing) return this.recordCreated(record, existing, draft);
      validateAppointmentDraft(this.config, draft, this.clock());
      const availability = await provider.checkAvailability(draft);
      if (!availability.available) {
        throw new CalendarError("CALENDAR_BUSY", "That calendar interval is busy. Choose another time and explicitly confirm a new draft.", 409);
      }
      let created: GoogleCalendarEvent;
      try {
        created = await provider.insertEvent(draft, record);
      } catch (error) {
        if (!(error instanceof CalendarError) || (!error.acceptanceUncertain && error.providerStatus !== 409)) throw error;
        return this.reconcileCreation(record, draft);
      }
      // A successful HTTP response is not proof that Google returned the intended event.
      try { return await this.recordCreated(record, created, draft); } catch (error) {
        if (error instanceof CalendarError && error.code !== "CALENDAR_STORAGE_FAILED") return this.reconcileCreation(record, draft);
        throw error;
      }
    });
  }

  async cancel(input: ConfirmedCancellationRequest): Promise<BookingReceipt> {
    const provider = this.requireProvider();
    const parsed = ConfirmedCancellationRequestSchema.safeParse(input);
    if (!parsed.success) invalidCalendarInput();
    return serializeCalendar(this.config.calendarId, async () => {
      const record = await this.dependencies.receipts.load(confirmationKey(parsed.data.confirmationId));
      if (!record) throw new CalendarError("CALENDAR_BOOKING_NOT_FOUND", "No app-owned booking exists for this confirmation.", 404);
      if (record.calendarId !== this.config.calendarId ||
          record.eventId !== eventIdForConfirmation(this.config.calendarId, parsed.data.confirmationId)) {
        throw new CalendarError("CALENDAR_OWNERSHIP_MISMATCH", "The booking belongs to another calendar configuration.", 409);
      }
      if (record.state === "cancelled") return this.receipt(record);
      const event = await provider.getEvent(record.eventId);
      if (!event || event.status === "cancelled") {
        if (record.state === "pending") throw this.uncertain();
        return this.recordCancelled(record);
      }
      verifyCalendarEvent(event, record);
      if (!event.etag) throw new CalendarError("CALENDAR_INVALID_RESPONSE", "The event version could not be verified for safe cancellation.", 502);
      const cancelling: CalendarReceiptRecord = {
        ...record, state: "cancelling", invitationsRequested: true,
        cancellationUpdatesRequested: true, updatedAt: this.clock().toISOString(),
      };
      await this.dependencies.receipts.save(cancelling);
      try {
        await provider.deleteEvent(record.eventId, event.etag);
      } catch (error) {
        if (!(error instanceof CalendarError) || (!error.acceptanceUncertain && ![404, 410, 412].includes(error.providerStatus ?? 0))) throw error;
        let current: GoogleCalendarEvent | undefined;
        try { current = await provider.getEvent(record.eventId); } catch { throw this.uncertain(); }
        if (!current || current.status === "cancelled") return this.recordCancelled(cancelling);
        verifyCalendarEvent(current, record);
        if (error.providerStatus === 412) throw new CalendarError("CALENDAR_EVENT_CHANGED", "The event changed during cancellation. Review it before confirming cancellation again.", 409);
        throw this.uncertain();
      }
      return this.recordCancelled(cancelling);
    });
  }

  private requireProvider(): CalendarProvider {
    if (this.config.provider === "disabled") throw new CalendarError("CALENDAR_DISABLED", "Calendar scheduling is disabled; no invitation was requested.", 503);
    if (!this.dependencies.provider) throw new CalendarError("CALENDAR_NOT_READY", "Calendar scheduling is not connected.", 503);
    return this.dependencies.provider;
  }
  private async reconcileCreation(record: CalendarReceiptRecord, draft: AppointmentDraft): Promise<BookingReceipt> {
    let existing: GoogleCalendarEvent | undefined;
    try { existing = await this.requireProvider().getEvent(record.eventId); } catch { throw this.uncertain(); }
    if (!existing) throw this.uncertain();
    return this.recordCreated(record, existing, draft);
  }
  private async recordCreated(record: CalendarReceiptRecord, event: GoogleCalendarEvent, draft: AppointmentDraft): Promise<BookingReceipt> {
    verifyCalendarEvent(event, record, draft);
    if (event.status === "cancelled") {
      await this.recordCancelled(record);
      throw new CalendarError("CALENDAR_BOOKING_CANCELLED", "This booking has been cancelled and will not be recreated.", 409);
    }
    if (event.status !== "confirmed") throw this.uncertain();
    const created: CalendarReceiptRecord = {
      ...record, state: "created", invitationsRequested: true,
      htmlLink: safeEventLink(event.htmlLink), updatedAt: this.clock().toISOString(),
    };
    await this.saveVerifiedOutcome(created);
    return this.receipt(created);
  }
  private async recordCancelled(record: CalendarReceiptRecord): Promise<BookingReceipt> {
    const cancelled: CalendarReceiptRecord = { ...record, state: "cancelled", updatedAt: this.clock().toISOString() };
    await this.saveVerifiedOutcome(cancelled);
    return this.receipt(cancelled);
  }
  private async saveVerifiedOutcome(record: CalendarReceiptRecord): Promise<void> {
    try { await this.dependencies.receipts.save(record); } catch {
      throw new CalendarError(
        "CALENDAR_STORAGE_FAILED",
        "Google Calendar has an observed outcome, but its receipt could not be saved. Retry only this same confirmation; do not create a replacement booking.",
        503, true, true,
      );
    }
  }
  private receipt(record: CalendarReceiptRecord): BookingReceipt {
    if (record.state !== "created" && record.state !== "cancelled") throw this.uncertain();
    return {
      status: record.state, calendarId: record.calendarId, eventId: record.eventId,
      htmlLink: safeEventLink(record.htmlLink), invitationsRequested: record.invitationsRequested,
      cancellationUpdatesRequested: record.cancellationUpdatesRequested, inventoryReserved: false,
    };
  }
  private uncertain(): CalendarError {
    return new CalendarError("CALENDAR_RESULT_UNCERTAIN", "Calendar outcome is not yet verified. Retry only this same confirmation; do not create a replacement booking.", 503, true, true);
  }
}
