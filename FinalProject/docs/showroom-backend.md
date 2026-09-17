# Guided showroom backend

The guided workflow shares the existing session capability, expiry and authorized asset endpoint. Legacy `v1` brief/media callers retain their original API. Once a session opens its showroom snapshot, mutations must use the showroom actions; it cannot select a synthetic roster identity or mix legacy single-image replacement with a studio reference set.

`SHOWROOM_MODE=disabled` is the standalone backend default. `fixture` runs the same consent, input, approval and playback state machine but returns the checksum-registered `default-demo.mp4` as `mock_fixture`. It does not generate likeness footage, call a studio provider or send photos externally. Catalog `mode: fixture` means selection capabilities are simulated, not proof of live provider access. `studio` uses the full MoviePart web API and its separate worker with server-only `MOVIE_API_TOKEN` and loopback `MOVIE_STUDIO_URL`; it never downgrades to the fixture or an image-only provider.

## Authorization and lifecycle

Issue a two-minute, one-use pairing code through `POST /v1/operator/kiosk-pairings`, authenticated with `SHOWROOM_OPERATOR_TOKEN`. The kiosk exchanges `{pairingCode}` at `POST /v1/kiosk/pair` for the existing session capability. Do not proxy operator, OAuth or bridge-control setup routes to the public kiosk.

Session-scoped endpoints:

| Route suffix under `/v1/sessions/{id}` | Request |
|---|---|
| `GET /showroom` | Authoritative snapshot |
| `GET /showroom/catalog` | Mode-labeled catalog and configured production readiness |
| `POST /showroom/actions` | Canonical action with `eventId` and `expectedRevision` |
| `POST /showroom/references?expectedRevision=N&eventId=UUID` | Raw JPEG, PNG or WebP; returns `{assetId,snapshot}` |
| `DELETE /showroom/references/{assetId}?expectedRevision=N&eventId=UUID` | Owned retake/removal; returns snapshot |
| `POST /showroom/voice` | `{sdp,generation?}`; returns sanitized Live WebRTC SDP answer |
| `DELETE /showroom/voice` | `{generation}`; invalidates only that backend voice generation, returns 204 |
| `GET /assets/{assetId}` | Existing authorized media download and byte ranges |
| `DELETE` | Existing session end, revocation and local-asset cleanup |

Every approval must match the latest pending action ID, immutable payload fingerprint, input revision, snapshot revision and expiry. A tool proposes an answer first; only an explicit spoken/touch response to its displayed readback can confirm it. Uploads are decoded, orientation-normalized and stripped of metadata, bounded to 5 MiB each, 20 MiB total, four originals and 25 megapixels each. Duplicate images and cross-session IDs are rejected. Uploaded photos do not silently replace another original. Accepted movie inputs never mutate after submission.

Studio transfer receipts are flushed to `.runtime/studio-cleanup` before any participant data is sent. Stable batch and job keys reconcile uncertain/lost responses; no replacement paid request is submitted blindly. Startup retries outstanding cleanup and fails closed if cleanup cannot settle. Actual studio stages, production mode and generated provenance are preserved. The completed MP4 must decode as the promised 24-fps, 1280x720 H.264 timeline. It is not published ready until the studio acknowledges deletion of all locally owned job/batch copies after worker settlement. Provider-retention systems and already accepted remote billing operations are outside that local deletion acknowledgement.

Pending receipts include a one-way fingerprint binding the original studio origin, session scope and private machine credential. A changed token or origin must not turn another principal's empty tombstone into a successful cleanup acknowledgement. Recovery rejects mismatched or older unbound pending receipts before making any request; restore the original configuration, or explicitly reconcile an older receipt through its original owner. Already-cleaned legacy receipts need no remote request. Credentials themselves are never written into receipts. The offline `integration-tests/studio-owner.test.mjs` regression exercises this boundary against the real MoviePart API and private stores.

## Live voice, motion and calendar

`VOICE_ENABLED=true` requires `OPENAI_API_KEY` and an enabled showroom, but works independently with `SHOWROOM_MODE=fixture`. The original RobotPart Live request is shared from `@magicpitch/showroom-runtime/server`: voice defaults to `gpt-live-1`, delegated reasoning to `REGULAR_MODEL` (or matching compatibility alias `REASONING_MODEL`), default `gpt-5.6-luna`. No synthetic voice preset, audio setting or ephemeral client-secret flow is introduced. The browser receives only the SDP answer and opaque provider session ID. Setup is valid before photography consent so the guide can ask for it. The browser owns and closes the actual WebRTC connection; backend termination aborts pending setup and fences stale generations.

Voice tools are `showroom_state`, `showroom_catalog`, `showroom_action` and local `showroom_playback`. Capture/tracking/playback evidence must come from the device, never model text. `playback_started` corresponds to real browser playback and emits legacy `media_revealed`; only `playback_ended` starts follow-up.

Motion remains explicitly opt-in (`SHOWROOM_BRIDGE_ENABLED`, private operator token, exact loopback `SHOWROOM_BRIDGE_ORIGINS`). Approval grants a stable framing intent, not an old camera measurement. Each pulse requires new tracking under the current grant and bridge lease; four pulses/2000 ms cumulative, cooldown and lease generation remain bounded across grants. Stop, input changes, playback and session end revoke the grant. The bridge verifies its separate local safety conditions; acknowledgements never claim verified physical execution.

Google Calendar is disabled unless separately configured through the calendar module. Showroom integration additionally requires a 60-minute duration, a nonempty location and at most 19 staff invitees. Operator setup is `POST /v1/operator/calendar/authorize`, followed by the configured Google callback using a short-lived HttpOnly browser binding. OAuth tokens and booking receipts live in private `.runtime` subdirectories. A calendar draft reads back the exact start/end, timezone, product, location and all recipients before a stable confirmation ID is submitted. Calendar `sent` means invitation updates were requested through Google, not proof of inbox delivery or inventory reservation.

Photo withdrawal/session end does **not** cancel a confirmed appointment. A separately authenticated operator must explicitly call `POST /v1/operator/calendar/appointments/{confirmationId}/cancel` with `{confirmed:true}`; the provider verifies app ownership and reconciles uncertain results before retrying.

While the showroom session remains active, retrying the **identical** calendar-confirmation event after an `uncertain` result reconciles its original confirmation ID and immutable draft. It cannot create a replacement confirmation or alter the recipients/time. A successful receipt is replayed without calling the provider again. Ended sessions cannot use that replay to authorize more work. Stop and consent withdrawal execute immediately outside ordinary workflow queues, even when their snapshot revision is stale; other mutations retain strict optimistic concurrency.

If Google has confirmed a creation or cancellation but its final local receipt cannot be saved, the result remains uncertain and the existing pending/cancelling receipt is retained. Restore receipt storage and reconcile that same confirmation; a local persistence failure never authorizes a replacement invitation. Storage failures before sending an insert or cancellation remain definite failures without claiming a remote mutation occurred.
