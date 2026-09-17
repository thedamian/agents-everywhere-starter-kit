import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BRIDGE_LIMITS, type BridgeAcknowledgement, type BridgeCommand, type BridgeLease, type BridgeServerMessage } from '../contracts/bridge.js';
import { BridgeBroker } from './broker.js';
import { createBridgeRouter } from './router.js';
import { LocalBridgeSafety, type SafetyClock } from './safety.js';

class Clock implements SafetyClock {
  value = 1_800_000_000_000;
  next = 0;
  tasks = new Map<number, { at: number; callback: () => void }>();
  now = () => this.value;
  setTimeout = (callback: () => void, ms: number) => { const id = ++this.next; this.tasks.set(id, { at: this.value + ms, callback }); return id; };
  clearTimeout = (id: unknown) => { if (typeof id === 'number') this.tasks.delete(id); };
  async advance(ms: number) {
    const target = this.value + ms;
    while (true) {
      const entry = [...this.tasks].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      this.value = entry[1].at; this.tasks.delete(entry[0]); entry[1].callback();
      await flush();
    }
    this.value = target;
    await flush();
  }
}
async function flush() { for (let index = 0; index < 15; index++) await Promise.resolve(); }
class Driver {
  connected = true;
  writes: string[] = [];
  failStop = false;
  speedGate: Promise<void> | null = null;
  async setSpeed(speed: 'low') { this.writes.push(speed); await this.speedGate; }
  async drive(direction: 'backward', options: { durationMs: number; repeatMs: number }) {
    assert.ok(options.durationMs > 0 && options.durationMs <= BRIDGE_LIMITS.maxPulseMs);
    assert.equal(options.repeatMs, 0);
    this.writes.push(direction);
  }
  async stop() { this.writes.push('stop'); if (this.failStop) throw new Error('Mock BLE unavailable'); }
}
function lease(clock: Clock, generation = 1): BridgeLease {
  return { bridgeId: randomUUID(), sessionId: randomUUID(), leaseId: randomUUID(), generation,
    issuedAt: clock.now(), expiresAt: clock.now() + BRIDGE_LIMITS.maxLeaseMs, operatorArmed: true, rearClearanceConfirmed: true };
}
function tracking(clock: Clock) {
  return { capturedAt: new Date(clock.now()).toISOString(), confidence: 0.95, personCount: 1 as const,
    goal: 'half_body' as const, centerX: 0.5, centerY: 0.5, bodyOccupancy: 0.9 };
}
function command(clock: Clock, control: BridgeLease, sequence = 1): BridgeCommand {
  return { commandId: randomUUID(), bridgeId: control.bridgeId, sessionId: control.sessionId,
    leaseId: control.leaseId, leaseGeneration: control.generation, sequence,
    issuedAt: clock.now(), expiresAt: clock.now() + 1000, type: 'motion', intent: 'reverse_for_half_body',
    speed: 'low', pulseMs: 500, tracking: tracking(clock) };
}
async function localHarness() {
  const clock = new Clock(), driver = new Driver(), acks: BridgeAcknowledgement[] = [], errors: string[] = [];
  const safety = new LocalBridgeSafety({ driver, clock, onAcknowledgement: (ack) => acks.push(ack), onError: (message) => errors.push(message) });
  const control = lease(clock);
  safety.brokerHeartbeat(clock.now());
  await safety.setState(control, 1, 0);
  safety.arm(true);
  driver.writes.length = 0;
  return { clock, driver, acks, errors, safety, control };
}

test('local positive permit enforces low reverse/500ms/stop and truthful acknowledgements', async () => {
  const h = await localHarness();
  await h.safety.execute(command(h.clock, h.control));
  assert.deepEqual(h.driver.writes, ['low', 'backward']);
  assert.equal(h.acks[0]!.status, 'write_completed');
  assert.equal(h.acks[0]!.physicalExecution, 'unverified');
  await h.clock.advance(500);
  assert.equal(h.driver.writes.at(-1), 'stop');
  assert.equal(h.acks[1]!.status, 'stop_written');
  assert.equal(h.safety.state.pulseCount, 1);
  assert.equal(h.safety.state.stopped, true);
  await h.safety.close();
});

