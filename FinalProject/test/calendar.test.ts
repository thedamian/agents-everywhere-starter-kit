import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  CalendarError, CalendarSchedulingService, FileCalendarReceiptStore, FileOAuthTokenStore,
  GOOGLE_CALENDAR_SCOPES, GoogleCalendarProvider, GoogleOAuthClient,
  appointmentFingerprint, confirmationKey, createAppointmentDraft, eventIdForConfirmation, parseCalendarConfig,
  type AppointmentDraft, type CalendarFetch, type CalendarReceiptRecord, type CalendarReceiptStore,
  type ConfirmedAppointmentRequest, type GoogleCalendarConfig, type GoogleCalendarEvent,
  type OAuthTokens, type OAuthTokenStore,
} from "../src/calendar/index.js";

const NOW = new Date("2026-01-15T12:00:00.000Z");
const clock = () => new Date(NOW);
function config(overrides: NodeJS.ProcessEnv = {}): GoogleCalendarConfig {
  const value = parseCalendarConfig({
    CALENDAR_PROVIDER: "google", GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret",
    SCHEDULING_STAFF_EMAILS: "Staff@Example.org", SCHEDULING_LOCATION: "Showroom, 100 Main Street",
    ...overrides,
  });
  assert.equal(value.provider, "google");
  if (value.provider !== "google") throw new Error("Expected google fixture");
  return value;
}
function draft(settings = config(), startTime = "2026-02-01T10:00:00-05:00"): AppointmentDraft {
  return createAppointmentDraft(settings, { startTime, customerEmail: "Customer@Example.org", productId: "vehicle-1", productName: "Demo EV" }, NOW);
}
function confirmed(value = draft(), confirmationId = "confirm-test-001"): ConfirmedAppointmentRequest {
  return { confirmed: true, confirmationId, draft: value };
}
function failure(code: string, uncertain?: boolean) {
  return (error: unknown) => {
    assert.ok(error instanceof CalendarError);
    assert.equal(error.code, code);
    if (uncertain !== undefined) assert.equal(error.acceptanceUncertain, uncertain);
    return true;
  };
}
class MemoryReceipts implements CalendarReceiptStore {
  readonly values = new Map<string, CalendarReceiptRecord>();
  async load(key: string) { return structuredClone(this.values.get(key)); }
  async save(record: CalendarReceiptRecord) { this.values.set(record.confirmationKey, structuredClone(record)); }
}
class MemoryTokens implements OAuthTokenStore {
  value?: OAuthTokens;
  clears = 0;
  async load() { return structuredClone(this.value); }
  async save(value: OAuthTokens) { this.value = structuredClone(value); }
  async clear() { this.clears++; this.value = undefined; }
}
interface CapturedRequest { url: URL; init: RequestInit }
class FakeCalendar {
  readonly events = new Map<string, GoogleCalendarEvent>();
  readonly calls: CapturedRequest[] = [];
  before?: (request: CapturedRequest) => Promise<Response | undefined>;
  afterInsert?: (event: GoogleCalendarEvent) => Promise<Response>;
  afterDelete?: () => Promise<Response>;
  constructor(readonly settings = config()) {}
  readonly fetch: CalendarFetch = async (url, init) => {
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    const request = { url: new URL(url), init };
    this.calls.push(request);
    const intercepted = await this.before?.(request);
    if (intercepted) return intercepted;
    if (request.url.pathname.endsWith("/freeBusy")) {
      const body: { timeMin: string; timeMax: string; timeZone: string; items: { id: string }[] } = JSON.parse(String(init.body));
      assert.deepEqual(body.items, [{ id: this.settings.calendarId }]);
      const busy = [...this.events.values()].filter((event) => event.status !== "cancelled" &&
        Date.parse(event.start?.dateTime ?? "") < Date.parse(body.timeMax) && Date.parse(event.end?.dateTime ?? "") > Date.parse(body.timeMin))
        .map((event) => ({ start: event.start?.dateTime, end: event.end?.dateTime }));
      return Response.json({ timeMin: body.timeMin, timeMax: body.timeMax, calendars: { [this.settings.calendarId]: { busy } } });
    }
    const eventId = request.url.pathname.split("/").at(-1) ?? "";
    if (init.method === "GET") {
      const event = this.events.get(eventId);
      return event ? Response.json(event) : new Response(null, { status: 404 });
    }
    if (init.method === "POST") {
      const body: GoogleCalendarEvent = JSON.parse(String(init.body));
      if (this.events.has(body.id)) return new Response(null, { status: 409 });
      const event: GoogleCalendarEvent = {
        ...body, status: "confirmed", organizer: { self: true },
        etag: '"version-1"', htmlLink: `https://www.google.com/calendar/event?eid=${body.id}`,
      };
      this.events.set(event.id, event);
      return this.afterInsert ? this.afterInsert(event) : Response.json(event);
    }
    if (init.method === "DELETE") {
      assert.equal(request.url.searchParams.get("sendUpdates"), "all");
      assert.equal(new Headers(init.headers).get("if-match"), '"version-1"');
      this.events.delete(eventId);
      return this.afterDelete ? this.afterDelete() : new Response(null, { status: 204 });
    }
    throw new Error("Unexpected fake calendar request");
  };
  service(receipts: CalendarReceiptStore = new MemoryReceipts(), settings = this.settings) {
    return new CalendarSchedulingService(settings, {
      receipts, clock, provider: new GoogleCalendarProvider(settings, {
        fetch: this.fetch, clock, auth: { getAccessToken: async () => "fake-access-token" },
      }),
    });
  }
  count(method: string) {
    return this.calls.filter((call) => call.init.method === method && !call.url.pathname.endsWith("/freeBusy")).length;
  }
}
async function privateDirectory(t: TestContext): Promise<string> {
  const root = join(process.cwd(), "artifacts");
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(join(root, "calendar-test-"));
  t.after(() => rm(path, { recursive: true, maxRetries: 10, retryDelay: 300 }));
  return path;
}

