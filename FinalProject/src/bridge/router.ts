import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import {
  BridgePairInputSchema, OperatorPairInputSchema, BridgeLeaseInputSchema, StopIntentSchema,
} from '../contracts/bridge.js';
import { BridgeBroker, BridgeError } from './broker.js';
import { assertLocalOperatorOrigins } from './origins.js';

function bearer(request: Request): string {
  return /^Bearer ([A-Za-z0-9_-]{24,256})$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
}
function secretMatches(actual: string, expected: string): boolean {
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
async function json(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
    throw new BridgeError(400, 'CONTENT_TYPE', 'Use application/json.');
  }
  if (!request.body) throw new BridgeError(400, 'INVALID_JSON', 'A JSON request body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8192) { await reader.cancel(); throw new BridgeError(400, 'BODY_LIMIT', 'Bridge request exceeds 8192 bytes.'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch {
    throw new BridgeError(400, 'INVALID_JSON', 'A valid JSON request body is required.');
  }
}
export function createBridgeRouter(options: {
  broker: BridgeBroker;
  operatorToken: string;
  allowedOrigins: readonly string[];
  authorizeSession(sessionId: string, token: string): boolean;
  onError?(code: string): void;
}) {
  if (options.operatorToken.length < 24 || !options.allowedOrigins.length) throw new Error('Bridge requires operator authentication and exact local origins.');
  assertLocalOperatorOrigins(options.allowedOrigins);
  const { broker } = options;
  const app = new Hono();
  const responseHeaders: MiddlewareHandler = async (context, next) => {
    context.header('Cache-Control', 'no-store');
    context.header('Referrer-Policy', 'no-referrer');
    await next();
  };
  const localOperatorOrigin: MiddlewareHandler = async (context, next) => {
    const origin = context.req.header('origin');
    if (origin && !options.allowedOrigins.includes(origin)) throw new BridgeError(403, 'ORIGIN_DENIED', 'Operator origin is not permitted.');
    if (origin) {
      context.header('Access-Control-Allow-Origin', origin);
      context.header('Vary', 'Origin');
      context.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      context.header('Access-Control-Allow-Headers', 'Authorization,Content-Type');
    }
    if (context.req.method === 'OPTIONS') return context.body(null, 204);
    await next();
  };
  for (const path of ['/v1/operator/bridges/*', '/v1/bridges/*']) {
    app.use(path, responseHeaders, localOperatorOrigin);
  }
  for (const path of ['/v1/sessions/:id/bridge', '/v1/sessions/:id/bridge/stop']) {
    app.use(path, responseHeaders);
  }
  app.onError((error, context) => {
    const status = error instanceof BridgeError ? error.status : error instanceof z.ZodError ? 400 : 500;
    const code = error instanceof BridgeError ? error.code : error instanceof z.ZodError ? 'INVALID_INPUT' : 'BRIDGE_FAILED';
    options.onError?.(code);
    return context.json({ error: { code, message: error instanceof BridgeError ? error.message : 'Bridge request failed validation or could not be completed.' } }, status);
  });
  function setup(request: Request): void {
    // Long-lived setup credentials never enter a browser context.
    if (request.headers.has('origin') || !secretMatches(bearer(request), options.operatorToken)) {
      throw new BridgeError(401, 'OPERATOR_SETUP_REQUIRED', 'Use authenticated local operator setup, not a browser, to issue one-time codes.');
    }
  }
  function browser(request: Request): void {
    if (!options.allowedOrigins.includes(request.headers.get('origin') ?? '')) {
      throw new BridgeError(403, 'ORIGIN_REQUIRED', 'An exact local operator-page origin is required.');
    }
  }
  app.post('/v1/operator/bridges', async (context) => {
    setup(context.req.raw);
    return context.json(broker.register(await json(context.req.raw)), 201);
  });
  app.post('/v1/operator/bridges/:bridgeId/operator-pairing', (context) => {
    setup(context.req.raw);
    return context.json(broker.operatorPairing(context.req.param('bridgeId')), 201);
  });
  app.post('/v1/bridges/:bridgeId/pair', async (context) => {
    browser(context.req.raw);
    const input = BridgePairInputSchema.parse(await json(context.req.raw));
    return context.json(broker.pair(context.req.param('bridgeId'), input.pairingCode));
  });
  app.post('/v1/bridges/:bridgeId/operator-pair', async (context) => {
    browser(context.req.raw);
    const input = OperatorPairInputSchema.parse(await json(context.req.raw));
    return context.json(broker.pairOperator(context.req.param('bridgeId'), input.operatorCode));
  });
  app.post('/v1/operator/bridges/:bridgeId/lease', async (context) => {
    browser(context.req.raw);
    const id = context.req.param('bridgeId');
    broker.authorize(id, bearer(context.req.raw), 'operator');
    return context.json(await broker.lease(id, BridgeLeaseInputSchema.parse(await json(context.req.raw))), 201);
  });
  app.post('/v1/operator/bridges/:bridgeId/stop', (context) => {
    browser(context.req.raw);
    const id = context.req.param('bridgeId');
    broker.authorize(id, bearer(context.req.raw), 'operator');
    return context.json({ command: broker.stopBridge(id) });
  });
  app.get('/v1/bridges/:bridgeId/status', (context) => {
    browser(context.req.raw);
    const id = context.req.param('bridgeId');
    broker.authorize(id, bearer(context.req.raw), 'bridge');
    return context.json(broker.status(id));
  });
  app.post('/v1/bridges/:bridgeId/renew', (context) => {
    browser(context.req.raw);
    return context.json(broker.renew(context.req.param('bridgeId'), bearer(context.req.raw)));
  });
  app.post('/v1/bridges/:bridgeId/heartbeats', async (context) => {
    browser(context.req.raw);
    const id = context.req.param('bridgeId');
    broker.authorize(id, bearer(context.req.raw), 'bridge');
    broker.heartbeat(id, await json(context.req.raw));
    return context.body(null, 204);
  });
  app.post('/v1/bridges/:bridgeId/acknowledgements', async (context) => {
    browser(context.req.raw);
    const id = context.req.param('bridgeId');
    broker.authorize(id, bearer(context.req.raw), 'bridge');
    broker.acknowledge(id, await json(context.req.raw));
    return context.body(null, 204);
  });
  app.get('/v1/sessions/:id/bridge', (context) => {
    if (!options.authorizeSession(context.req.param('id'), bearer(context.req.raw))) throw new BridgeError(401, 'SESSION_AUTH_REQUIRED', 'A current kiosk session credential is required.');
    return context.json(broker.sessionState(context.req.param('id')));
  });
  app.post('/v1/sessions/:id/bridge/stop', async (context) => {
    if (!options.authorizeSession(context.req.param('id'), bearer(context.req.raw))) throw new BridgeError(401, 'SESSION_AUTH_REQUIRED', 'A current kiosk session credential is required.');
    const input = StopIntentSchema.parse(await json(context.req.raw));
    return context.json({ command: broker.stopSession(context.req.param('id'), input.reason) });
  });
  return app;
}
