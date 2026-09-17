# Google Calendar scheduling core

`src/calendar/index.ts` is a server-only, dependency-injected Google Calendar integration.
It does not register HTTP routes, open a port, connect on startup, fabricate slots, or send
Gmail/ICS email. Scheduling defaults to disabled. A calendar free/busy result is **not a
vehicle inventory reservation**.

## Operator configuration

| Environment setting | Meaning / default |
| --- | --- |
| `CALENDAR_PROVIDER` | `disabled` (default) or `google`; no mock scheduling mode |
| `GOOGLE_CLIENT_ID` | Google OAuth web application client ID; required in Google mode |
| `GOOGLE_CLIENT_SECRET` | Server-only OAuth client secret; required in Google mode |
| `GOOGLE_REFRESH_TOKEN` | Optional server-only bootstrap token; missing token requires operator setup |
| `GOOGLE_OAUTH_REDIRECT_URI` | Registered loopback callback, default `http://127.0.0.1:3101/oauth/google/callback` |
| `GOOGLE_CALENDAR_ID` | `primary` by default; otherwise an explicitly operator-owned calendar ID |
| `SCHEDULING_TIME_ZONE` | IANA zone, default `America/New_York` |
| `SCHEDULING_DURATION_MINUTES` | Default `60` elapsed minutes; integer 1 through 240 |
| `SCHEDULING_STAFF_EMAILS` | Optional comma-separated staff attendees, maximum 20 |
| `SCHEDULING_LOCATION` | Exact showroom address/name for confirmation and event; empty if unset |

`parseCalendarConfig(environment)` is pure: pass the server's environment explicitly.
Disabled configuration never enables provider calls, even if credentials are present.
An empty location is not inferred from an address or calendar; configure the showroom
location before enabling customer bookings. No business hours or default "tomorrow at
18:00" are invented.

### Google account connection

1. In the Google Cloud project, enable **Google Calendar API**, configure the OAuth consent
   screen/audience and test users if applicable, and create a **Web application** OAuth client.
2. Register the exact callback URI configured above. Run setup in the operator's browser
   **on the backend machine**: loopback in an iPad browser refers to the iPad, not the backend.
3. Request only these scopes: `https://www.googleapis.com/auth/calendar.events.owned` and
   `https://www.googleapis.com/auth/calendar.freebusy`. Never use Gmail scopes, inbox access,
   SMTP, an app password or a service account impersonating a consumer Gmail account.
4. Integrate an operator-authenticated setup action calling `beginAuthorization(binding)`.
   Use a high-entropy server-side operator-session binding, not a customer session ID.
   Redirect the operator to the returned authorization URL. Its one-use state is bound to
   that session, expires after ten minutes, and uses S256 PKCE and offline consent.
5. Mount `exchangeCallback(fullCallbackUrl, sameBinding)` at the configured callback path.
   Verify the operator's authenticated session in the HTTP adapter. The helper validates
   destination and state, exchanges the code server-side, and saves tokens in its injected
   token store. It returns only `{ connected: true }`, never tokens. Return a minimal setup
   result with `Cache-Control: no-store`, no third-party assets, and `Referrer-Policy:
   no-referrer`. Do not log the query string, code, state, request body, tokens or configuration.
6. Use the connected account's primary calendar or a calendar it owns. The owned-events
   scope deliberately disallows writing somebody else's shared calendar. A free/busy or
   access error is a failure, never an available slot.

`GoogleOAuthClient` refreshes expired access tokens server-side; explicit API 401 responses
cause one refresh retry. Revoked/expired refresh grants require reauthorization and clear
the token store. If consent does not return a refresh token, revoke the prior app grant in
the Google account and reconnect; do not reuse a token from a different account. External
apps left in Google's Testing publishing status can have short-lived refresh grants
(commonly seven days for these scopes); choose the appropriate publishing/verification
status for production. Never paste tokens into chat, logs, repository files or kiosk state.

## Integration contract

```ts
import {
  CalendarSchedulingService, FileCalendarReceiptStore, FileOAuthTokenStore,
  GoogleCalendarProvider, GoogleOAuthClient, createAppointmentDraft, parseCalendarConfig,
} from "./calendar/index.js";

const calendar = parseCalendarConfig(process.env);
// These absolute private directories are supplied by the host; never use public/assets.
const tokens = new FileOAuthTokenStore(privateTokenDirectory);
const receipts = new FileCalendarReceiptStore(privateBookingDirectory);
const oauth = calendar.provider === "google"
  ? new GoogleOAuthClient(calendar, { tokens, clock, fetch: serverFetch })
  : undefined;
const provider = calendar.provider === "google" && oauth
  ? new GoogleCalendarProvider(calendar, { auth: oauth, clock, fetch: serverFetch })
  : undefined;
const scheduling = new CalendarSchedulingService(calendar, { provider, receipts, clock });
const draft = createAppointmentDraft(calendar, {
  startTime: "2026-11-01T01:30:00-04:00",
  customerEmail: "customer@example.org",
  productId: "vehicle-catalog-id",
  productName: "Approved showroom vehicle",
}, clock());
const availability = await scheduling.checkAvailability(draft); // read only
// Only after the session authority validates the immutable pending action:
const booking = await scheduling.confirm({ confirmationId, confirmed: true, draft });
// Separate explicit cancellation, authorized against the same app-owned booking:
const cancelled = await scheduling.cancel({ confirmationId, confirmed: true });
```

