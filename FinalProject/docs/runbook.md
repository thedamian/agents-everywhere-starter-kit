# MagicPitch local operator runbook

## Scope and readiness

This runbook covers Dwight's local orchestration service and **developer harness**. The baseline is an offline contract demonstration, not a finished customer kiosk or live team demo. Alex/Sam, the uploaded PNG, and the concept product are synthetic. The default movie is a user-provided prerecorded example with audio; the synthetic color-bar MP4 is retained only for tests. Neither mock nor prerecorded media may be described as newly generated personalized advertising.

Real robot voice/capture, Tiya's customer UI and renderer, consented participant assets, tablet networking, and observed browser playback require their own integration acceptance. OpenAI/Exa/media HTTP settings, when available, are opt-in; code/configuration alone is not evidence of an external call passing. Trigger.dev, Ambiguous follow-ups, cloud deployment, and release publishing remain deferred. There is no calendar booking in the baseline.

Startup explicitly rejects unsupported job/follow-up settings. Only `JOB_PROVIDER=local` and `FOLLOWUP_PROVIDER=disabled` are accepted; selecting Trigger or an enabled follow-up provider does not activate a hidden adapter.

## Before starting

1. Work inside `FinalProject`. Preserve `OriginalRepo` and every teammate-owned directory.
2. Check `node --version` is `v24.11.0` and `npm --version` is `11.6.2`. Match the checked-in lockfile; do not delete it to bypass install failures.
3. Run `npm ci`, then `npm run verify`. No model/provider credentials are needed.
4. Ensure `fixtures/media/default-demo.mp4` matches the documented user-provided asset and immutable `src/providers/demo-media.ts` manifest. Startup validates its signature, byte length, checksum, and configured media-size bound. Preserve `mock-preview.mp4` and `sample.png` as the separately documented synthetic fixtures.
5. Keep `.env`, `.runtime`, local session data, and participant media out of source control, artifacts, screenshots, and issue logs.

To make local settings explicit, copy `.env.example` to `.env` with `Copy-Item .env.example .env` in PowerShell. Use `BRIEF_PROVIDER=mock`, `PROFILE_PROVIDER=mock`, `MEDIA_PROVIDER=mock`, `JOB_PROVIDER=local`, `FOLLOWUP_PROVIDER=disabled`, and `MOCK_ONLY=true`. Leave `ALLOW_DEMO_FALLBACKS=false` unless deliberately rehearsing a separately labeled recovery path.

The explicitly selected mock-media mode serves the supplied prerecorded demo without external API calls, even with failed-provider fallbacks disabled. Its `prerendered_fallback` provenance is a media-origin label, not a claim that a provider failed. The reference clip does not execute the six-second synthetic brief or use the current customer's image/preferences.

The runtime privately registers only its validated, immutable local demo provider for prerecorded primary output. This is not a general option to permit prerecorded output from arbitrary or HTTP providers; their existing primary-output guard and explicit recovery rules remain unchanged.

## Launch and pair

1. Run `npm run dev`, or `npm run build` followed by `npm start` for compiled execution.
2. Confirm the startup event reports loopback `127.0.0.1` and the intended port (default `3101`). `GET /healthz` reports process health. `GET /readyz` reports selected modes, not external-provider success.
3. If no `DEMO_DEVICE_TOKEN` was configured, read `.runtime/device-token` locally. Startup logs only the pairing-file path, never the generated token. A startup-generated pairing token changes after a restart. File-mode restrictions alone are not a guarantee of Windows ACL privacy; keep the worktree under the operator's account and never share this file.
4. Open `http://127.0.0.1:3101/dev`. Paste the token into the password field. It is used once for session creation and not persisted by the harness.
5. Select Alex or Sam, confirm only synthetic preferences, and explicitly check both consent boxes. The harness records personalization/capture consent, with enrichment consent false.
6. Run the sequence. The service identifies the synthetic roster entry, accepts the synthetic PNG, records context, creates a deterministic brief, and queues mock media.
7. Press Play. Confirm the **PRERECORDED DEMO** label and the supplied ten-second movie with its original audio (container/audio tail: 10.026667 seconds). Do not label it as freshly generated for this customer. Only the browser's playback-ended event acknowledges the reveal. An API/CI acknowledgement is not audiovisual evidence.
8. Revoke the session. Its capability and assets stop working; the harness removes its Blob URL and credentials.

The default session lifetime is 30 minutes, with a 15-minute media-job safety timeout. These are operational bounds, not the advisory two-minute video-production target. Pair when ready to run. If a session expires, pair again rather than replaying it. The state, revision, provenance, and sanitized transition log are visible in the harness. The harness refuses non-mock provider modes to avoid accidental paid calls.

