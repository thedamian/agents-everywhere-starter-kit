# Showroom tablet and operator deployment

A Windows showroom tablet can run `/kiosk` and, when physical movement is
needed, the separate local `/robot-bridge` operator page for Web Bluetooth.
`/api/showroom` requests go to MoviePart, which forwards only the fixed routes
below to FinalProject on loopback. The tablet never receives a provider or
operator master key; Bluetooth remains isolated behind the operator bridge page
and its separate one-time role codes.

This deployment layer does not itself implement the showroom lifecycle. Use
the completed showroom backend/UI/runtime together. An unavailable backend,
worker, vehicle reference pack, OAuth connection or camera remains unavailable;
the gateway does not simulate success.

## Local processes and independent opt-ins

From the repository root, install each component's dependencies and build
FinalProject before launching. The full studio uses **the studio worker**, not
the separate legacy media service.

```powershell
npm --prefix FinalProject ci
npm --prefix FinalProject run build
npm --prefix MoviePart ci
# When using the shared face/pose runtime, prepare its local assets explicitly:
npm --prefix MoviePart run assets:showroom

# Offline film, no paid voice, no invitations, no physical bridge:
npm --prefix FinalProject run dev:kiosk -- --ui-port 3202

# Independent live voice with an explicitly labelled fixture film:
npm --prefix FinalProject run dev:kiosk -- --ui-port 3202 --live-voice

# Full studio + live voice, but still no calendar or physical bridge:
npm --prefix FinalProject run dev:kiosk -- --ui-port 3202 --live-studio --live-voice --public-origin https://kiosk.example.com
```

UI defaults to port **3200**, API to **3101**, and legacy media to **3201**.
`--ui-port 3202`, `--api-port`, and `--media-port` are validated independent
overrides. Occupied ports cause a failure; the launcher never stops someone
else's process. All services bind to `127.0.0.1`.
Next's cold compilation has a bounded five-minute startup allowance, adjustable
with `--startup-timeout-ms` from 30000 to 600000. This is only a startup deadline,
not a longer API/provider request timeout or a substitute for readiness.

| Flag | Effect | Does not enable |
|---|---|---|
| No live flags | `SHOWROOM_MODE=fixture`, explicit `mock_fixture` film | Paid providers, calendar, BLE |
| `--live-voice` | FinalProject's existing OpenAI Live WebRTC SDP exchange | Film generation, calendar, movement |
| `--live-studio` | Full MoviePart studio web + `scripts/worker.ts` | Calendar or movement |
| `--google-calendar` | Google calendar adapter, after private OAuth setup | Voice, film generation, automatic invitations |
| `--windows-bridge` | Local Windows operator bridge availability | Automatic pairing, enabling motors, automatic motion |
| `--live-media` | Legacy dedicated media service and `MEDIA_PROVIDER=http` | Full creator studio; cannot combine with `--live-studio` |

The studio readiness check requires configured OpenAI models, Google Veo,
FFmpeg, a ready authorized vehicle reference pack, and a worker heartbeat.
The API readiness check also requires its reported showroom mode, voice,
calendar and bridge flags to match the selected launcher options.
Provider readiness means configured, not that model access, quota or a paid
generation has been exercised. Two minutes is a soft film target, not a timeout
that converts unfinished work into success.

The launcher reports the configured public URL but **does not create a tunnel,
open firewall ports, install certificates, or verify tablet trust**. It starts
no capture, provider generation, OAuth consent, invitation or Bluetooth pairing.

## Secrets and process boundaries

Edit private environment files locally; never paste their values into chat or
source control. Copy examples only for a new installation, never over an
existing `.env`. Launcher mode selection uses flags, not key presence.

| Process | Permitted private credentials |
|---|---|
| FinalProject | Voice OpenAI key only with `--live-voice`; Google OAuth credentials only with `--google-calendar`; generated operator bootstrap key; studio machine token only with `--live-studio` |
| MoviePart web + studio worker | MoviePart OpenAI/Google video keys and persistent private `MOVIE_API_TOKEN`, only with `--live-studio` |
| Legacy media service | MoviePart OpenAI image key and generated media-service token, only with `--live-media` |
| Windows tablet kiosk browser | One authoritative session capability held in memory after one-time code exchange |
| Windows tablet bridge browser | Redeemed short-lived operator/bridge role credentials held in memory, not the bootstrap key; Web Bluetooth is available only on the local operator page |

Inherited environment variables are allowlisted to operating-system essentials.
Arbitrary `NEXT_PUBLIC_*`, provider settings, proxy credentials and unrelated
tokens are not propagated. Next's environment-file loader is explicitly marked
processed so it cannot reload private MoviePart `.env` values behind the
offline launcher's startup credential isolation. **Stop the owned stack before
editing environment files**: Next's development-mode file watcher can force a
dotenv reload after edits. Worker/media child commands do not load `.env`
themselves.