test("calendar configuration is pure, explicitly disabled by default and narrowly scoped", () => {
  assert.equal(parseCalendarConfig().provider, "disabled");
  const settings = config();
  assert.equal(settings.calendarId, "primary");
  assert.equal(settings.durationMinutes, 60);
  assert.equal(settings.timeZone, "America/New_York");
  assert.equal(settings.redirectUri, "http://127.0.0.1:3101/oauth/google/callback");
  assert.deepEqual(settings.staffEmails, ["staff@example.org"]);
  assert.equal(settings.refreshToken, undefined);
  for (const environment of [
    { CALENDAR_PROVIDER: "mock" }, { SCHEDULING_DURATION_MINUTES: "0" }, { SCHEDULING_DURATION_MINUTES: "1.5" },
    { SCHEDULING_DURATION_MINUTES: "241" }, { SCHEDULING_TIME_ZONE: "Mars/Showroom" },
    { SCHEDULING_STAFF_EMAILS: "private-invalid-email" }, { SCHEDULING_STAFF_EMAILS: "valid@example.org," },
    { GOOGLE_CLIENT_SECRET: "" }, { GOOGLE_OAUTH_REDIRECT_URI: "http://evil.example/callback" },
    { GOOGLE_OAUTH_REDIRECT_URI: "http://secret:password@127.0.0.1/callback" },
    { GOOGLE_OAUTH_REDIRECT_URI: "http://127.0.0.1/callback?secret=private" },
    { SCHEDULING_LOCATION: "private\ninjection" },
    { GOOGLE_REFRESH_TOKEN: "private\r\ninjection" },
  ]) {
    assert.throws(() => config(environment), (error: unknown) => {
      assert.ok(error instanceof CalendarError);
      assert.equal(error.code, "CALENDAR_CONFIG_INVALID");
      assert.doesNotMatch(error.message, /private|password|evil\.example/);
      return true;
    });
  }
});

test("disabled/readiness paths never fetch, persist bookings or fabricate free slots", async () => {
  const receipts = new MemoryReceipts();
  const disabled = new CalendarSchedulingService(parseCalendarConfig(), { receipts, clock });
  await assert.rejects(disabled.checkAvailability(draft()), failure("CALENDAR_DISABLED"));
  await assert.rejects(disabled.confirm(confirmed()), failure("CALENDAR_DISABLED"));
  await assert.rejects(disabled.cancel({ confirmationId: "confirm-test-001", confirmed: true }), failure("CALENDAR_DISABLED"));
  await assert.rejects(new CalendarSchedulingService(config(), { receipts }).confirm(confirmed()), failure("CALENDAR_NOT_READY"));
  assert.equal(receipts.values.size, 0);
});

test("draft has exact sixty-minute elapsed duration and normalized complete recipients", () => {
  const value = draft();
  assert.equal(value.startTime, "2026-02-01T15:00:00.000Z");
  assert.equal(value.endTime, "2026-02-01T16:00:00.000Z");
  assert.equal(Date.parse(value.endTime) - Date.parse(value.startTime), 60 * 60_000);
  assert.deepEqual(value.attendees, ["customer@example.org", "staff@example.org"]);
  assert.equal(value.subject, "Showroom appointment: Demo EV");
  assert.equal(value.location, "Showroom, 100 Main Street");
  assert.equal(draft(config({ SCHEDULING_DURATION_MINUTES: "90" })).endTime, "2026-02-01T16:30:00.000Z");
});

test("DST gaps rejected and repeated hours explicitly disambiguated without changing elapsed duration", () => {
  const spring = draft(config(), "2026-03-08T01:30:00-05:00");
  assert.equal(spring.endTime, "2026-03-08T07:30:00.000Z");
  assert.throws(() => draft(config(), "2026-03-08T02:30:00-05:00"), failure("CALENDAR_TIME_ZONE_MISMATCH"));
  const first = draft(config(), "2026-11-01T01:30:00-04:00");
  const second = draft(config(), "2026-11-01T01:30:00-05:00");
  assert.equal(Date.parse(second.startTime) - Date.parse(first.startTime), 3_600_000);
  assert.equal(Date.parse(first.endTime) - Date.parse(first.startTime), 3_600_000);
  assert.throws(() => draft(config(), "2026-06-01T10:00:00-05:00"), failure("CALENDAR_TIME_ZONE_MISMATCH"));
});