for (const failure of ['not_armed', 'expired', 'tracking', 'future', 'sequence', 'generation', 'lease', 'wrong_session', 'low_confidence', 'oversize', 'forward'] as const) {
  test(`local gate rejects ${failure} before any drive`, async () => {
    const h = await localHarness();
    const permit = command(h.clock, h.control);
    assert.equal(permit.type, 'motion');
    if (permit.type !== 'motion') throw new Error('fixture');
    let input: unknown = permit;
    if (failure === 'not_armed') await h.safety.stop();
    if (failure === 'expired') { permit.issuedAt -= 2000; permit.expiresAt -= 2000; }
    if (failure === 'tracking') permit.tracking = { ...permit.tracking, capturedAt: new Date(h.clock.now() - 1001).toISOString() };
    if (failure === 'future') permit.issuedAt += 1;
    if (failure === 'sequence') permit.sequence = 3;
    if (failure === 'generation') permit.leaseGeneration = 99;
    if (failure === 'lease') permit.leaseId = randomUUID();
    if (failure === 'wrong_session') permit.sessionId = randomUUID();
    if (failure === 'low_confidence') permit.tracking = { ...permit.tracking, confidence: 0.1 };
    if (failure === 'oversize') input = { ...permit, pulseMs: 501 };
    if (failure === 'forward') input = { ...permit, intent: 'forward', direction: 'forward' };
    await h.safety.execute(input);
    assert.equal(h.driver.writes.includes('backward'), false);
    assert.equal(h.safety.state.armed, false);
    if (!['oversize', 'forward'].includes(failure)) assert.equal(h.acks.at(-1)!.status, 'rejected');
    await h.safety.close();
  });
}

test('replay/out of order disarm; STOP bypasses stale generation/sequence/expiry', async () => {
  const h = await localHarness();
  const permit = command(h.clock, h.control);
  await h.safety.execute(permit);
  await h.clock.advance(500);
  await h.safety.execute(permit);
  assert.equal(h.acks.at(-1)!.reason, 'out_of_order');
  assert.equal(h.driver.writes.filter((write) => write === 'backward').length, 1);
  const stop: BridgeCommand = { commandId: randomUUID(), bridgeId: h.control.bridgeId, sessionId: h.control.sessionId,
    leaseId: randomUUID(), leaseGeneration: 999, sequence: 1, issuedAt: h.clock.now() - 5000,
    expiresAt: h.clock.now() - 4000, type: 'stop', reason: 'user' };
  await h.safety.execute(stop);
  assert.equal(h.acks.at(-1)!.status, 'stop_written');
  await h.safety.close();
});

for (const loss of ['heartbeat', 'lease_expiry', 'disconnect', 'hidden'] as const) {
  test(`${loss} stops and disarms, return/reconnect cannot rearm`, async () => {
    const h = await localHarness();
    await h.safety.execute(command(h.clock, h.control));
    if (loss === 'hidden') await h.safety.setForeground(false);
    if (loss === 'disconnect') { h.driver.connected = false; await h.safety.disconnected(); }
    if (loss === 'heartbeat') await h.clock.advance(1100);
    if (loss === 'lease_expiry') {
      await h.safety.setState({ ...h.control, expiresAt: h.clock.now() + 50 }, 1, 1);
      await h.clock.advance(100);
    }
    assert.equal(h.safety.state.armed, false);
    h.driver.connected = true;
    await h.safety.setForeground(true);
    await h.safety.setState({ ...h.control, generation: 2 }, 2, 1);
    assert.equal(h.safety.state.armed, false);
    await h.safety.close();
  });
}

test('fixed cumulative count/budget survives reconnect and all explicit rearming', async () => {
  const h = await localHarness();
  for (let sequence = 1; sequence <= 4; sequence++) {
    h.safety.brokerHeartbeat(h.clock.now());
    h.safety.arm(true);
    await h.safety.execute(command(h.clock, h.control, sequence));
    await h.clock.advance(1500);
  }
  assert.equal(h.safety.state.pulseMsUsed, 2000);
  assert.equal(h.safety.state.pulseCount, 4);
  await h.safety.setState({ ...h.control, generation: 2 }, 2, 4);
  h.safety.brokerHeartbeat(h.clock.now());
  assert.throws(() => h.safety.arm(true), /budget/);
  assert.equal(h.driver.writes.filter((write) => write === 'backward').length, 4);
  await h.safety.close();
});

test('cooldown and in-flight Stop prohibit a second movement write', async () => {
  const h = await localHarness();
  let release!: () => void;
  h.driver.speedGate = new Promise<void>((resolve) => { release = resolve; });
  const pending = h.safety.execute(command(h.clock, h.control));
  await flush();
  await h.safety.stop();
  release();
  await pending;
  assert.equal(h.driver.writes.includes('backward'), false);
  assert.equal(h.safety.state.pulseCount, 1);
  h.safety.arm(true);
  await h.safety.execute(command(h.clock, h.control, 2));
  assert.equal(h.acks.at(-1)!.reason, 'not_armed');
  await h.safety.close();
});

