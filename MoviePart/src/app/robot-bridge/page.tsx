"use client";

import { useEffect, useRef, useState } from 'react';
import { OperatorBridgeController, type OperatorBridgeState } from '../../robot-bridge/controller';
import styles from './operator.module.css';

export default function RobotBridgePage() {
  const controller = useRef<OperatorBridgeController | null>(null);
  const [state, setState] = useState<OperatorBridgeState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [bridgeId, setBridgeId] = useState('');
  const [bridgeCode, setBridgeCode] = useState('');
  const [operatorCode, setOperatorCode] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [rearClear, setRearClear] = useState(false);
  const [apiPort, setApiPort] = useState(3101);
  const [portDraft, setPortDraft] = useState('3101');
  useEffect(() => {
    const instance = new OperatorBridgeController(setState, apiPort);
    controller.current = instance;
    return () => { controller.current = null; void instance.close(); };
  }, [apiPort]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const nextApiPort = Number(params.get('apiPort') ?? '');
    if (Number.isInteger(nextApiPort) && nextApiPort >= 1024 && nextApiPort <= 65535) {
      setApiPort(nextApiPort);
      setPortDraft(String(nextApiPort));
    }
    const nextSessionId = params.get('sessionId');
    if (nextSessionId && /^[0-9a-f-]{36}$/i.test(nextSessionId)) setSessionId(nextSessionId);
  }, []);
  useEffect(() => { if (!state?.armed) setRearClear(false); }, [state?.armed]);

  const act = (operation: (instance: OperatorBridgeController) => Promise<void>) => {
    const instance = controller.current;
    if (!instance) return;
    setError('');
    setBusy(true);
    // Synchronous invocation preserves the Bluetooth chooser's user gesture.
    void operation(instance).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'The bridge operation failed.'))
      .finally(() => setBusy(false));
  };
  const unavailable = !state?.available;
  return <main className={styles.page}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>MagicPitch / local operator</p><h1>Robot bridge</h1></div>
      <button className={styles.stop} onClick={() => act((instance) => instance.stop())} disabled={!state?.device}>STOP ROBOT</button>
    </header>
    <p className={styles.warning}>Keep this Windows Chrome page visible and stay within Bluetooth range. Local Stop attempts a BLE write without the network broker. Browser or radio failure can prevent stopping; keep the physical stop procedure within reach.</p>
    <p role="status" aria-live="polite" className={styles.status}>{state?.message ?? 'Checking local operator capability...'}</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <div className={styles.grid}>
      <section className={styles.panel}>
        <h2>1. Pair locally</h2>
        <p>No camera, microphone, photos or audio are sent to this bridge.</p>
        <button onClick={() => act((instance) => instance.pairBluetooth())} disabled={unavailable || busy || Boolean(state?.device)}>Choose PadBot Bluetooth device</button>
        <dl>
          <dt>Device</dt><dd>{state?.device?.deviceName ?? 'Not paired'}</dd>
          <dt>Device ID</dt><dd>{state?.device?.deviceId ?? 'None'}</dd>
          <dt>BLE protocol</dt><dd>{state?.device?.protocolMode ?? 'Not connected'}</dd>
        </dl>
        <details>
          <summary>Local API port</summary>
          <p>Only the Windows loopback host is used. This is not a public or arbitrary upstream URL.</p>
          <label>API port<input inputMode="numeric" value={portDraft} onChange={(event) => setPortDraft(event.target.value)} /></label>
          <button disabled={busy || Boolean(state?.bridgeId) || Boolean(state?.device)} onClick={() => {
            const port = Number(portDraft);
            if (!Number.isInteger(port) || port < 1024 || port > 65535) { setError('Use a local API port from 1024 to 65535.'); return; }
            setApiPort(port);
          }}>Use local port</button>
        </details>
      </section>
      <section className={styles.panel}>
        <h2>2. Authorize separate roles</h2>
        <p>Use the two one-time codes from trusted local setup. Never enter the server&apos;s long-lived operator secret here. Codes and scoped tokens are not saved in browser storage.</p>
        <label>Bridge ID<input autoComplete="off" value={bridgeId} onChange={(event) => setBridgeId(event.target.value)} /></label>
        <label>Bridge connection code<input type="password" autoComplete="off" maxLength={8} value={bridgeCode} onChange={(event) => setBridgeCode(event.target.value)} /></label>
        <label>Operator arming code<input type="password" autoComplete="off" maxLength={8} value={operatorCode} onChange={(event) => setOperatorCode(event.target.value)} /></label>
        <button disabled={unavailable || busy || Boolean(state?.bridgeId)} onClick={() => act(async (instance) => {
          try { await instance.redeem(bridgeId.trim(), bridgeCode, operatorCode); }
          finally { setBridgeCode(''); setOperatorCode(''); }
        })}>Redeem one-time codes</button>
        {state?.bridgeId && <button disabled={busy || !operatorCode} onClick={() => act(async (instance) => {
          try { await instance.redeemOperator(operatorCode); } finally { setOperatorCode(''); }
        })}>Redeem replacement operator code</button>}
        <p>Credential expiry: {state?.credentialExpiresAt ? new Date(state.credentialExpiresAt).toLocaleTimeString() : 'Not authorized'}</p>
        <div className={styles.actions}>
          <button disabled={busy || !state?.bridgeId} onClick={() => act((instance) => instance.renew())}>Renew bridge credential</button>
          <button disabled={busy || !state?.bridgeId || state.brokerConnected} onClick={() => act((instance) => instance.reconnect())}>Reconnect disarmed</button>
        </div>
      </section>
      <section className={styles.panel}>
        <h2>3. Bind and arm</h2>
        <label>Customer kiosk session ID<input autoComplete="off" value={sessionId} onChange={(event) => setSessionId(event.target.value)} /></label>
        <label className={styles.check}><input type="checkbox" checked={rearClear} onChange={(event) => setRearClear(event.target.checked)} /><span>I checked that the rear area is clear and I am supervising short, low-speed reverse framing.</span></label>
        <p>Customer motion consent is separate. No forward approach, navigation, obstacle avoidance or mapped safety is provided. Each permit is at most 500 ms; the fixed setup budget is at most 4 pulses / 2000 ms, with a cooldown.</p>
        <button disabled={busy || unavailable || !rearClear || !state?.brokerConnected || !state.device || state.armed} onClick={() => act((instance) => instance.arm(sessionId.trim(), rearClear))}>Arm bounded reverse framing</button>
      </section>
      <section className={styles.panel}>
        <h2>Control status</h2>
        <dl>
          <dt>Broker</dt><dd>{state?.brokerConnected ? 'Connected on loopback' : 'Disconnected'}</dd>
          <dt>Bound kiosk</dt><dd>{state?.boundSession ?? 'None'}</dd>
          <dt>Motion gate</dt><dd>{state?.armed ? 'Armed, awaiting a fresh approved permit' : 'Disarmed'}</dd>
          <dt>Connection generation</dt><dd>{state?.generation ?? 0}</dd>
          <dt>Lease expiry</dt><dd>{state?.lease ? new Date(state.lease.expiresAt).toLocaleTimeString() : 'None'}</dd>
          <dt>Consumed budget</dt><dd>{state?.pulseCount ?? 0} / 4 pulses; {state?.pulseMsUsed ?? 0} / 2000 ms</dd>
          <dt>Last acknowledgement</dt><dd>{state?.lastAcknowledgement?.status.replaceAll('_', ' ') ?? 'No command acknowledgement'}</dd>
          <dt>Stop write</dt><dd>{state?.stopped ? 'BLE write completed; physical motion unverified' : 'Unconfirmed'}</dd>
        </dl>
        <p>This is a physical-motion control, not the kiosk face-animation pause button. Returning to this tab or reconnecting never rearms automatically.</p>
      </section>
    </div>
  </main>;
}