Coordinate timing across all launched processes. Set `SESSION_TTL_MS` long enough for conversation, generation, permission and playback; the source defaults are `1800000` and `JOB_TIMEOUT_MS=900000`. MoviePart's dedicated service defaults to `MEDIA_SERVICE_JOB_TIMEOUT_MS=600000`, configurable up to 30 minutes. A combined launcher may inject different values: review its overrides when integrating. This checkout does not contain `scripts/kiosk-config.mjs`; do not assume changes to `config.ts` update another checkout's launcher or an already-running process. Short explicitly injected deadlines in tests remain intentional.

## Pairing and access boundaries

- A device token creates sessions; a different, scoped session token authorizes that session's reads, commands, uploads, and media.
- No credentials belong in query strings. HTML video elements cannot add bearer headers: clients fetch authorized media bytes, create a Blob URL, and revoke it after use.
- Browser mutation requests must use a trusted exact origin. Configure `ALLOWED_ORIGINS` for the actual origin; never use wildcard CORS as a workaround.
- Node/device clients may omit `Origin`, but still require bearer authorization. CORS is not authentication.
- Refreshing the page discards the in-memory session credential and preview. It does not synchronously delete server assets; sessions expire, or an authorized client can explicitly revoke them.
- Restarting creates a new server instance and loses all in-memory sessions/jobs. Interrupted work is not durably resumed and must not be silently submitted again.

## Recovery

| Symptom | Safe action |
| --- | --- |
| Install/version mismatch | Use the exact Node/npm pair and run `npm ci`. Preserve the lockfile and working tree; do not run unpinned repair installs. |
| Compile or test failure | Run the reported command locally. Inspect the smallest relevant change. Do not claim readiness or reset unrelated work. |
| Port already in use | Stop the known API process with Ctrl+C in its terminal, or use an unused configured port. Do not terminate processes by name. Smoke uses port zero to avoid conflicts. |
| Pairing fails / `401` | Re-read the local token after restart; create a new session. Device credentials do not authorize session routes. |
| Origin/host rejected | Match the exact configured host and origin. Do not remove auth or allow arbitrary origins. |
| Consent denied | Check that permission was recorded for this session before identification/upload; do not bypass it or infer consent from detection. |
| Job or request timeout | Refresh status first. Preserve the original idempotency key when reconciling submission. Do not blindly retry a potentially paid render. |
| Job failed / cancelled / expired | Display the actual terminal state. For the synthetic harness, revoke and start a new session; do not relabel failure as generated success. |
| Ready but video does not play | Check authorized MIME/bytes/range behavior and browser decode support. Do not send a reveal acknowledgement until real playback occurs. |
| Demo media missing / invalid / exceeds `MAX_MEDIA_BYTES` | Restore the documented `default-demo.mp4` and verify its checksum; ensure `MAX_MEDIA_BYTES` permits 4,273,110 bytes. Do not substitute an unrelated file or alter the manifest to bypass validation. Preserve synthetic test fixtures separately. |
| Server restarted | New server instance means old capabilities are invalid. Re-pair and deliberately restart the flow; no automatic job replay. |
| Optional provider unavailable | Return to the explicit offline profile for rehearsal. Any deliberately selected prerecorded fallback must remain visibly labeled. |
| `media_cleanup_pending` / cleanup receipt exists | Inspect `.runtime\media-cleanup` metadata locally. With the configured service credential, reconcile `DELETE {MEDIA_SERVICE_URL}/jobs/by-key/{jobId}` until the renderer confirms cancellation and asset deletion. Keep unresolved receipts; do not submit another render or claim remote deletion. |
| External call appears in offline checks | Treat `OUTBOUND_NETWORK_DENIED` as a failure. Fix provider selection or the test; do not remove the guard to make checks green. |
| Harness loses network | Use Refresh after connection recovers. Revoke/re-pair if state cannot be reconciled; the harness never automatically repeats a media submission. |
| Need a stable local build | Use a previously verified allowlisted archive and exact runtime. Do not present this as proof that current CI or live integration passed. |

Stop a foreground server with Ctrl+C. The smoke runner owns one child Node process, applies deadline/request timeouts, and signals only that process in `finally`; Windows uses Node's child-PID termination semantics. It never kills all Node processes.

## Offline checks and their limits

`npm run verify` runs typechecking, recursive Node/tsx tests, compilation, and compiled-process HTTP smoke. The smoke checks no-auth denial, untrusted origins, consent before capture, actual PNG upload, synthetic selection/context/brief, job idempotency, ready provenance, exact MP4/checksum, a byte range, simulated reveal, revocation, and child cleanup.

