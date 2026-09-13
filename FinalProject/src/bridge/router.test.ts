import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Hono } from 'hono';
import { BridgeCredentialSchema, BridgePairingSchema, OperatorCredentialSchema, OperatorPairingSchema } from '../contracts/bridge.js';
import { BridgeBroker } from './broker.js';
import { createBridgeRouter } from './router.js';

const publicOrigin = 'https://showroom.example';
const operatorOrigin = 'http://127.0.0.1:3202';
const setupToken = 's'.repeat(32);

function composedApp(bridgeEnabled: boolean) {
  const app = new Hono();
  const sessionId = randomUUID(), sessionToken = 'k'.repeat(32);
  const broker = new BridgeBroker({ sessionSafety: () => ({ active: true, motionConsent: true }) });
  let unusedKioskCode = 'KIOSK123';
  app.use('*', async (context, next) => {
    const origin = context.req.header('origin');
    if (origin && ![publicOrigin, operatorOrigin].includes(origin)) return context.json({ source: 'outer-origin' }, 403);
    if (origin) context.header('Access-Control-Allow-Origin', origin);
    await next();
  });
  app.onError((_error, context) => context.json({ source: 'outer-error' }, 418));
  if (bridgeEnabled) app.route('/', createBridgeRouter({
    broker, operatorToken: setupToken, allowedOrigins: [operatorOrigin],
    authorizeSession: (id, token) => id === sessionId && token === sessionToken,
  }));
  app.post('/v1/kiosk/pair', async (context) => {
    const input: unknown = await context.req.json();
    if (!unusedKioskCode || !input || typeof input !== 'object' || !('pairingCode' in input)
      || input.pairingCode !== unusedKioskCode) return context.json({ source: 'kiosk-pairing-denied' }, 401);
    unusedKioskCode = '';
    return context.json({ sessionId, sessionToken }, 201);
  });
  app.get('/healthz', (context) => context.json({ source: 'health' }));
  app.get('/oauth/google/callback', (context) => context.redirect('/operator/calendar', 302));
  app.get('/unrelated', (context) => context.json({ source: 'unrelated' }));
  app.options('/unrelated', (context) => context.text('outer-preflight', 200));
  app.get('/unrelated-error', () => { throw new Error('Owned by the enclosing application.'); });
  function request(path: string, options: { method?: string; body?: unknown; token?: string; origin?: string } = {}) {
    return app.request(`http://127.0.0.1:3101${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.origin ? { Origin: options.origin } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }
  return { broker, sessionId, sessionToken, request };
}

test('root-mounted bridge preserves public HTTPS kiosk pairing with bridge disabled and enabled', async (t) => {
  for (const enabled of [false, true]) {
    const fixture = composedApp(enabled);
    t.after(() => fixture.broker.close());
    const response = await fixture.request('/v1/kiosk/pair', {
      method: 'POST', origin: publicOrigin, body: { pairingCode: 'KIOSK123' },
    });
    assert.equal(response.status, 201, `bridgeEnabled=${enabled}`);
    assert.equal(response.headers.get('access-control-allow-origin'), publicOrigin);
    assert.deepEqual(await response.json(), { sessionId: fixture.sessionId, sessionToken: fixture.sessionToken });
    assert.equal((await fixture.request('/v1/kiosk/pair', {
      method: 'POST', origin: publicOrigin, body: { pairingCode: 'KIOSK123' },
    })).status, 401, 'The bridge does not bypass the kiosk one-time code gate');
  }
});

test('composition retains strict local operator origins, role credentials and kiosk session authentication', async (t) => {
  const fixture = composedApp(true);
  t.after(() => fixture.broker.close());
  const registration = { label: 'Composition test', platform: 'windows-chrome' };
  assert.equal((await fixture.request('/v1/operator/bridges', {
    method: 'POST', origin: publicOrigin, token: setupToken, body: registration,
  })).status, 403);
  assert.equal((await fixture.request('/v1/operator/bridges', {
    method: 'POST', origin: operatorOrigin, token: setupToken, body: registration,
  })).status, 401, 'Long-lived setup still cannot run from a browser');
  const registered = await fixture.request('/v1/operator/bridges', { method: 'POST', token: setupToken, body: registration });
  assert.equal(registered.status, 201);
  const pairing = BridgePairingSchema.parse(await registered.json());
  const operatorPairingResponse = await fixture.request(`/v1/operator/bridges/${pairing.bridgeId}/operator-pairing`, { method: 'POST', token: setupToken });
  const operatorPairing = OperatorPairingSchema.parse(await operatorPairingResponse.json());
  assert.equal((await fixture.request(`/v1/bridges/${pairing.bridgeId}/pair`, {
    method: 'POST', origin: publicOrigin, body: { pairingCode: pairing.pairingCode },
  })).status, 403);
  const paired = await fixture.request(`/v1/bridges/${pairing.bridgeId}/pair`, {
    method: 'POST', origin: operatorOrigin, body: { pairingCode: pairing.pairingCode },
  });
  assert.equal(paired.status, 200);
  const bridgeCredential = BridgeCredentialSchema.parse(await paired.json());
  const operatorPaired = await fixture.request(`/v1/bridges/${pairing.bridgeId}/operator-pair`, {
    method: 'POST', origin: operatorOrigin, body: { operatorCode: operatorPairing.operatorCode },
  });
  const operatorCredential = OperatorCredentialSchema.parse(await operatorPaired.json());
  const stopPath = `/v1/operator/bridges/${pairing.bridgeId}/stop`;
  assert.equal((await fixture.request(stopPath, { method: 'POST', origin: publicOrigin, token: operatorCredential.operatorToken })).status, 403);
  assert.equal((await fixture.request(stopPath, { method: 'POST', origin: operatorOrigin, token: bridgeCredential.bridgeToken })).status, 401);
  assert.equal((await fixture.request(stopPath, { method: 'POST', origin: operatorOrigin, token: operatorCredential.operatorToken })).status, 200);
  assert.equal((await fixture.request(`/v1/sessions/${fixture.sessionId}/bridge`, { origin: publicOrigin })).status, 401);
  assert.equal((await fixture.request(`/v1/sessions/${fixture.sessionId}/bridge`, { origin: publicOrigin, token: fixture.sessionToken })).status, 200);
});

test('root-mounted bridge does not intercept health, OAuth, unrelated preflight or outer errors', async (t) => {
  const fixture = composedApp(true);
  t.after(() => fixture.broker.close());
  for (const [path, source] of [['/healthz', 'health'], ['/unrelated', 'unrelated']]) {
    const response = await fixture.request(path!, { origin: publicOrigin });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { source });
    assert.equal(response.headers.has('referrer-policy'), false, 'Unrelated responses do not get bridge headers');
  }
  const oauth = await fixture.request('/oauth/google/callback', { origin: publicOrigin });
  assert.equal(oauth.status, 302);
  assert.equal(oauth.headers.get('location'), '/operator/calendar');
  for (const origin of [publicOrigin, operatorOrigin]) {
    const response = await fixture.request('/unrelated', { method: 'OPTIONS', origin });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'outer-preflight');
  }
  const error = await fixture.request('/unrelated-error', { origin: publicOrigin });
  assert.equal(error.status, 418);
  assert.deepEqual(await error.json(), { source: 'outer-error' });
});