test('failed local Stop never produces stop_written or claims stopped', async () => {
  const h = await localHarness();
  h.driver.failStop = true;
  const base = command(h.clock, h.control);
  await h.safety.execute({ commandId: base.commandId, bridgeId: base.bridgeId, sessionId: base.sessionId,
    leaseId: base.leaseId, leaseGeneration: base.leaseGeneration, sequence: base.sequence,
    issuedAt: base.issuedAt, expiresAt: base.expiresAt, type: 'stop', reason: 'user' });
  assert.equal(h.acks.at(-1)!.status, 'rejected');
  assert.equal(h.safety.state.stopped, false);
  assert.ok(h.errors.some((message) => /physical stop/.test(message)));
  await h.safety.close();
});

test('a slow speed write cannot start movement after the local pulse deadline', async () => {
  const h = await localHarness();
  let release!: () => void;
  h.driver.speedGate = new Promise<void>((resolve) => { release = resolve; });
  const pending = h.safety.execute(command(h.clock, h.control));
  await flush();
  // Advance wall time without running timers, as with a stalled event loop.
  h.clock.value += 501;
  release();
  await pending;
  assert.equal(h.driver.writes.includes('backward'), false);
  assert.equal(h.acks.at(-1)!.status, 'stop_written');
  await h.safety.close();
});

test('freshness boundary and inconsistent state generation fail closed', async () => {
  const h = await localHarness();
  const permit = command(h.clock, h.control);
  if (permit.type !== 'motion') throw new Error('fixture');
  permit.tracking = { ...permit.tracking, capturedAt: new Date(h.clock.now() - 1000).toISOString() };
  await h.safety.execute(permit);
  assert.equal(h.acks.at(-1)!.reason, 'expired');
  h.safety.arm(true);
  await h.safety.setState({ ...h.control, generation: 2 }, 3, 0);
  assert.equal(h.safety.state.armed, false);
  await h.safety.close();
});

function brokerHarness() {
  const clock = new Clock(), messages: BridgeServerMessage[] = [];
  const sessionId = randomUUID();
  let active = true, motionConsent = true;
  const broker = new BridgeBroker({ now: clock.now, sessionSafety: (id) => ({ active: active && id === sessionId, motionConsent }) });
  const pairing = broker.register({ label: 'Local test', platform: 'windows-chrome' });
  const operatorPairing = broker.operatorPairing(pairing.bridgeId);
  const bridge = broker.pair(pairing.bridgeId, pairing.pairingCode);
  const operator = broker.pairOperator(pairing.bridgeId, operatorPairing.operatorCode);
  const disconnect = broker.connect(pairing.bridgeId, bridge.bridgeToken, { send: (message) => messages.push(message), close() {} });
  function heartbeat(control: BridgeLease | null = null) {
    broker.heartbeat(bridge.bridgeId, { leaseId: control?.leaseId ?? null, leaseGeneration: broker.status(bridge.bridgeId).leaseGeneration,
      lastSequence: messages.filter((message) => message.type === 'command').at(-1)?.command.sequence ?? 0,
      connected: true, foreground: true, stopped: true, at: clock.now() });
  }
  async function arm() {
    heartbeat();
    const control = await broker.lease(bridge.bridgeId, { eventId: randomUUID(), sessionId,
      expectedGeneration: broker.status(bridge.bridgeId).leaseGeneration, operatorArmed: true, rearClearanceConfirmed: true });
    heartbeat(control);
    return control;
  }
  return { clock, broker, sessionId, bridge, operator, pairing, messages, disconnect, heartbeat, arm,
    consent: (value: boolean) => { motionConsent = value; }, active: (value: boolean) => { active = value; } };
}

test('broker role codes are single-use, scoped, expiring, and cannot interchange lease/control roles', async () => {
  const h = brokerHarness();
  assert.throws(() => h.broker.pair(h.bridge.bridgeId, h.pairing.pairingCode), /expired/);
  assert.throws(() => h.broker.authorize(h.bridge.bridgeId, h.bridge.bridgeToken, 'operator'), /operator credential/);
  assert.throws(() => h.broker.authorize(h.bridge.bridgeId, h.operator.operatorToken, 'bridge'), /bridge credential/);
  assert.throws(() => h.broker.register({ label: 'second', platform: 'windows-chrome' }), /already registered/);
  h.clock.value += 300_001;
  assert.throws(() => h.broker.authorize(h.bridge.bridgeId, h.bridge.bridgeToken, 'bridge'), /credential/);
  h.broker.close();
});