`createAppointmentDraft` requires an explicit-offset RFC3339 **local** start time matching
the configured IANA zone. Missing offsets, spring-forward nonexistent times and offsets
inconsistent with daylight saving time fail validation. The fall-back repeated hour needs
the user to select the exact offset/time; no silent choice is made. The returned draft uses
normalized UTC ISO start/end plus the IANA time zone. The default duration is exactly 60
elapsed minutes, even across DST transitions. Format the start **and end** in the specified
zone for readback (and include their offsets if the interval crosses a transition).
Intervals must be future, no longer than 24 hours, and end within 366 days.

The draft is `{startTime,endTime,timeZone,attendees,subject,location,productId,productName}`.
Recipients are validated, deduplicated and sorted; customer plus all configured staff are
included. The session authority must bind a cryptographically unpredictable confirmation
ID (8-200 URL-safe characters), immutable draft, pending-action revision, expiry and explicit
user approval. Read back exact time/timezone, **all** recipients, location and vehicle.
`confirmed: true` is an adapter assertion, not speech recognition or authorization. Do not
pass transcript strings directly to `confirm`; do not call the low-level provider write
methods from voice handlers. `CalendarError` extends the existing `ProviderFailure` and
exposes sanitized `code`, `status`, `retryable`, `acceptanceUncertain`, and optional upstream
`providerStatus` for the adapter to map without exposing provider bodies.

`BookingReceipt` contains `status: "created" | "cancelled"`, `calendarId`, `eventId`,
optional Google `htmlLink`, `invitationsRequested`, `cancellationUpdatesRequested`, and
`inventoryReserved: false`. "Requested" means Calendar API notification dispatch was
requested; it does **not** mean email delivered, invitation accepted or vehicle reserved.
Externally removed events may be reported cancelled with no new cancellation notification.

## Durable idempotency and cancellation

Receipts are separate from session/photo/media cleanup. They contain a hash of the
confirmation ID, normalized request fingerprint, calendar/event IDs, state, safe event link,
notification-request flags and timestamp, not customer email, transcript, media or secrets.
Persist them before the first write. Event IDs use a deterministic app namespace and SHA-256
hex, compatible with Google's base32hex event-ID alphabet. Retries retain the same ID.

Before creation, pending bookings first query `events.get` for that exact ID. A new insert
rechecks `freeBusy` immediately before `events.insert?sendUpdates=all`. Timeout, server
uncertainty, malformed insert responses and 409 conflicts reconcile with `events.get`,
checking app ownership, fingerprint, confirmation mapping, organizer ownership and actual
event fields. An unobserved outcome stays pending and returns `CALENDAR_RESULT_UNCERTAIN`;
do not invent a replacement confirmation ID. A subsequent retry reconciles again before
attempting the same deterministic ID. Persisted successful receipts make retries/restarts
idempotent, including a failure saving the first post-insert receipt.

Cancellation loads the durable app booking, verifies the event ownership markers, and sends
`events.delete?sendUpdates=all` with `If-Match` to protect concurrent edits. A delete timeout
reconciles the same ID. A cancelled confirmation can never recreate its event. Normal kiosk
end, customer departure, photo-consent withdrawal, generated-video deletion and OAuth
disconnection **must not call cancellation**. Retain a separate operator/booking-authorized
cancellation capability beyond the ephemeral photo session; a confirmation ID alone is not
HTTP authorization.

The bundled file stores use atomic replacement and flushed files, with restrictive POSIX
modes where supported. Place them outside served directories, protect their Windows ACLs
to the service account, persist/back up the volume, and do not delete receipts on restart.
Calendar IDs/event links can themselves be identifying: keep receipts private. Storage
corruption/failure stops writes rather than clearing records. Do not change the connected
account or calendar underneath pending bookings; resolve them first and retain old account
mappings for later cancellation.

**Concurrency limitation:** writes are serialized per calendar across service instances in
one Node process. Run one scheduling writer with the bundled file store. Multiple replicas
need a shared durable receipt store and a distributed calendar lock around service calls.
Google Calendar does not atomically reserve availability: another application/person can
edit the calendar between free/busy and insert. This integration cannot guarantee exclusive
fleet inventory or eliminate that external race.

## Offline verification

Run `npm test -- test/calendar.test.ts` and `npm run typecheck` from `FinalProject`.
All tests inject fake HTTP/token/receipt dependencies and use the existing offline guard.
They never request real OAuth consent or send real calendar invitations.

References: [events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert),
[freeBusy.query](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query),
[OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server).