The launcher writes `.runtime/showroom-operator-token` for local operator
bootstrap and retains `.runtime/device-token` for the legacy developer harness.
Neither file is a showroom pairing code. Restrict `.runtime` and private provider
state to the operator's Windows account using NTFS ACLs; POSIX `0600` is not an
NTFS security boundary.

Studio mode atomically creates or reads `.runtime/studio-api-token`. **Keep this
identity across normal restarts:** MoviePart's durable job/photo owner depends
on it, so rotating it would strand cleanup under another owner. Explicit
`MOVIE_API_TOKEN` values in FinalProject/MoviePart must agree with each other and
with the stored identity; disagreement, a corrupt file, or a non-file entry
fails closed rather than replacing it. The file is private and is never logged.
Complete verified cleanup under the existing identity before deliberate
rotation, and retain the same private studio origin while cleanup is pending.
Receipt ownership binds the credential, origin and session scope before any
recovery request. Do not delete credentials or pending cleanup receipts merely to
silence a startup error; legacy unbound receipts require explicit recovery.

Voice preserves `VOICE_MODEL` (default `gpt-live-1`) and the regular/reasoning
model (default `gpt-5.6-luna`), rather than replacing speech with browser TTS.
Only with `--live-voice`, the launcher may reuse `OPENAI_API_KEY`, `VOICE_MODEL`
and `REGULAR_MODEL` from RobotPart's private `.env`; explicit nonempty
FinalProject values take precedence. No RobotPart key is copied to a file,
logged or forwarded to MoviePart. MoviePart's film key is never a voice fallback.
Calendar uses 60-minute slots and `CALENDAR_PROVIDER=disabled` by default.
Google client ID/secret are required for its opt-in; a refresh token may be
configured or obtained by local operator OAuth setup. No credential or
disconnected account is silently converted into a successful booking. Confirm
recipient and time before an invitation. Keep OAuth callback routes local and
out of access logs.

## Windows tablet deployment

For the intended Windows tablet, prefer loopback: open
`http://127.0.0.1:<ui-port>/kiosk` for the showroom face and
`http://127.0.0.1:<ui-port>/robot-bridge?apiPort=<api-port>` for Bluetooth
setup. Chrome and Edge treat loopback as a secure context for Web Bluetooth.
Public, LAN and tunnel origins are intentionally rejected by the bridge
controller.

If the customer display is on a separate device, choose either a domain with a
publicly trusted certificate or a managed private CA installed and explicitly
trusted on that tablet. Do not bypass TLS errors.

### LAN reverse proxy

Use a hostname the customer tablet resolves to the operator machine. Install a valid
certificate for that hostname on a TLS reverse proxy such as Caddy. For a
private CA, distribute only the CA certificate, never its private key, and trust
it using the organization's device policy.

Example Caddy routing policy for port 3202:

```caddyfile
kiosk.example.com {
    # Use a certificate issued for this hostname; automatic HTTPS requires
    # a suitable domain/challenge setup. This file does not configure DNS.
    @customer {
        path /kiosk /kiosk/* /api/showroom/* /_next/* /showroom-models/face_landmarker.task /showroom-models/pose_landmarker_lite.task
    }
    @wasm path_regexp wasm ^/showroom-models/wasm/[A-Za-z0-9_.-]+\.(wasm|js)$
    handle @customer {
        reverse_proxy 127.0.0.1:3202
    }
    handle @wasm {
        reverse_proxy 127.0.0.1:3202
    }
    handle {
        respond "Not available on this origin" 404
    }
}
```

For production, build/start Next rather than using its development server.
Allow inbound HTTPS to the proxy only. Do **not** expose 3101, 3200/3202, 3201,
the worker, `/api/movie-*`, `/robot-bridge`, `/v1/operator/*`, OAuth setup, or
bridge WebSocket routes through the public proxy. The example does not enable
request logging; if adding logs, omit credentials, bodies and OAuth queries.

### Managed HTTPS tunnel

A tunnel with a publicly trusted hostname can replace inbound LAN HTTPS.
Configure its ingress to the **restricted reverse proxy**, not directly to
FinalProject or the entire MoviePart server. A bare tunnel to port 3202 would
also publish creator-studio and operator surfaces. Use the exact tunnel HTTPS
origin in `--public-origin`. A changing hostname requires updating this exact
origin and restarting the owned stack. Do not use wildcard CORS as a shortcut.
No tunnel is started by the launcher.

From the tablet, verify the expected hostname/certificate when using a remote
display, load `/kiosk`, then confirm camera and microphone permission prompts.
Camera/voice are separate permissions from consent to upload photos. Confirm that `/robot-bridge`,
`/api/movie-config` and `/api/showroom/v1/operator/kiosk-pairings` are denied on
the public origin before a customer encounter.