test('broker one active bridge/channel/session/controller, concurrent lease rejected', async () => {
  const h = brokerHarness();
  assert.throws(() => h.broker.connect(h.bridge.bridgeId, h.bridge.bridgeToken, { send() {}, close() {} }), /already has/);
  h.heartbeat();
  const request = { eventId: randomUUID(), sessionId: h.sessionId, expectedGeneration: h.broker.status(h.bridge.bridgeId).leaseGeneration,
    operatorArmed: true, rearClearanceConfirmed: true };
  const outcomes = await Promise.allSettled([h.broker.lease(h.bridge.bridgeId, request), h.broker.lease(h.bridge.bridgeId, { ...request, eventId: randomUUID() })]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  h.broker.close();
});

test('broker positive approved execution plus stop acknowledgements and no stale replay after reconnect', async () => {
  const h = brokerHarness();
  const control = await h.arm();
  const permit = await h.broker.authorizeMotion(h.sessionId, { intent: 'reverse_for_half_body', speed: 'low', pulseMs: 500,
    leaseId: control.leaseId, leaseGeneration: control.generation, tracking: tracking(h.clock) });
  assert.equal(permit.type, 'motion');
  h.broker.acknowledge(h.bridge.bridgeId, { commandId: permit.commandId, leaseId: permit.leaseId,
    leaseGeneration: permit.leaseGeneration, sequence: permit.sequence, status: 'write_completed',
    physicalExecution: 'unverified', reason: 'completed', at: h.clock.now() });
  h.broker.acknowledge(h.bridge.bridgeId, { commandId: permit.commandId, leaseId: permit.leaseId,
    leaseGeneration: permit.leaseGeneration, sequence: permit.sequence, status: 'stop_written',
    physicalExecution: 'unverified', reason: 'stop', at: h.clock.now() });
  assert.equal(h.broker.sessionState(h.sessionId).acknowledgement!.status, 'stop_written');
  h.disconnect();
  const messages: BridgeServerMessage[] = [];
  h.broker.connect(h.bridge.bridgeId, h.bridge.bridgeToken, { send: (message) => messages.push(message), close() {} });
  assert.equal(messages.some((message) => message.type === 'command'), false);
  assert.equal(h.broker.status(h.bridge.bridgeId).armed, false);
  await assert.rejects(h.broker.authorizeMotion(h.sessionId, { intent: 'reverse_for_half_body', speed: 'low', pulseMs: 500,
    leaseId: control.leaseId, leaseGeneration: control.generation, tracking: tracking(h.clock) }), /valid operator-armed/);
  h.broker.close();
});

test('broker rejects stale tracking, missing consent, cooldown and lease loss; watchdog revokes', async () => {
  const h = brokerHarness(), control = await h.arm();
  const input = { intent: 'reverse_for_half_body' as const, speed: 'low' as const, pulseMs: 500,
    leaseId: control.leaseId, leaseGeneration: control.generation, tracking: tracking(h.clock) };
  await assert.rejects(h.broker.authorizeMotion(h.sessionId, { ...input, tracking: { ...input.tracking, capturedAt: new Date(h.clock.now() - 1001).toISOString() } }), /fresh/);
  await h.broker.authorizeMotion(h.sessionId, input);
  h.heartbeat(control);
  await assert.rejects(h.broker.authorizeMotion(h.sessionId, input), /budget or cooldown/);
  h.clock.value += 1100;
  await h.broker.tick();
  assert.equal(h.broker.status(h.bridge.bridgeId).armed, false);
  h.consent(false);
  await assert.rejects(h.broker.authorizeMotion(h.sessionId, input), /consent/);
  h.broker.close();
});

test('broker caps cannot be reset by Stop, rearming, credential renewal or reconnect', async () => {
  const h = brokerHarness();
  for (let pulse = 0; pulse < 4; pulse++) {
    const control = await h.arm();
    await h.broker.authorizeMotion(h.sessionId, { intent: 'reverse_for_half_body', speed: 'low', pulseMs: 500,
      leaseId: control.leaseId, leaseGeneration: control.generation, tracking: tracking(h.clock) });
    h.broker.stopSession(h.sessionId, 'operator');
    h.clock.value += 1500;
  }
  await assert.rejects(h.arm(), /budget/);
  const renewed = h.broker.renew(h.bridge.bridgeId, h.bridge.bridgeToken);
  h.broker.connect(h.bridge.bridgeId, renewed.bridgeToken, { send() {}, close() {} });
  h.heartbeat();
  await assert.rejects(h.broker.lease(h.bridge.bridgeId, { eventId: randomUUID(), sessionId: h.sessionId,
    expectedGeneration: h.broker.status(h.bridge.bridgeId).leaseGeneration, operatorArmed: true, rearClearanceConfirmed: true }), /budget/);
  h.broker.close();
});

test('pair codes expire, wrong-role codes never redeem, and five failures lock a code', () => {
  const clock = new Clock();
  const broker = new BridgeBroker({ now: clock.now, sessionSafety: () => ({ active: true, motionConsent: true }) });
  const pairing = broker.register({ label: 'Test', platform: 'windows-chrome' });
  const operator = broker.operatorPairing(pairing.bridgeId);
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.throws(() => broker.pair(pairing.bridgeId, operator.operatorCode), /not valid/);
  }
  assert.throws(() => broker.pair(pairing.bridgeId, pairing.pairingCode), /expired or unavailable/);
  clock.value += 60_001;
  assert.throws(() => broker.pairOperator(pairing.bridgeId, operator.operatorCode), /expired or unavailable/);
  broker.close();
});