test("invalid transcript-like dates, dates outside bounds and malformed appointment fields fail before I/O", async () => {
  for (const time of ["tomorrow at 6", "2026-02-01T10:00:00", "2026-02-30T10:00:00-05:00",
    "2026-01-01T10:00:00-05:00", "2028-02-01T10:00:00-05:00"]) {
    assert.throws(() => draft(config(), time), CalendarError);
  }
  assert.throws(() => createAppointmentDraft(config(), {
    startTime: "2026-02-01T10:00:00-05:00", customerEmail: "name <customer@example.org>", productId: "car", productName: "EV",
  }, NOW), CalendarError);
  const fake = new FakeCalendar();
  const service = fake.service();
  for (const changed of [
    { ...draft(), endTime: "2026-02-01T16:01:00Z" },
    { ...draft(), timeZone: "UTC" }, { ...draft(), attendees: ["customer@example.org"] },
    { ...draft(), location: "Different venue" }, { ...draft(), subject: "Different subject" },
    { ...draft(), attendees: [...draft().attendees, "unconfigured@example.org"] },
  ]) await assert.rejects(service.confirm(confirmed(changed)), CalendarError);
  // This is deliberate runtime validation of untrusted JSON, not a typed caller bypass.
  const unconfirmed: ConfirmedAppointmentRequest = JSON.parse(JSON.stringify({ ...confirmed(), confirmed: false }));
  await assert.rejects(service.confirm(unconfirmed), CalendarError);
  assert.equal(fake.calls.length, 0);
});

test("event IDs use Google's base32hex alphabet and fingerprints normalize equivalent requests", () => {
  for (let index = 0; index < 100; index++) assert.match(eventIdForConfirmation("primary", randomUUID()), /^[0-9a-v]{5,1024}$/);
  assert.equal(eventIdForConfirmation("primary", "same"), eventIdForConfirmation("primary", "same"));
  assert.notEqual(eventIdForConfirmation("other", "same"), eventIdForConfirmation("primary", "same"));
  const value = draft();
  assert.equal(appointmentFingerprint("primary", value), appointmentFingerprint("primary", {
    ...value, attendees: ["STAFF@EXAMPLE.ORG", "CUSTOMER@EXAMPLE.ORG"], startTime: "2026-02-01T10:00:00-05:00",
  }));
  assert.notEqual(appointmentFingerprint("primary", value), appointmentFingerprint("primary", { ...value, productId: "other" }));
});

test("availability only reads real freeBusy and returns exact query interval, not inventory", async () => {
  const fake = new FakeCalendar();
  const value = draft();
  const result = await fake.service().checkAvailability(value);
  assert.equal(result.available, true);
  assert.equal(result.inventoryReserved, false);
  assert.equal(fake.count("POST"), 0);
  const body: Record<string, unknown> = JSON.parse(String(fake.calls[0]?.init.body));
  assert.equal(body.timeMin, value.startTime);
  assert.equal(body.timeMax, value.endTime);
  assert.equal(body.timeZone, value.timeZone);
});

test("provider rejects unbounded direct availability and calendar/group errors before offering anything", async () => {
  const fake = new FakeCalendar();
  const provider = new GoogleCalendarProvider(config(), { fetch: fake.fetch, clock, auth: { getAccessToken: async () => "token" } });
  await assert.rejects(provider.checkAvailability({ startTime: draft().startTime, endTime: "2026-02-03T15:00:00Z", timeZone: draft().timeZone }),
    failure("CALENDAR_INTERVAL_INVALID"));
  assert.equal(fake.calls.length, 0);
  fake.before = async () => Response.json({
    timeMin: draft().startTime, timeMax: draft().endTime, calendars: { primary: { busy: [] } },
    groups: { group: { errors: [{ reason: "groupTooBig" }] } },
  });
  await assert.rejects(provider.checkAvailability(draft()), failure("CALENDAR_AVAILABILITY_FAILED"));
  fake.before = async () => Response.json({
    timeMin: "2026-02-01T16:00:00Z", timeMax: draft().endTime, calendars: { primary: { busy: [] } },
  });
  await assert.rejects(provider.checkAvailability(draft()), failure("CALENDAR_INVALID_RESPONSE"));
});

test("freeBusy HTTP 200 per-calendar errors, missing calendars and malformed ranges never become free", async () => {
  for (const calendars of [
    { primary: { errors: [{ reason: "notFound" }], busy: [] } },
    { primary: { busy: [] }, other: { errors: [{ reason: "internalError" }] } },
    {}, { primary: {} }, { primary: { busy: [{ start: "invalid", end: "invalid" }] } },
    { primary: { busy: [{ start: draft().endTime, end: draft().startTime }] } },
  ]) {
    const fake = new FakeCalendar();
    fake.before = async () => Response.json({ timeMin: draft().startTime, timeMax: draft().endTime, calendars });
    await assert.rejects(fake.service().checkAvailability(draft()), CalendarError);
    assert.equal(fake.count("POST"), 0);
  }
});