Smoke removes inherited provider credentials and explicitly selects mocks. The test runner and spawned smoke API preload `scripts/offline-network-guard.mjs`, which rejects nonnumeric-loopback fetch/HTTP(S) destinations and prevents automatic fetch redirects. It is an application regression guard, not an OS network isolation guarantee; native addons, direct socket APIs, or malicious test code are out of scope.

No FFmpeg installation is required to run these checks: the supplied MP4 is already present, with size/hash/duration pinned in the shared manifest, and the small synthetic fixtures remain available for isolated tests. Smoke verifies the actual default runtime returns unchanged bytes, ten-second duration, and prerecorded provenance. CI does not decode frames, inspect visual quality, operate robot hardware, or observe a browser. An actual manual audiovisual playback rehearsal is a separate gate.

## Package and restore

1. From the source checkout run `npm run verify`, then `npm run package:demo`.
2. Review `artifacts/magicpitch-demo.sha256` and inspect `tar -tzf artifacts\magicpitch-demo.tgz`. The script compares archive contents with its explicit file allowlist.
3. Extract to a new directory outside the checkout, then run `npm ci --omit=dev`, `npm run smoke`, and `npm start` there. No `packages` sibling from a source checkout is required.
4. Keep only a known-good, verified archive for recovery. Use the archive's package/lock pair together. Registry dependencies are restored, not copied across OSes; the canonical local showroom runtime is included under `vendor/showroom-runtime`.

The package includes compiled JavaScript/contracts and the immutable demo manifest, package/lock files, runtime pins, `.env.example`, the developer harness, the specifically allowlisted user-provided `default-demo.mp4`, the two synthetic fixtures and provenance README, contract/runbook documentation, and smoke/guard scripts. It never includes `.env`, `.runtime`, other customer media, broad fixture directories, provider logs, caches, `node_modules`, or source tests. Packaging validates the default asset against the manifest and removes only its own known `artifacts/demo-package` staging directory.

The allowlist also includes all `@magicpitch/showroom-runtime` browser/server JavaScript and declarations plus its package metadata and README, but not its tests. The packager rewrites only the shipped manifest/lockfile link from `file:../packages/showroom-runtime` to `file:vendor/showroom-runtime`; the source checkout manifests and all registry versions/integrities remain unchanged. Missing exports or unvendored local lockfile links fail packaging rather than producing a nonportable archive.

Run `npm exec --call "node --test integration-tests/package.test.mjs"` with the pinned npm after building to check canonical vendored bytes, production-only installation into an owned OS-temporary directory outside the repo, isolated dependency resolution, and offline imports/startup/health/smoke with voice, calendar and motion disabled. Running through npm supplies its active CLI path (important when a global npm upgrade differs from the version bundled with Node). The test cleans up its extraction and owned server process. npm installation can contact its registry; no provider calls or hardware actions are part of the check.

GitHub Actions uses read-only permissions, no provider secrets, and Windows/Linux jobs. A successful Linux job uploads only the allowlisted archive/checksum with seven-day retention. No deployment, calendar action, or remote service mutation is performed. Observe a real workflow run before asserting that GitHub CI is green.

## Before any LAN or live-team rehearsal

- Damian supplies the versioned robot/voice/capture contract and controls physical safety. Dwight's harness does not move a robot or access a camera.
- Tiya supplies the real media submission/status contract, UI, licensed product/template assets, MP4, and reveal acknowledgement.
- Record actual participant permissions; obtain separate enrichment permission before any profile lookup. Unknown-person identification and unsolicited scraping are out of scope.
- Bind beyond loopback only deliberately, with a strong device token, explicit trusted hosts/origins, restricted firewall/network access, and working client authorization.
- Tablet/browser camera or microphone usually requires trusted HTTPS. Do not weaken browser security or publish tokens to bypass this.
- Observe a consenting live session through actual playback, disconnection recovery, cancellation, and cleanup. Measure latency; roughly two minutes is an advisory target, not a claim established by mock timing.
- Document any external provider's retention/deletion limitations. Local revocation cannot prove removal of external copies.
- The HTTP renderer must advertise cancellation/deletion capabilities and implement the idempotent cancellation-by-job-key endpoint described in `docs/contracts.md`. The adapter attempts cleanup even after an abort and retains failed-cleanup receipts across restarts.
- Public/cloud hosting requires real auth and durable private sessions/assets/jobs; the in-memory local queue is not horizontally scalable.