test('unknown/mismatched/duplicate acknowledgements never become physical success', async () => {
  const h = brokerHarness(), control = await h.arm();
  const permit = await h.broker.authorizeMotion(h.sessionId, { intent: 'reverse_for_half_body', speed: 'low', pulseMs: 250,
    leaseId: control.leaseId, leaseGeneration: control.generation, tracking: tracking(h.clock) });
  const acknowledgement: BridgeAcknowledgement = { commandId: permit.commandId, leaseId: permit.leaseId,
    leaseGeneration: permit.leaseGeneration, sequence: permit.sequence, status: 'stop_written', reason: 'stop',
    physicalExecution: 'unverified', at: h.clock.now() };
  assert.throws(() => h.broker.acknowledge(h.bridge.bridgeId, { ...acknowledgement, commandId: randomUUID() }), /issued command/);
  assert.throws(() => h.broker.acknowledge(h.bridge.bridgeId, { ...acknowledgement, physicalExecution: 'confirmed' }));
  h.broker.acknowledge(h.bridge.bridgeId, acknowledgement);
  assert.throws(() => h.broker.acknowledge(h.bridge.bridgeId, acknowledgement), /terminal/);
  h.broker.close();
});

test('router isolates long-lived local setup secret, exact origins, and role-scoped leases', async () => {
  const clock = new Clock(), sessionId = randomUUID(), secret = 's'.repeat(32), sessionToken = 'k'.repeat(32);
  const broker = new BridgeBroker({ now: clock.now, sessionSafety: () => ({ active: true, motionConsent: true }) });
  const router = createBridgeRouter({ broker, operatorToken: secret, allowedOrigins: ['http://127.0.0.1:3202'],
    authorizeSession: (id, credential) => id === sessionId && credential === sessionToken });
  const request = (path: string, body: unknown, credential?: string, origin?: string) => router.request(`http://127.0.0.1:3101${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });
  const registration = { label: 'Test operator', platform: 'windows-chrome' };
  assert.equal((await request('/v1/operator/bridges', registration, secret, 'http://127.0.0.1:3202')).status, 401);
  assert.equal((await request('/v1/operator/bridges', registration, secret, 'https://public.example')).status, 403);
  const response = await request('/v1/operator/bridges', registration, secret);
  assert.equal(response.status, 201);
  const pairing = await response.json() as { bridgeId: string; pairingCode: string };
  assert.equal((await request(`/v1/bridges/${pairing.bridgeId}/pair`, { pairingCode: pairing.pairingCode })).status, 403);
  const paired = await request(`/v1/bridges/${pairing.bridgeId}/pair`, { pairingCode: pairing.pairingCode }, undefined, 'http://127.0.0.1:3202');
  const credential = await paired.json() as { bridgeToken: string };
  assert.equal((await request(`/v1/operator/bridges/${pairing.bridgeId}/lease`, {}, credential.bridgeToken, 'http://127.0.0.1:3202')).status, 401);
  assert.equal((await request(`/v1/sessions/${sessionId}/bridge/stop`, { reason: 'user' }, sessionToken, 'https://kiosk.example')).status, 200);
  assert.equal((await request(`/v1/sessions/${sessionId}/bridge/stop`, { reason: 'user' }, credential.bridgeToken)).status, 401);
  broker.close();
});
