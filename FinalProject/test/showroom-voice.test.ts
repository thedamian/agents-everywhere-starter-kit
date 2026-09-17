import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ShowroomVoiceService } from '../src/providers/voice.js';
import type { ShowroomSnapshot } from '../src/contracts/showroom.js';
import { createLiveSessionRequest } from '@magicpitch/showroom-runtime/server';
const sessionId = randomUUID();
const snapshot: ShowroomSnapshot = {
  schemaVersion: 1, mode: 'fixture', sessionId, serverInstanceId: randomUUID(), revision: 1,
  inputRevision: 0, expiresAt: Date.now() + 60_000, state: 'intake', visitor: null, consent: null,
  context: null, selection: null, captureSet: null, pendingAction: null, acceptedStudio: null,
  studio: { status: 'idle' }, calendar: { status: 'idle' }, playback: { status: 'idle' }, bridge: null, motionGrant: null,
};
const answer = () => Response.json({ session: { id: 'live-test', client_secret: 'must-not-leak' }, transport: { type: 'webrtc', sdp: 'v=0\r\nanswer' }, secret: 'must-not-leak' });

test('voice uses the actual preserved Live SDP request and strips provider extras before consent', async () => {
  let payload: ReturnType<typeof createLiveSessionRequest<{ name: string }>> | undefined;
  const voice = new ShowroomVoiceService({
    apiKey: 'private-test-key', snapshot: () => snapshot,
    fetch: async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/live/sessions');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-test-key');
      payload = JSON.parse(String(init?.body)); return answer();
    },
  });
  try {
    const result = await voice.setup(sessionId, { sdp: 'v=0\r\noffer', generation: 0 });
    assert.equal(result.generation, 0);
    assert.equal(result.sessionId, sessionId);
    assert.equal(payload?.session.model, 'gpt-live-1');
    assert.equal(payload?.session.delegation.responses.model, 'gpt-5.6-luna');
    assert.equal(payload?.session.store, false);
    assert.equal(payload?.transport.type, 'webrtc');
    assert.equal(Object.hasOwn(payload!.session, 'voice'), false);
    assert.equal(Object.hasOwn(payload!.session, 'audio'), false);
    assert.deepEqual(payload?.session.delegation.responses.tools.map((tool: { name: string }) => tool.name),
      ['showroom_state', 'showroom_catalog', 'showroom_action', 'showroom_playback']);
    assert.match(payload!.session.instructions, /Ask which Toyota or Lexus vehicle/);
    assert.match(payload!.session.instructions, /field selection/);
    assert.match(payload!.session.instructions, /explicit confirmation records it/);
    assert.doesNotMatch(JSON.stringify(result), /private-test-key|client_secret|must-not-leak/);
  } finally { voice.dispose(); }
});

test('late setup and stale termination cannot replace or close a newer generation', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const voice = new ShowroomVoiceService({ apiKey: 'private-test-key', snapshot: () => snapshot,
    fetch: async () => { if (++calls === 1) await pending; return answer(); } });
  try {
    const first = voice.setup(sessionId, { sdp: 'v=0\r\nold', generation: 1 });
    const firstFailure = assert.rejects(first, /cancelled|current/);
    const second = await voice.setup(sessionId, { sdp: 'v=0\r\nnew', generation: 2 });
    voice.end(sessionId, 1);
    assert.equal(second.generation, 2);
    release(); await firstFailure;
    await assert.rejects(voice.setup(sessionId, { sdp: 'v=0\r\nreplay', generation: 2 }), /no longer current/);
  } finally { release(); voice.dispose(); }
});

test('voice errors never return raw provider errors and refusal is not fake voice success', async () => {
  const voice = new ShowroomVoiceService({ apiKey: 'private-test-key', snapshot: () => snapshot,
    fetch: async () => new Response('private-test-key provider diagnostics', { status: 401 }) });
  try {
    await assert.rejects(voice.setup(sessionId, { sdp: 'v=0\r\noffer' }), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /HTTP 401/);
      assert.doesNotMatch(error.message, /private-test-key|diagnostics/); return true;
    });
  } finally { voice.dispose(); }
});
