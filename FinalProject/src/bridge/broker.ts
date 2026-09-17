import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  BRIDGE_LIMITS, BridgeAcknowledgementSchema, BridgeHeartbeatSchema, BridgeLeaseInputSchema,
  BridgeRegistrationInputSchema, MotionIntentSchema,
  type BridgeAcknowledgement, type BridgeCommand, type BridgeCredential, type BridgeHeartbeat,
  type BridgeLease, type BridgeLeaseInput, type BridgePairing, type BridgeServerMessage,
  type BridgeStatus, type MotionIntent, type StopIntent,
  type OperatorCredential, type OperatorPairing,
} from '../contracts/bridge.js';

const PAIR_MS = 60_000;
const CREDENTIAL_MS = 5 * 60_000;
const code = () => randomBytes(4).toString('hex').toUpperCase();
const token = () => randomBytes(32).toString('base64url');
function matches(actual: string, expected: string): boolean {
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export class BridgeError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503, readonly code: string, message: string) { super(message); }
}
export interface SessionMotionSafety { active: boolean; motionConsent: boolean }
export interface BridgeChannel { send(message: BridgeServerMessage): void; close(): void }
type Grant = { value: string; expiresAt: number; attempts: number };
type Credential = { value: string; expiresAt: number };
interface BridgeRecord {
  id: string;
  label: string;
  pairing: Grant | null;
  operatorPairing: Grant | null;
  credential: Credential | null;
  operatorCredential: Credential | null;
  generation: number;
  sequence: number;
  channel: BridgeChannel | null;
  lease: BridgeLease | null;
  lastLease: BridgeLease | null;
  heartbeat: BridgeHeartbeat | null;
  heartbeatAt: number;
  pulseMsUsed: number;
  pulseCount: number;
  nextPulseAt: number;
  commands: Map<string, BridgeCommand>;
  acknowledgements: Map<string, BridgeAcknowledgement>;
  usedLeaseEvents: Set<string>;
}

export class BridgeBroker {
  private bridge: BridgeRecord | null = null;
  private readonly now: () => number;
  constructor(private readonly options: { sessionSafety(sessionId: string): Promise<SessionMotionSafety> | SessionMotionSafety; now?: () => number; onError?(code: string): void }) {
    this.now = options.now ?? Date.now;
  }

  register(input: unknown): BridgePairing {
    const request = BridgeRegistrationInputSchema.parse(input);
    const old = this.bridge;
    if (old && (old.channel || old.lease || (old.credential && old.credential.expiresAt > this.now())
      || (old.pairing && old.pairing.expiresAt > this.now()))) {
      throw new BridgeError(409, 'BRIDGE_IN_USE', 'A bridge is already registered. Close and expire it before a new setup.');
    }
    const id = randomUUID();
    const pairing = { value: code(), expiresAt: this.now() + PAIR_MS, attempts: 0 };
    this.bridge = {
      id, label: request.label, pairing, operatorPairing: null, credential: null, operatorCredential: null,
      generation: 0, sequence: 0, channel: null, lease: null, lastLease: null,
      heartbeat: null, heartbeatAt: 0, pulseMsUsed: 0, pulseCount: 0, nextPulseAt: 0,
      commands: new Map(), acknowledgements: new Map(), usedLeaseEvents: new Set(),
    };
    return { bridgeId: id, pairingCode: pairing.value, expiresAt: pairing.expiresAt };
  }

