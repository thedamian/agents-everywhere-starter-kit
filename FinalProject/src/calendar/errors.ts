import { ProviderFailure } from "../providers/http-client.js";

export class CalendarError extends ProviderFailure {
  constructor(
    code: string,
    message: string,
    public readonly status = 502,
    retryable = false,
    acceptanceUncertain = false,
    public readonly providerStatus?: number,
  ) {
    super(code, message, retryable, acceptanceUncertain);
    this.name = "CalendarError";
  }
}

export function invalidCalendarInput(): never {
  throw new CalendarError("CALENDAR_INVALID_INPUT", "Appointment details are invalid; verify the time, time zone, vehicle and recipients.", 400);
}
