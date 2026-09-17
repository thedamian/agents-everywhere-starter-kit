import { z } from "zod";
import { CalendarError } from "./errors.js";

export const CalendarEmailSchema = z.email().max(254).transform((value) => value.toLowerCase());
export const CalendarTimeZoneSchema = z.string().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return !/^[+-]/.test(value);
  } catch {
    return false;
  }
});
const cleanText = z.string().max(300).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const credential = z.string().min(1).refine((value) => !/[\u0000-\u0020\u007f]/.test(value));
const settings = z.object({
  CALENDAR_PROVIDER: z.enum(["disabled", "google"]).default("disabled"),
  GOOGLE_CLIENT_ID: credential.max(1024).optional(),
  GOOGLE_CLIENT_SECRET: credential.max(4096).optional(),
  GOOGLE_REFRESH_TOKEN: credential.max(8192).optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().default("http://127.0.0.1:3101/oauth/google/callback"),
  GOOGLE_CALENDAR_ID: cleanText.min(1).default("primary"),
  SCHEDULING_TIME_ZONE: CalendarTimeZoneSchema.default("America/New_York"),
  SCHEDULING_DURATION_MINUTES: z.coerce.number().int().min(1).max(240).default(60),
  SCHEDULING_STAFF_EMAILS: z.string().optional(),
  SCHEDULING_LOCATION: cleanText.default(""),
});

export interface SchedulingConfig {
  calendarId: string;
  timeZone: string;
  durationMinutes: number;
  staffEmails: string[];
  location: string;
}
export interface GoogleCalendarConfig extends SchedulingConfig {
  provider: "google";
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  redirectUri: string;
}
export type CalendarConfig = GoogleCalendarConfig | (SchedulingConfig & { provider: "disabled" });

export function parseCalendarConfig(environment: NodeJS.ProcessEnv = {}): CalendarConfig {
  const values = Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, value?.trim() || undefined]));
  const result = settings.safeParse(values);
  if (!result.success) {
    throw new CalendarError("CALENDAR_CONFIG_INVALID", `Invalid calendar configuration: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}.`, 503);
  }
  const parsed = result.data;
  const staff = z.array(CalendarEmailSchema).max(20).safeParse(
    parsed.SCHEDULING_STAFF_EMAILS === undefined ? [] : parsed.SCHEDULING_STAFF_EMAILS.split(",").map((email) => email.trim()),
  );
  if (!staff.success) throw new CalendarError("CALENDAR_CONFIG_INVALID", "SCHEDULING_STAFF_EMAILS must contain valid comma-separated email addresses (maximum 20).", 503);
  const shared: SchedulingConfig = {
    calendarId: parsed.GOOGLE_CALENDAR_ID,
    timeZone: parsed.SCHEDULING_TIME_ZONE,
    durationMinutes: parsed.SCHEDULING_DURATION_MINUTES,
    staffEmails: [...new Set(staff.data)].sort(),
    location: parsed.SCHEDULING_LOCATION,
  };
  if (parsed.CALENDAR_PROVIDER === "disabled") return { provider: "disabled", ...shared };
  if (!parsed.GOOGLE_CLIENT_ID || !parsed.GOOGLE_CLIENT_SECRET) {
    throw new CalendarError("CALENDAR_CONFIG_INVALID", "Google Calendar requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET; connect the operator account before scheduling.", 503);
  }
  let redirect: URL;
  try { redirect = new URL(parsed.GOOGLE_OAUTH_REDIRECT_URI); } catch {
    throw new CalendarError("CALENDAR_CONFIG_INVALID", "GOOGLE_OAUTH_REDIRECT_URI must be a registered loopback HTTP callback.", 503);
  }
  if (redirect.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname) ||
      redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname === "/") {
    throw new CalendarError("CALENDAR_CONFIG_INVALID", "GOOGLE_OAUTH_REDIRECT_URI must be a registered loopback HTTP callback without credentials, query or fragment.", 503);
  }
  return {
    provider: "google", ...shared, clientId: parsed.GOOGLE_CLIENT_ID, clientSecret: parsed.GOOGLE_CLIENT_SECRET,
    refreshToken: parsed.GOOGLE_REFRESH_TOKEN, redirectUri: redirect.href,
  };
}