  private record(id: string): BridgeRecord {
    if (!this.bridge || this.bridge.id !== id) throw new BridgeError(404, 'BRIDGE_NOT_FOUND', 'Bridge not found.');
    return this.bridge;
  }
  private redeem(grant: Grant | null, value: string): void {
    if (!grant || grant.expiresAt <= this.now() || grant.attempts >= 5) {
      throw new BridgeError(410, 'PAIRING_EXPIRED', 'The one-time code is expired or unavailable. Request a new local setup.');
    }
    ++grant.attempts;
    if (!matches(value, grant.value)) throw new BridgeError(401, 'PAIRING_DENIED', 'The one-time code is not valid for this bridge and role.');
  }
  pair(id: string, pairingCode: string): BridgeCredential {
    const bridge = this.record(id);
    this.redeem(bridge.pairing, pairingCode);
    bridge.pairing = null;
    bridge.credential = { value: token(), expiresAt: this.now() + CREDENTIAL_MS };
    return { bridgeId: id, bridgeToken: bridge.credential.value, role: 'bridge', expiresAt: bridge.credential.expiresAt };
  }
  operatorPairing(id: string): OperatorPairing {
    const bridge = this.record(id);
    bridge.operatorPairing = { value: code(), expiresAt: this.now() + PAIR_MS, attempts: 0 };
    return { bridgeId: id, operatorCode: bridge.operatorPairing.value, expiresAt: bridge.operatorPairing.expiresAt };
  }
  pairOperator(id: string, operatorCode: string): OperatorCredential {
    const bridge = this.record(id);
    this.redeem(bridge.operatorPairing, operatorCode);
    bridge.operatorPairing = null;
    bridge.operatorCredential = { value: token(), expiresAt: this.now() + CREDENTIAL_MS };
    return { bridgeId: id, operatorToken: bridge.operatorCredential.value, role: 'operator', purpose: 'bridge:lease', expiresAt: bridge.operatorCredential.expiresAt };
  }
  authorize(id: string, value: string, role: 'bridge' | 'operator'): void {
    const bridge = this.record(id);
    const credential = role === 'bridge' ? bridge.credential : bridge.operatorCredential;
    if (!credential || credential.expiresAt <= this.now() || !matches(value, credential.value)) {
      throw new BridgeError(401, 'BRIDGE_AUTH_REQUIRED', `A current ${role} credential scoped to this bridge is required.`);
    }
  }
  renew(id: string, value: string): BridgeCredential {
    this.authorize(id, value, 'bridge');
    const bridge = this.record(id);
    this.invalidate(bridge, 'disconnect');
    bridge.channel?.close();
    bridge.channel = null;
    bridge.credential = { value: token(), expiresAt: this.now() + CREDENTIAL_MS };
    return { bridgeId: id, bridgeToken: bridge.credential.value, role: 'bridge', expiresAt: bridge.credential.expiresAt };
  }

  connect(id: string, value: string, channel: BridgeChannel): () => void {
    this.authorize(id, value, 'bridge');
    const bridge = this.record(id);
    if (bridge.channel) throw new BridgeError(409, 'BRIDGE_CONNECTED', 'This bridge already has a control connection.');
    this.invalidate(bridge, 'disconnect');
    bridge.channel = channel;
    bridge.heartbeat = null;
    bridge.heartbeatAt = this.now();
    this.state(bridge);
    return () => {
      if (bridge.channel !== channel) return;
      bridge.channel = null;
      this.invalidate(bridge, 'disconnect');
    };
  }

  private send(bridge: BridgeRecord, message: BridgeServerMessage): void {
    if (!bridge.channel) return;
    try { bridge.channel.send(message); } catch {
      this.options.onError?.('BRIDGE_TRANSPORT_FAILED');
      bridge.channel.close();
      bridge.channel = null;
      bridge.lease = null;
      bridge.generation += 1;
    }
  }
  private state(bridge: BridgeRecord): void {
    this.send(bridge, { type: 'state', bridgeId: bridge.id, generation: bridge.generation,
      lastSequence: bridge.sequence, lease: bridge.lease, serverTime: this.now() });
  }

  async lease(id: string, input: unknown): Promise<BridgeLease> {
    const request: BridgeLeaseInput = BridgeLeaseInputSchema.parse(input);
    const bridge = this.record(id);
    const safety = await this.options.sessionSafety(request.sessionId);
    if (!safety.active) throw new BridgeError(409, 'SESSION_INACTIVE', 'The selected kiosk session is inactive.');
    if (!bridge.channel || !bridge.credential || bridge.credential.expiresAt <= this.now()
      || !bridge.operatorCredential || bridge.operatorCredential.expiresAt <= this.now()
      || !bridge.heartbeat?.connected || !bridge.heartbeat.foreground || !bridge.heartbeat.stopped
      || this.now() - bridge.heartbeatAt > BRIDGE_LIMITS.watchdogMs) {
      throw new BridgeError(409, 'BRIDGE_NOT_READY', 'The bridge must be connected, foreground and stopped with a fresh heartbeat.');
    }
    if (bridge.lease || request.expectedGeneration !== bridge.generation || bridge.usedLeaseEvents.has(request.eventId)) {
      throw new BridgeError(409, 'LEASE_CONFLICT', 'Another controller or stale generation already owns this bridge. Stop before rearming.');
    }
    if (bridge.pulseCount >= BRIDGE_LIMITS.maxPulseCount || bridge.pulseMsUsed >= BRIDGE_LIMITS.maxCumulativePulseMs) {
      throw new BridgeError(409, 'MOTION_BUDGET', 'The fixed encounter movement budget is exhausted.');
    }
    const now = this.now();
    bridge.usedLeaseEvents.add(request.eventId);
    bridge.lease = Object.freeze({
      bridgeId: id, sessionId: request.sessionId, leaseId: randomUUID(),
      generation: ++bridge.generation, issuedAt: now,
      expiresAt: Math.min(now + BRIDGE_LIMITS.maxLeaseMs, bridge.credential.expiresAt, bridge.operatorCredential.expiresAt),
      operatorArmed: true, rearClearanceConfirmed: true,
    });
    bridge.lastLease = bridge.lease;
    bridge.heartbeat = null; // The operator client must acknowledge the new generation.
    this.state(bridge);
    return bridge.lease;
  }