test("calendar access/HTTP/body failures are sanitized and cannot become slots", async () => {
  for (const status of [401, 403, 429, 500]) {
    const fake = new FakeCalendar();
    fake.before = async () => new Response("private-provider-secret", { status });
    await assert.rejects(fake.service().checkAvailability(draft()), (error: unknown) => {
      assert.ok(error instanceof CalendarError);
      assert.doesNotMatch(error.message + error.stack, /private-provider-secret|fake-access-token/);
      return true;
    });
  }
  const fake = new FakeCalendar();
  fake.before = async () => new Response("private-invalid-json");
  await assert.rejects(fake.service().checkAvailability(draft()), failure("CALENDAR_INVALID_RESPONSE"));
});

test("confirmed insert rechecks availability and requests all invitations with exact details only", async () => {
  const fake = new FakeCalendar();
  const receipts = new MemoryReceipts();
  const value = draft();
  const receipt = await fake.service(receipts).confirm(confirmed(value));
  assert.equal(receipt.status, "created");
  assert.equal(receipt.invitationsRequested, true);
  assert.equal(receipt.inventoryReserved, false);
  assert.equal(receipt.cancellationUpdatesRequested, false);
  assert.match(receipt.htmlLink ?? "", /^https:\/\/www\.google\.com\/calendar\/event/);
  assert.deepEqual(fake.calls.map((call) => `${call.init.method} ${call.url.pathname.split("/").at(-1)}`),
    [`GET ${receipt.eventId}`, "POST freeBusy", "POST events"]);
  const call = fake.calls.at(-1);
  assert.equal(call?.url.searchParams.get("sendUpdates"), "all");
  const body: Record<string, unknown> = JSON.parse(String(call?.init.body));
  assert.deepEqual(body.start, { dateTime: value.startTime, timeZone: value.timeZone });
  assert.deepEqual(body.end, { dateTime: value.endTime, timeZone: value.timeZone });
  assert.deepEqual(body.attendees, value.attendees.map((email) => ({ email })));
  assert.equal(body.description, undefined);
  assert.equal(body.attachments, undefined);
  assert.equal(body.summary, value.subject);
  const stored = JSON.stringify([...receipts.values.values()]);
  assert.doesNotMatch(stored, /customer@example|staff@example|Main Street|Demo EV|fake-access-token|confirm-test-001/);
  assert.equal(receipts.values.get(confirmationKey("confirm-test-001"))?.state, "created");
});

test("busy interval blocks creation, including a change after earlier availability read", async () => {
  const fake = new FakeCalendar();
  const service = fake.service();
  assert.equal((await service.checkAvailability(draft())).available, true);
  fake.events.set("external", {
    id: "external", status: "confirmed", start: { dateTime: draft().startTime }, end: { dateTime: draft().endTime },
  });
  await assert.rejects(service.confirm(confirmed()), failure("CALENDAR_BUSY"));
  assert.equal(fake.count("POST"), 0);
});

