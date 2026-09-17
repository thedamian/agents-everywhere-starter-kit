# Local Windows operator bridge

This module does not read environment variables or start servers on import.
The main application owns opt-in configuration and registration:

```ts
const broker = new BridgeBroker({
  sessionSafety: async (sessionId) => ({
    active: await isActive(sessionId),
    motionConsent: await hasCurrentMotionConsent(sessionId),
  }),
  onError: (code) => logSafeCode(code),
});
app.route("/", createBridgeRouter({
  broker,
  operatorToken: config.SHOWROOM_OPERATOR_TOKEN,
  allowedOrigins: config.SHOWROOM_BRIDGE_ORIGINS,
  authorizeSession: (id, token) => orchestrator.authorize(id, token),
  onError: (code) => logSafeCode(code),
}));
const bridgeControl = attachBridgeWebSocket(httpServer, {
  broker,
  allowedOrigins: config.SHOWROOM_BRIDGE_ORIGINS,
  onError: (code) => logSafeCode(code),
});
// On shutdown: bridgeControl.close().
```

Construct only when `SHOWROOM_BRIDGE_ENABLED=true`. Install `ws` and `@types/ws`
in FinalProject. Register the router before wildcard session routes; include the
exact local operator origins in the outer application's origin policy as well.
Bridge middleware is scoped to its bridge/operator namespaces and session bridge
endpoints; mounting at `/` must not intercept public kiosk pairing, health, OAuth,
or unrelated application routes.
Recommended local operator origin: `http://127.0.0.1:3202`. Origins must be
loopback HTTP(S) origins, not public/tunnel origins. The iPad uses the existing
HTTPS gateway and showroom actions, not this WebSocket and never Web Bluetooth.

The local operator page is MoviePart `/robot-bridge`, default API port 3101. The
page can choose a different **loopback port**, never an arbitrary API URL.
BLE pairing is explicitly initiated from a button. Keep the page foreground,
within radio range and physically supervised. No audio or photo fields exist in
the bridge contracts. The legacy RobotPart `robot.js` automatic scan thresholds
are not imported by the operator page or the showroom bridge.

## Role-separated setup

Use a long random operator token in local server/CLI setup only. Never place it
in public environment variables, page source, browser storage, or a URL. Issue
codes with an authenticated local CLI request **without an Origin header**:

1. `POST /v1/operator/bridges` with `{label,platform:"windows-chrome"}` returns
   `{bridgeId,pairingCode,expiresAt}`.
2. `POST /v1/operator/bridges/{bridgeId}/operator-pairing` returns
   `{bridgeId,operatorCode,expiresAt}`.
3. Enter the bridge ID and these separate codes in the local page. It redeems
   them via `POST /v1/bridges/{bridgeId}/pair` and `/operator-pair`. Both require
   the exact operator origin. Codes expire after 60 seconds, consume once, and
   lock after five failed attempts.

Both resulting credentials are bridge-scoped, memory-only and expire after
five minutes. The bridge role connects/heartbeats/acknowledges; it cannot create
a lease. The operator role has `purpose:"bridge:lease"` and may arm/stop only
its bound bridge, not issue new setup codes. Explicit bridge credential renewal
(`POST /v1/bridges/{bridgeId}/renew`) disarms and closes its old connection;
reconnect is a separate user action. Expired credentials need new local setup.
A replacement operator code can be redeemed without copying a long-lived secret
to the browser.

## Control and acknowledgements

- `POST /v1/operator/bridges/{id}/lease` consumes the canonical
  `BridgeLeaseInput`. Only one bridge, active connection and controller lease
  exist. The operator explicitly selects the kiosk session, confirms rear
  clearance and arms locally. Customer consent is separate.
- `WS /v1/bridges/{id}/connect` is local-only. The first and only authentication
  message is `{type:"authenticate",bridgeToken}`. Query credentials, foreign or
  absent origins, binary messages, oversized messages and repeat authentication
  are rejected. No command replay occurs on reconnect.
- WebSocket heartbeat/acknowledgement frames use the canonical contracts.
  Authenticated HTTP `/heartbeats` and `/acknowledgements` are also available;
  commands are delivered through the live WebSocket only, never replay-polled.
- `GET /v1/bridges/{id}/status` returns safe state to its bridge credential.
  `GET /v1/sessions/{id}/bridge` returns the current session-scoped status,
  public lease identifiers and latest acknowledgement using its session
  credential. These identifiers are not authorization tokens.
- `POST /v1/operator/bridges/{id}/stop` and
  `POST /v1/sessions/{id}/bridge/stop` request a server Stop. A returned command
  means **requested**, not stopped. A later `stop_written` acknowledgement
  means only BLE write completion. `physicalExecution` is always `unverified`.
  Stop is accepted independently of revision, expired motion permits or queue
  ordering after authenticating the requester.

After authoritative showroom approval, call
`broker.authorizeMotion(sessionId, motionIntent)` with **fresh local tracking**.
The stable approval/grant belongs to the showroom orchestrator; the bridge never
treats a model utterance, transcript delta or old readback frame as consent.
Call `broker.stopSession(sessionId, reason)` on end/revocation/playback/Stop and
revoke the showroom's motion grant at the same time. `sessionSafety` must also
check that authority on each call; its failure must not be converted to consent.

Each execution is positive-only: low-speed reverse for half-body, at most
500 ms, at least 1000 ms cooldown, at most four pulses and 2000 ms cumulative
for the registered encounter. Tracking must describe one person, confidence at
least 0.8, and be less than 1000 ms old. No model or lease can increase/reset
these caps. Leases last at most 30 seconds, command lifetimes at most two
seconds; local timing starts before BLE writes. The operator's page separately
checks all bounds and stops/disarms on hidden/offline, BLE/control/heartbeat
loss, lease expiry, bad sequence/generation or rejected permits.

Local Stop bypasses the network but cannot preempt a hung browser/radio or an
already in-flight BLE write. Keep the physical stop procedure within reach.
BLE stop success is **not** obstacle detection, verified braking, or physical
execution feedback.

## Offline verification

Run from FinalProject:

```text
npm run typecheck
node --import tsx --test src/bridge/bridge.test.ts src/bridge/router.test.ts src/bridge/websocket.test.ts
```

Tests use fake BLE/timers and a real loopback-only WebSocket server; they never
call a Bluetooth chooser, move hardware, upload photos/audio, or contact paid
providers.