  heartbeat(id: string, input: unknown): void {
    const heartbeat = BridgeHeartbeatSchema.parse(input);
    const bridge = this.record(id);
    if (Math.abs(heartbeat.at - this.now()) > BRIDGE_LIMITS.watchdogMs
      || heartbeat.leaseGeneration !== bridge.generation || heartbeat.lastSequence > bridge.sequence
      || heartbeat.leaseId !== (bridge.lease?.leaseId ?? null)) {
      this.invalidate(bridge, 'watchdog');
      throw new BridgeError(409, 'HEARTBEAT_STALE', 'Bridge heartbeat does not match its current lease generation.');
    }
    bridge.heartbeat = heartbeat;
    bridge.heartbeatAt = this.now();
    if ((!heartbeat.foreground || !heartbeat.connected) && bridge.lease) this.invalidate(bridge, 'disconnect');
  }

  /** Called only after an authoritative, current showroom action approval. */
  async authorizeMotion(sessionId: string, input: MotionIntent): Promise<BridgeCommand> {
    const intent = MotionIntentSchema.parse(input);
    const bridge = this.bridge;
    if (!bridge) throw new BridgeError(409, 'NO_BRIDGE', 'No operator bridge is available.');
    const lease = bridge.lease;
    const safety = await this.options.sessionSafety(sessionId);
    const now = this.now();
    if (!safety.active || !safety.motionConsent) {
      this.stopSession(sessionId, 'session_ended');
      throw new BridgeError(403, 'MOTION_CONSENT_REQUIRED', 'Current customer motion consent is required.');
    }
    if (!lease || bridge.lease !== lease || lease.sessionId !== sessionId || lease.leaseId !== intent.leaseId
      || lease.generation !== intent.leaseGeneration || lease.expiresAt <= now) {
      throw new BridgeError(409, 'LEASE_INVALID', 'The current kiosk does not own a valid operator-armed lease.');
    }
    if (!bridge.channel || !bridge.credential || bridge.credential.expiresAt <= now
      || !bridge.operatorCredential || bridge.operatorCredential.expiresAt <= now
      || !bridge.heartbeat?.connected || !bridge.heartbeat.foreground || !bridge.heartbeat.stopped
      || now - bridge.heartbeatAt > BRIDGE_LIMITS.watchdogMs
      || bridge.heartbeat.leaseGeneration !== lease.generation) {
      this.invalidate(bridge, 'watchdog');
      throw new BridgeError(409, 'BRIDGE_UNHEALTHY', 'Bridge control is not fresh, foreground and stopped.');
    }
    const capturedAt = Date.parse(intent.tracking.capturedAt);
    if (capturedAt > now || now - capturedAt >= BRIDGE_LIMITS.trackingFreshnessMs || intent.tracking.confidence < 0.8) {
      throw new BridgeError(409, 'TRACKING_STALE', 'A fresh, confident single-person framing measurement is required.');
    }
    if (bridge.pulseCount >= BRIDGE_LIMITS.maxPulseCount
      || bridge.pulseMsUsed + intent.pulseMs > BRIDGE_LIMITS.maxCumulativePulseMs || now < bridge.nextPulseAt) {
      throw new BridgeError(409, 'MOTION_BUDGET', 'The fixed movement budget or cooldown does not permit another pulse.');
    }
    const command: BridgeCommand = {
      commandId: randomUUID(), bridgeId: bridge.id, sessionId, leaseId: lease.leaseId,
      leaseGeneration: lease.generation, sequence: ++bridge.sequence,
      issuedAt: now, expiresAt: Math.min(now + BRIDGE_LIMITS.maxCommandLifetimeMs, lease.expiresAt,
        capturedAt + BRIDGE_LIMITS.trackingFreshnessMs),
      type: 'motion', intent: intent.intent, speed: 'low', pulseMs: intent.pulseMs, tracking: intent.tracking,
    };
    bridge.pulseCount += 1;
    bridge.pulseMsUsed += intent.pulseMs;
    bridge.nextPulseAt = now + intent.pulseMs + BRIDGE_LIMITS.cooldownMs;
    bridge.heartbeat = { ...bridge.heartbeat, stopped: false };
    this.queue(bridge, command);
    return command;
  }