test("duplicate concurrent commands and normalized retries create one event", async () => {
  const fake = new FakeCalendar();
  const receipts = new MemoryReceipts();
  const service = fake.service(receipts);
  const results = await Promise.all([service.confirm(confirmed()), fake.service(receipts).confirm(confirmed())]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(fake.count("POST"), 1);
  const normalized = confirmed({ ...draft(), attendees: [...draft().attendees].reverse(), startTime: "2026-02-01T10:00:00-05:00" });
  assert.deepEqual(await service.confirm(normalized), results[0]);
  const changed = draft(config(), "2026-02-01T11:00:00-05:00");
  await assert.rejects(service.confirm(confirmed(changed)), failure("CALENDAR_CONFIRMATION_CONFLICT"));
  assert.equal(fake.count("POST"), 1);
});

test("local concurrent calendar writes serialize the availability check and insertion", async () => {
  const fake = new FakeCalendar();
  const results = await Promise.allSettled([
    fake.service().confirm(confirmed(draft(), "first-confirmation")),
    fake.service().confirm(confirmed(draft(), "second-confirmation")),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(fake.count("POST"), 1);
});

test("insertion timeout, 409 and invalid response reconcile same ID without another insert", async () => {
  for (const result of ["timeout", "conflict", "invalid"] as const) {
    const fake = new FakeCalendar();
    fake.afterInsert = async () => {
      if (result === "timeout") throw new Error("private-network-token");
      if (result === "conflict") return new Response("private-conflict", { status: 409 });
      return Response.json({ wrong: true });
    };
    const receipt = await fake.service().confirm(confirmed());
    assert.equal(receipt.status, "created");
    assert.equal(fake.count("POST"), 1);
    assert.equal(fake.count("GET"), 2);
    assert.equal(fake.calls.at(-1)?.url.pathname.split("/").at(-1), receipt.eventId);
  }
});

test("uncertain unobserved write stays pending and next command reconciles before retrying same ID", async () => {
  const fake = new FakeCalendar();
  const receipts = new MemoryReceipts();
  fake.before = async ({ init, url }) => {
    if (init.method === "POST" && url.pathname.endsWith("/events")) throw new Error("secret transport error");
    return undefined;
  };
  await assert.rejects(fake.service(receipts).confirm(confirmed()), failure("CALENDAR_RESULT_UNCERTAIN", true));
  assert.equal(fake.count("POST"), 1);
  const pending = receipts.values.get(confirmationKey("confirm-test-001"));
  assert.equal(pending?.state, "pending");
  fake.before = undefined;
  const receipt = await fake.service(receipts).confirm(confirmed());
  assert.equal(receipt.eventId, pending?.eventId);
  assert.equal(fake.count("POST"), 2);
  assert.equal(fake.count("GET"), 3);
});

test("an uncertain insert whose reconciliation also fails retains a durable uncertain result", async () => {
  const fake = new FakeCalendar();
  const receipts = new MemoryReceipts();
  fake.afterInsert = async () => {
    fake.before = async ({ init }) => init.method === "GET" ? new Response(null, { status: 503 }) : undefined;
    throw new Error("private-timeout");
  };
  await assert.rejects(fake.service(receipts).confirm(confirmed()), failure("CALENDAR_RESULT_UNCERTAIN", true));
  assert.equal(fake.count("POST"), 1);
  assert.equal(receipts.values.get(confirmationKey("confirm-test-001"))?.state, "pending");
  fake.before = undefined;
  assert.equal((await fake.service(receipts).confirm(confirmed())).status, "created");
  assert.equal(fake.count("POST"), 1);
});

test("reconciliation cannot adopt an unrelated event or changed confirmed details", async () => {
  for (const mutation of ["ownership", "fingerprint", "organizer", "details"] as const) {
    const fake = new FakeCalendar();
    fake.afterInsert = async (event) => {
      if (mutation === "ownership") event.extendedProperties = { private: { app: "some-other-app" } };
      if (mutation === "fingerprint") {
        assert.ok(event.extendedProperties?.private);
        event.extendedProperties.private.fingerprint = "wrong-fingerprint";
      }
      if (mutation === "organizer") event.organizer = { self: false };
      if (mutation === "details") event.summary = "External changes";
      return new Response(null, { status: 409 });
    };
    await assert.rejects(fake.service().confirm(confirmed()), failure(mutation === "details" ? "CALENDAR_EVENT_CHANGED" : "CALENDAR_OWNERSHIP_MISMATCH"));
    assert.equal(fake.count("POST"), 1);
    assert.equal(fake.count("DELETE"), 0);
  }
});

test("untrusted or redirect-like event links are not returned or persisted as successful receipts", async () => {
  for (const link of ["https://evil.example/private-token", "https://www.google.com/url?q=private-target"]) {
    const fake = new FakeCalendar();
    const receipts = new MemoryReceipts();
    fake.afterInsert = async (event) => {
      event.htmlLink = link;
      return Response.json(event);
    };
    await assert.rejects(fake.service(receipts).confirm(confirmed()), (error: unknown) => {
      assert.ok(error instanceof CalendarError);
      assert.equal(error.code, "CALENDAR_INVALID_RESPONSE");
      assert.doesNotMatch(error.message + JSON.stringify(error), /private-token|private-target|evil\.example/);
      return true;
    });
    assert.equal(receipts.values.get(confirmationKey("confirm-test-001"))?.state, "pending");
    assert.equal(fake.count("POST"), 1);
  }
});

test("durable receipts reconcile after a post-insert save failure and fresh service restart", async (t) => {
  const directory = await privateDirectory(t);
  const disk = new FileCalendarReceiptStore(directory);
  const fake = new FakeCalendar();
  const failingStore: CalendarReceiptStore = {
    load: (key) => disk.load(key),
    save: async (record) => {
      if (record.state === "created") throw new CalendarError("CALENDAR_STORAGE_FAILED", "Storage unavailable.", 503);
      await disk.save(record);
    },
  };
  await assert.rejects(fake.service(failingStore).confirm(confirmed()), failure("CALENDAR_STORAGE_FAILED"));
  const receipt = await fake.service(new FileCalendarReceiptStore(directory)).confirm(confirmed());
  assert.equal(receipt.status, "created");
  assert.equal(fake.count("POST"), 1);
  const reads = fake.calls.length;
  assert.deepEqual(await fake.service(new FileCalendarReceiptStore(directory)).confirm(confirmed()), receipt);
  assert.equal(fake.calls.length, reads);
  const filenames = await readdir(directory);
  assert.deepEqual(filenames, [`${confirmationKey("confirm-test-001")}.json`]);
  const contents = await readFile(join(directory, filenames[0]!), "utf8");
  assert.doesNotMatch(contents, /customer@example|staff@example|test-secret|Main Street/);
});

test("receipt corruption and storage failure stop creation rather than silently resetting idempotency", async (t) => {
  const directory = await privateDirectory(t);
  await writeFile(join(directory, `${confirmationKey("confirm-test-001")}.json`), '{"private":');
  const fake = new FakeCalendar();
  await assert.rejects(fake.service(new FileCalendarReceiptStore(directory)).confirm(confirmed()), failure("CALENDAR_STORAGE_FAILED"));
  assert.equal(fake.calls.length, 0);
  assert.throws(() => new FileCalendarReceiptStore("relative-path"), failure("CALENDAR_STORAGE_INVALID"));
});

test("normal service disposal/session-photo cleanup has no calendar cancellation effect", async () => {
  const fake = new FakeCalendar();
  const receipts = new MemoryReceipts();
  await fake.service(receipts).confirm(confirmed());
  const restarted = fake.service(receipts);
  assert.equal((await restarted.confirm(confirmed())).status, "created");
  assert.equal(fake.events.size, 1);
  assert.equal(fake.count("DELETE"), 0);
});

test("a saved successful receipt remains idempotent even after the appointment time has passed", async () => {
  const fake = new FakeCalendar();
  const receipts = new MemoryReceipts();
  const original = await fake.service(receipts).confirm(confirmed());
  const calls = fake.calls.length;
  const restarted = new CalendarSchedulingService(config(), {
    receipts, clock: () => new Date("2027-04-01T00:00:00Z"),
    provider: new GoogleCalendarProvider(config(), { fetch: fake.fetch, clock, auth: { getAccessToken: async () => "token" } }),
  });
  assert.deepEqual(await restarted.confirm(confirmed()), original);
  assert.equal(fake.calls.length, calls);
});

test("explicit owned cancellation sends updates and survives duplicate requests/restart without recreation", async (t) => {
  const directory = await privateDirectory(t);
  const fake = new FakeCalendar();
  const service = fake.service(new FileCalendarReceiptStore(directory));
  await service.confirm(confirmed());
  const cancelled = await service.cancel({ confirmed: true, confirmationId: "confirm-test-001" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancellationUpdatesRequested, true);
  assert.equal(fake.count("DELETE"), 1);
  const restarted = fake.service(new FileCalendarReceiptStore(directory));
  assert.deepEqual(await restarted.cancel({ confirmed: true, confirmationId: "confirm-test-001" }), cancelled);
  await assert.rejects(restarted.confirm(confirmed()), failure("CALENDAR_BOOKING_CANCELLED"));
  assert.equal(fake.count("DELETE"), 1);
  assert.equal(fake.count("POST"), 1);
});

test("cancellation refuses missing receipts, unconfirmed requests and unrelated event ownership", async () => {
  const fake = new FakeCalendar();
  const service = fake.service();
  await assert.rejects(service.cancel({ confirmed: true, confirmationId: "unknown-confirmation" }), failure("CALENDAR_BOOKING_NOT_FOUND"));
  const invalid: { confirmed: true; confirmationId: string } = JSON.parse('{"confirmed":false,"confirmationId":"confirm-test-001"}');
  await assert.rejects(service.cancel(invalid), CalendarError);
  const receipt = await service.confirm(confirmed());
  const event = fake.events.get(receipt.eventId);
  assert.ok(event);
  event.extendedProperties = { private: { app: "other-app" } };
  await assert.rejects(service.cancel({ confirmed: true, confirmationId: "confirm-test-001" }), failure("CALENDAR_OWNERSHIP_MISMATCH"));
  assert.equal(fake.count("DELETE"), 0);
});

test("timed out cancellation reconciles absence rather than deleting twice", async () => {
  const fake = new FakeCalendar();
  const service = fake.service();
  await service.confirm(confirmed());
  fake.afterDelete = async () => { throw new Error("private transport error"); };
  assert.equal((await service.cancel({ confirmed: true, confirmationId: "confirm-test-001" })).status, "cancelled");
  assert.equal(fake.count("DELETE"), 1);
});

test("external deletion is reported cancelled without claiming a new cancellation notification", async () => {
  const fake = new FakeCalendar();
  const service = fake.service();
  const receipt = await service.confirm(confirmed());
  fake.events.delete(receipt.eventId);
  const cancelled = await service.cancel({ confirmed: true, confirmationId: "confirm-test-001" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancellationUpdatesRequested, false);
  assert.equal(fake.count("DELETE"), 0);
});

test("an event edit racing cancellation is protected by If-Match and not blindly deleted", async () => {
  const fake = new FakeCalendar();
  const service = fake.service();
  await service.confirm(confirmed());
  fake.before = async ({ init }) => init.method === "DELETE" ? new Response(null, { status: 412 }) : undefined;
  await assert.rejects(service.cancel({ confirmed: true, confirmationId: "confirm-test-001" }), failure("CALENDAR_EVENT_CHANGED"));
  assert.equal(fake.count("DELETE"), 1);
  assert.equal(fake.events.size, 1);
});

test("unobserved pending creation cannot be declared cancelled or create an event during cancellation", async () => {
  const fake = new FakeCalendar();
  const receipts = new MemoryReceipts();
  fake.before = async ({ init, url }) => {
    if (init.method === "POST" && url.pathname.endsWith("/events")) throw new Error("private-network-failure");
    return undefined;
  };
  await assert.rejects(fake.service(receipts).confirm(confirmed()), failure("CALENDAR_RESULT_UNCERTAIN"));
  await assert.rejects(fake.service(receipts).cancel({ confirmed: true, confirmationId: "confirm-test-001" }), failure("CALENDAR_RESULT_UNCERTAIN"));
  assert.equal(fake.count("POST"), 1);
  assert.equal(fake.count("DELETE"), 0);
});

test("cancellation timeout that has not deleted the event stays uncertain until explicit retry", async () => {
  const fake = new FakeCalendar();
  const service = fake.service();
  await service.confirm(confirmed());
  fake.before = async ({ init }) => {
    if (init.method === "DELETE") throw new Error("private-delete-failure");
    return undefined;
  };
  await assert.rejects(service.cancel({ confirmed: true, confirmationId: "confirm-test-001" }), failure("CALENDAR_RESULT_UNCERTAIN", true));
  assert.equal(fake.events.size, 1);
  fake.before = undefined;
  assert.equal((await service.cancel({ confirmed: true, confirmationId: "confirm-test-001" })).status, "cancelled");
  assert.equal(fake.count("DELETE"), 2);
});

test("a known booking whose event is gone with HTTP 410 is reconciled without another write", async () => {
  const fake = new FakeCalendar();
  const service = fake.service();
  await service.confirm(confirmed());
  fake.before = async ({ init }) => init.method === "GET" ? new Response(null, { status: 410 }) : undefined;
  assert.equal((await service.cancel({ confirmed: true, confirmationId: "confirm-test-001" })).status, "cancelled");
  assert.equal(fake.count("DELETE"), 0);
});

test("OAuth setup binds one-use state and S256 PKCE to the authenticated operator with narrow offline scopes", async () => {
  const tokens = new MemoryTokens();
  const settings = config();
  let authorization: URL | undefined;
  let calls = 0;
  const oauth = new GoogleOAuthClient(settings, { tokens, clock, fetch: async (url, init) => {
    calls++;
    assert.equal(url, "https://oauth2.googleapis.com/token");
    assert.equal(init.redirect, "error");
    const form = new URLSearchParams(String(init.body));
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("redirect_uri"), settings.redirectUri);
    assert.equal(form.get("client_secret"), settings.clientSecret);
    assert.equal(createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url"), authorization?.searchParams.get("code_challenge"));
    return Response.json({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 3600, token_type: "Bearer", scope: GOOGLE_CALENDAR_SCOPES.join(" ") });
  } });
  const setup = oauth.beginAuthorization("operator-session");
  authorization = new URL(setup.authorizationUrl);
  assert.deepEqual(authorization.searchParams.get("scope")?.split(" "), [...GOOGLE_CALENDAR_SCOPES]);
  assert.equal(authorization.searchParams.get("access_type"), "offline");
  assert.equal(authorization.searchParams.get("include_granted_scopes"), "false");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.doesNotMatch(setup.authorizationUrl, /gmail|test-secret|private-refresh/);
  assert.equal(calls, 0);
  const callback = `${settings.redirectUri}?state=${authorization.searchParams.get("state")}&code=private-code`;
  assert.deepEqual(await oauth.exchangeCallback(callback, "operator-session"), { connected: true });
  assert.equal(tokens.value?.refreshToken, "private-refresh");
  await assert.rejects(oauth.exchangeCallback(callback, "operator-session"), failure("CALENDAR_OAUTH_STATE_INVALID"));
  assert.equal(calls, 1);
});

test("OAuth state rejects wrong session, expiration, duplicate parameters and callback destinations before token exchange", async () => {
  const tokens = new MemoryTokens();
  let now = new Date(NOW);
  let calls = 0;
  const oauth = new GoogleOAuthClient(config(), { tokens, clock: () => now, fetch: async () => { calls++; throw new Error("Must not fetch"); } });
  for (const scenario of ["binding", "expiry", "duplicate", "destination"] as const) {
    now = new Date(NOW);
    const authorization = new URL(oauth.beginAuthorization("operator-session").authorizationUrl);
    const state = authorization.searchParams.get("state");
    let callback = `${config().redirectUri}?state=${state}&code=private-code`;
    if (scenario === "expiry") now = new Date(NOW.getTime() + 11 * 60_000);
    if (scenario === "duplicate") callback += `&state=${state}`;
    if (scenario === "destination") callback = callback.replace("127.0.0.1", "evil.example");
    await assert.rejects(oauth.exchangeCallback(callback, scenario === "binding" ? "wrong-session" : "operator-session"), failure("CALENDAR_OAUTH_STATE_INVALID"));
  }
  assert.equal(calls, 0);
});

test("OAuth consent denial and missing offline grant are explicit and never reveal callback/token data", async () => {
  const oauth = new GoogleOAuthClient(config(), { tokens: new MemoryTokens(), clock, fetch: async () =>
    Response.json({ access_token: "secret-access", expires_in: 3600, token_type: "Bearer" }),
  });
  const callback = (suffix: string) => {
    const url = new URL(oauth.beginAuthorization("operator").authorizationUrl);
    return `${config().redirectUri}?state=${url.searchParams.get("state")}&${suffix}`;
  };
  await assert.rejects(oauth.exchangeCallback(callback("error=private-denied-reason"), "operator"), failure("CALENDAR_OAUTH_DENIED"));
  await assert.rejects(oauth.exchangeCallback(callback("code=private-code"), "operator"), failure("CALENDAR_OAUTH_OFFLINE_REQUIRED"));
});

test("OAuth refresh caches access token, coalesces concurrent refresh and honors forced renewal", async () => {
  const tokens = new MemoryTokens();
  let calls = 0;
  const oauth = new GoogleOAuthClient(config({ GOOGLE_REFRESH_TOKEN: "private-env-refresh" }), { tokens, clock, fetch: async (_url, init) => {
    calls++;
    const form = new URLSearchParams(String(init.body));
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), "private-env-refresh");
    return Response.json({ access_token: `access-${calls}`, expires_in: 3600, token_type: "Bearer" });
  } });
  assert.deepEqual(await Promise.all([oauth.getAccessToken(), oauth.getAccessToken()]), ["access-1", "access-1"]);
  assert.equal(await oauth.getAccessToken(), "access-1");
  assert.equal(calls, 1);
  assert.equal(await oauth.getAccessToken(true), "access-2");
  assert.equal(tokens.value?.refreshToken, "private-env-refresh");
});

test("OAuth refresh revocation clears credentials and does not retry a revoked token", async () => {
  const tokens = new MemoryTokens();
  await tokens.save({ refreshToken: "private-revoked" });
  let calls = 0;
  const oauth = new GoogleOAuthClient(config(), { tokens, clock, fetch: async () => {
    calls++;
    return Response.json({ error: "invalid_grant", error_description: "private-revoked" }, { status: 400 });
  } });
  await assert.rejects(oauth.getAccessToken(), failure("CALENDAR_REAUTHORIZATION_REQUIRED"));
  await assert.rejects(oauth.getAccessToken(), failure("CALENDAR_REAUTHORIZATION_REQUIRED"));
  assert.equal(calls, 1);
  assert.equal(tokens.clears, 1);
  assert.equal(tokens.value, undefined);
});

test("an invalid setup code does not erase an already connected operator refresh grant", async () => {
  const tokens = new MemoryTokens();
  await tokens.save({ refreshToken: "private-existing" });
  const oauth = new GoogleOAuthClient(config(), {
    tokens, clock, fetch: async () => Response.json({ error: "invalid_grant" }, { status: 400 }),
  });
  const setup = new URL(oauth.beginAuthorization("operator").authorizationUrl);
  await assert.rejects(oauth.exchangeCallback(`${config().redirectUri}?state=${setup.searchParams.get("state")}&code=expired`, "operator"),
    failure("CALENDAR_REAUTHORIZATION_REQUIRED"));
  assert.equal(tokens.value?.refreshToken, "private-existing");
  assert.equal(tokens.clears, 0);
});

test("OAuth HTTP, invalid JSON, network and inadequate-scope failures are sanitized", async () => {
  for (const scenario of ["http", "json", "network", "scopes"] as const) {
    const oauth = new GoogleOAuthClient(config({ GOOGLE_REFRESH_TOKEN: "secret-refresh" }), {
      tokens: new MemoryTokens(), clock, fetch: async () => {
        if (scenario === "network") throw new Error("secret-network-url");
        if (scenario === "json") return new Response("secret-invalid-json");
        if (scenario === "http") return Response.json({ error: "secret-provider-message" }, { status: 503 });
        return Response.json({ access_token: "secret-token", expires_in: 3600, token_type: "Bearer", scope: GOOGLE_CALENDAR_SCOPES[0] });
      },
    });
    await assert.rejects(oauth.getAccessToken(), (error: unknown) => {
      assert.ok(error instanceof CalendarError);
      assert.doesNotMatch(error.message + error.stack + JSON.stringify(error), /secret-refresh|secret-provider-message|secret-token|secret-network-url|secret-invalid-json|test-secret/);
      return true;
    });
  }
});

test("provider renews on explicit 401 only, and does not replay a transport-failed write", async () => {
  const fake = new FakeCalendar();
  const refreshes: boolean[] = [];
  let first = true;
  fake.before = async () => {
    if (first) { first = false; return new Response(null, { status: 401 }); }
    return undefined;
  };
  const provider = new GoogleCalendarProvider(config(), {
    fetch: fake.fetch, clock, auth: { getAccessToken: async (force = false) => { refreshes.push(force); return force ? "new-token" : "old-token"; } },
  });
  assert.equal((await provider.checkAvailability(draft())).available, true);
  assert.deepEqual(refreshes, [false, true]);
  assert.equal(new Headers(fake.calls[1]?.init.headers).get("authorization"), "Bearer new-token");
});

test("file OAuth token store is private, durable, clearable and fails closed on corruption", async (t) => {
  const directory = await privateDirectory(t);
  const store = new FileOAuthTokenStore(directory);
  assert.equal(await store.load(), undefined);
  await store.save({ refreshToken: "private-refresh", accessToken: "private-access", expiresAt: NOW.getTime() });
  assert.deepEqual(await new FileOAuthTokenStore(directory).load(), { refreshToken: "private-refresh", accessToken: "private-access", expiresAt: NOW.getTime() });
  await store.clear();
  assert.equal(await store.load(), undefined);
  await writeFile(join(directory, "google-oauth.json"), '{"refreshToken":17}');
  await assert.rejects(store.load(), failure("CALENDAR_STORAGE_FAILED"));
});