## Pairing and exact HTTP allowlist

The operator calls **local** `POST /v1/operator/kiosk-pairings` using the private
operator bootstrap credential, then shares only its short-lived one-time code.
The kiosk exchanges `{ "pairingCode": "ABCD1234" }` at
`POST /api/showroom/v1/kiosk/pair`. FinalProject consumes the code and returns
the single authoritative session ID/capability. Refreshing the browser forgets
that in-memory credential. Do not store it in a query, cookie, localStorage,
manifest, service worker or public environment variable.

Every path below is relative to `/api/showroom`:

| Method | Fixed upstream path | Query/body |
|---|---|---|
| POST | `/v1/kiosk/pair` | JSON one-time pairing code; no upstream Authorization |
| GET | `/v1/sessions/{id}/showroom` | None |
| GET | `/v1/sessions/{id}/showroom/catalog` | None |
| POST | `/v1/sessions/{id}/showroom/actions` | JSON revision-checked discriminated action |
| POST, DELETE | `/v1/sessions/{id}/showroom/voice` | POST uses real `{sdp,generation?}` JSON; DELETE uses `{generation}` JSON |
| POST | `/v1/sessions/{id}/showroom/references` | Raw PNG/JPEG; `expectedRevision=N&eventId=UUID` required |
| DELETE | `/v1/sessions/{id}/showroom/references/{assetId}` | Same two required query fields |
| POST | `/v1/sessions/{id}/assets` | Legacy raw PNG/JPEG only, not showroom multi-photo capture |
| GET, HEAD | `/v1/sessions/{id}/assets/{assetId}` | Optional single `Range: bytes=...` |
| DELETE | `/v1/sessions/{id}` | End/revoke the session |

No other path/method/query is forwarded. In particular session creation with a
device master key, arbitrary command endpoints, admin/operator routes, bridge
control, token queries, encoded separators, encoded/double-decoded path
segments and duplicate query keys are denied.

`SHOWROOM_API_UPSTREAM` is a private fixed origin, default
`http://127.0.0.1:3101`; plain HTTP is accepted only for loopback. It cannot have
credentials, a path, query or fragment. `SHOWROOM_PUBLIC_ORIGIN` is the exact
customer origin. Browser mutations require that exact Origin; cross-site
requests are denied. Only Authorization, required Content-Type, exact Origin
and an allowed Range are forwarded; cookies, Host and untrusted forwarded
headers are not.

The gateway bounds pairing JSON to 256 bytes, ordinary request JSON to 16 KiB,
and voice request/response JSON to 1 MiB to accommodate the canonical 128 KiB
UTF-8 SDP plus JSON escaping/envelope. Images are limited to 5 MiB, ordinary
JSON responses to 512 KiB, media responses to 128 MiB, and request/response
duration to 30 seconds. It limits actual streamed bytes, not just declared
Content-Length. Images and MP4 are not parsed/re-encoded. Ranges, content type
and status are retained. Redirects are never followed; network errors and
upstream error bodies are sanitized. Private responses are `no-store`. A body
failure after response headers interrupts the stream; it cannot retroactively
change its HTTP status and must not be interpreted as successful playback.
Only an exact upstream HTTP 409 `REVISION_CONFLICT` code is preserved, using
bounded error parsing and an authored safe message. Other conflicts and
unreadable errors remain unclassified failures, not proof that retrying with a
new event ID is safe.

## Local Windows Chrome bridge

Use `/robot-bridge` on the **loopback** UI, not a public or tunneled hostname.
The integrated launcher prints `/robot-bridge?apiPort=<api-port>` when
`--windows-bridge` is enabled, and `/kiosk` opens the same URL from its operator
drawer when the bundle knows that local API port.
The bridge client connects only to a validated loopback API port and fixed
`ws://127.0.0.1:{port}/v1/bridges/{bridgeId}/connect`. Backend checks the exact
local origin and a redeemed role credential in the first frame, never in the
URL. The HTTP gateway does not support or expose WebSocket upgrades.

The operator separately redeems a one-time role code, clicks to pair PadBot in
Windows Chrome, and explicitly enables physical movement. No launcher flag
autopairs Bluetooth or starts motors. Stop, watchdog expiry, disconnect and
revocation must disable movement. Validate physical behavior with an operator
present before using hardware around visitors; software tests cannot certify
physical robot safety.

## Focused offline checks

These checks use fake requests/provider configuration, not real API accounts:

```powershell
npm --prefix FinalProject test -- test\kiosk-config.test.ts
Set-Location MoviePart
node --import tsx --test tests\showroom-gateway.test.ts tests\launcher-isolation.test.ts
node node_modules\typescript\bin\tsc -p tsconfig.showroom-gateway.json
```