  private queue(bridge: BridgeRecord, command: BridgeCommand): void {
    bridge.commands.set(command.commandId, command);
    while (bridge.commands.size > 20) bridge.commands.delete(bridge.commands.keys().next().value!);
    this.send(bridge, { type: 'command', command });
  }
  private invalidate(bridge: BridgeRecord, reason: StopIntent['reason']): BridgeCommand | null {
    const lease = bridge.lease;
    bridge.lease = null;
    ++bridge.generation;
    let command: BridgeCommand | null = null;
    if (lease) {
      const now = this.now();
      command = { commandId: randomUUID(), bridgeId: bridge.id, sessionId: lease.sessionId,
        leaseId: lease.leaseId, leaseGeneration: lease.generation, sequence: ++bridge.sequence,
        issuedAt: now, expiresAt: now + BRIDGE_LIMITS.maxCommandLifetimeMs, type: 'stop', reason };
      this.queue(bridge, command);
    }
    this.state(bridge);
    return command;
  }
  stopSession(sessionId: string, reason: StopIntent['reason']): BridgeCommand | null {
    const bridge = this.bridge;
    return bridge?.lease?.sessionId === sessionId ? this.invalidate(bridge, reason) : null;
  }
  stopBridge(id: string): BridgeCommand | null { return this.invalidate(this.record(id), 'operator'); }

  acknowledge(id: string, input: unknown): void {
    const acknowledgement = BridgeAcknowledgementSchema.parse(input);
    const bridge = this.record(id);
    const command = bridge.commands.get(acknowledgement.commandId);
    if (!command || command.sequence !== acknowledgement.sequence || command.leaseId !== acknowledgement.leaseId
      || command.leaseGeneration !== acknowledgement.leaseGeneration) {
      throw new BridgeError(409, 'ACK_MISMATCH', 'Acknowledgement does not identify an issued command.');
    }
    const prior = bridge.acknowledgements.get(command.commandId);
    if (prior && (prior.status !== 'write_completed' || acknowledgement.status === 'write_completed')) {
      throw new BridgeError(409, 'ACK_REPLAY', 'This command already has a terminal acknowledgement.');
    }
    if (command.type === 'stop' && acknowledgement.status === 'write_completed') {
      throw new BridgeError(400, 'ACK_STATUS', 'A Stop requires a stop-written or rejected acknowledgement.');
    }
    bridge.acknowledgements.set(command.commandId, acknowledgement);
    while (bridge.acknowledgements.size > 20) bridge.acknowledgements.delete(bridge.acknowledgements.keys().next().value!);
    if (acknowledgement.status === 'rejected' && bridge.lease) this.invalidate(bridge, 'watchdog');
  }

  sessionState(sessionId: string): { bridge: BridgeStatus | null; lease: BridgeLease | null; acknowledgement: BridgeAcknowledgement | null } {
    const bridge = this.bridge;
    if (!bridge || (bridge.lease?.sessionId !== sessionId && bridge.lastLease?.sessionId !== sessionId)) {
      return { bridge: null, lease: null, acknowledgement: null };
    }
    return { bridge: this.status(bridge.id), lease: bridge.lease,
      acknowledgement: [...bridge.acknowledgements.values()].at(-1) ?? null };
  }
  status(id: string): BridgeStatus {
    const bridge = this.record(id);
    return { bridgeId: id,
      connected: Boolean(bridge.channel && bridge.heartbeat?.connected && this.now() - bridge.heartbeatAt <= BRIDGE_LIMITS.watchdogMs),
      armed: Boolean(bridge.lease && bridge.lease.expiresAt > this.now()),
      stopped: bridge.heartbeat?.stopped ?? false, leaseGeneration: bridge.generation,
      leaseId: bridge.lease?.leaseId ?? null, leaseExpiresAt: bridge.lease?.expiresAt ?? null,
      lastHeartbeatAt: bridge.heartbeatAt || null };
  }

  async tick(): Promise<void> {
    const bridge = this.bridge;
    if (!bridge) return;
    const lease = bridge.lease;
    if (lease) {
      const safety = await this.options.sessionSafety(lease.sessionId);
      if (bridge.lease === lease && (!safety.active || !safety.motionConsent || lease.expiresAt <= this.now()
        || !bridge.channel || this.now() - bridge.heartbeatAt > BRIDGE_LIMITS.watchdogMs)) {
        this.invalidate(bridge, lease.expiresAt <= this.now() ? 'lease_expired' : 'watchdog');
      }
    }
    if (bridge.credential && bridge.credential.expiresAt <= this.now()) {
      this.invalidate(bridge, 'disconnect');
      bridge.channel?.close();
      bridge.channel = null;
    } else this.send(bridge, { type: 'heartbeat', serverTime: this.now() });
  }
  close(): void {
    if (!this.bridge) return;
    this.invalidate(this.bridge, 'disconnect');
    this.bridge.channel?.close();
    this.bridge.channel = null;
  }
}
