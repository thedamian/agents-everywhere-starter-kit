import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { isLocalWindowsOperator, OperatorBridgeController, type OperatorBridgeState } from './controller';

test('operator capability is loopback Windows Chrome only', () => {
  const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/132.0.0.0 Safari/537.36';
  assert.equal(isLocalWindowsOperator({ hostname: '127.0.0.1', protocol: 'http:' }, windows), true);
  assert.equal(isLocalWindowsOperator({ hostname: 'localhost', protocol: 'https:' }, windows), true);
  assert.equal(isLocalWindowsOperator({ hostname: 'kiosk.example', protocol: 'https:' }, windows), false);
  assert.equal(isLocalWindowsOperator({ hostname: '192.168.1.10', protocol: 'https:' }, windows), false);
  assert.equal(isLocalWindowsOperator({ hostname: '127.0.0.1', protocol: 'file:' }, windows), false);
  assert.equal(isLocalWindowsOperator({ hostname: '127.0.0.1', protocol: 'http:' }, 'Mobile Safari/605.1'), false);
  assert.equal(isLocalWindowsOperator({ hostname: '127.0.0.1', protocol: 'http:' }, 'Linux Chrome/132.0.0.0'), false);
});

test('operator page never pairs on construction; explicit fake pairing, role redemption and local Stop work', { timeout: 15_000 }, async (t) => {
  const bridgeId = randomUUID(), sessionId = randomUUID();
  const now = Date.now();
  let chooserCalls = 0;
  let finishStop: ((response: Response) => void) | undefined;
  const writes: string[] = [], requests: { url: string; authorization: string | null }[] = [];
  const states: OperatorBridgeState[] = [];
  const page = new EventTarget(), documentTarget = new EventTarget();
  const characteristic = Object.assign(new EventTarget(), {
    uuid: 'mock-write', properties: { write: true }, startNotifications: async () => {},
    writeValueWithResponse: async (bytes: Uint8Array) => { writes.push(new TextDecoder().decode(bytes)); },
  });
  const device = Object.assign(new EventTarget(), {
    id: 'mock-robot', name: 'Mock PadBot',
    gatt: {
      connected: false,
      async connect() { this.connected = true; return this; },
      disconnect() { this.connected = false; },
      async getPrimaryService() { return { uuid: 'fff0', getCharacteristics: async () => [characteristic] }; },
    },
  });
  class Socket extends EventTarget {
    static OPEN = 1;
    static instances: Socket[] = [];
    readyState = 0;
    sent: unknown[] = [];
    constructor(readonly url: string) { super(); Socket.instances.push(this); }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  }
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    if (url.endsWith('/operator-pair')) return Response.json({ bridgeId, operatorToken: 'o'.repeat(32), role: 'operator', purpose: 'bridge:lease', expiresAt: now + 300000 });
    if (url.endsWith('/pair')) return Response.json({ bridgeId, bridgeToken: 'b'.repeat(32), role: 'bridge', expiresAt: now + 300000 });
    if (url.endsWith('/lease')) return Response.json({ bridgeId, sessionId, leaseId: randomUUID(), generation: 2,
      issuedAt: Date.now(), expiresAt: Date.now() + 30000, operatorArmed: true, rearClearanceConfirmed: true });
    if (url.endsWith('/stop')) return new Promise<Response>((resolve) => { finishStop = resolve; });
    throw new Error('Unexpected test request.');
  };
  const globals: Record<string, unknown> = {
    window: Object.assign(page, { location: { hostname: '127.0.0.1', protocol: 'http:' }, isSecureContext: true }),
    document: Object.assign(documentTarget, { hidden: false }),
    navigator: { userAgent: 'Windows NT 10.0 Chrome/132.0.0.0', bluetooth: { requestDevice: async () => { ++chooserCalls; return device; } } },
    WebSocket: Socket, fetch: fakeFetch,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let controller: OperatorBridgeController | undefined;
  t.after(async () => {
    await controller?.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  controller = new OperatorBridgeController((state) => states.push(state));
  assert.equal(chooserCalls, 0);
  assert.equal(requests.length, 0);
  assert.equal(Socket.instances.length, 0);
  await controller.pairBluetooth();
  assert.equal(chooserCalls, 1);
  assert.ok(writes.includes('0'));
  assert.equal(writes.includes('X4'), false);
  await controller.redeem(bridgeId, 'ABCDEF12', 'FEDCBA12');
  const socket = Socket.instances[0]!;
  assert.equal(socket.url.includes('?'), false);
  assert.equal(socket.url.includes('bbbb'), false);
  socket.open();
  assert.deepEqual(socket.sent[0], { type: 'authenticate', bridgeToken: 'b'.repeat(32) });
  socket.message({ type: 'state', bridgeId, generation: 1, lastSequence: 0, lease: null, serverTime: Date.now() });
  for (let index = 0; index < 25; index++) await Promise.resolve();
  await controller.arm(sessionId, true);
  assert.equal(states.at(-1)!.armed, true);
  assert.equal(states.at(-1)!.boundSession, sessionId);
  assert.equal(requests.find((request) => request.url.endsWith('/lease'))!.authorization, `Bearer ${'o'.repeat(32)}`);
  await controller.stop();
  assert.ok(finishStop, 'Broker notification started, but local Stop did not await it');
  finishStop(Response.json({ command: null }));
  assert.equal(states.at(-1)!.armed, false);
  assert.equal(states.at(-1)!.stopped, true);
  assert.equal(writes.some((write) => write.includes('X4') || write.includes('X1')), false);
  const before = Socket.instances.length;
  socket.close();
  assert.equal(Socket.instances.length, before, 'No automatic reconnect');
  assert.equal(states.at(-1)!.brokerConnected, false);
});
