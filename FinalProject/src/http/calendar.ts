import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  CalendarSchedulingService, createAppointmentDraft, FileCalendarReceiptStore, FileOAuthTokenStore,
  GoogleCalendarProvider, GoogleOAuthClient, type CalendarConfig,
} from '../calendar/index.js';
import type { ShowroomCalendar } from '../orchestrator/showroom.js';
import { ApiError } from '../orchestrator/errors.js';
import { bearer, tokenMatches } from './auth.js';
import { jsonBody } from './app.js';

export function createCalendarIntegration(config: CalendarConfig, operatorToken: string | undefined, root: string): {
  service?: ShowroomCalendar; router?: Hono;
} {
  if (config.provider === 'disabled') return {};
  if (!operatorToken || config.durationMinutes !== 60 || !config.location.trim() || config.staffEmails.length > 19) {
    throw new ApiError(503, 'CALENDAR_CONFIGURATION', 'Showroom scheduling requires an operator token, 60-minute duration, location and at most 19 staff invitees.');
  }
  const oauth = new GoogleOAuthClient(config, { tokens: new FileOAuthTokenStore(resolve(root, '.runtime', 'calendar-auth')) });
  const calendar = new CalendarSchedulingService(config, {
    provider: new GoogleCalendarProvider(config, { auth: oauth }),
    receipts: new FileCalendarReceiptStore(resolve(root, '.runtime', 'calendar-receipts')),
  });
  const router = new Hono();
  router.use('/v1/operator/calendar/*', async (context, next) => {
    if (!tokenMatches(bearer(context.req.header('authorization')), operatorToken)) {
      throw new ApiError(401, 'OPERATOR_AUTH_REQUIRED', 'An authenticated operator is required for calendar setup or cancellation.');
    }
    await next();
  });
  const callback = new URL(config.redirectUri);
  router.post('/v1/operator/calendar/authorize', async context => {
    z.object({}).strict().parse(await jsonBody(context.req.raw, 128));
    const binding = randomBytes(32).toString('base64url');
    const result = oauth.beginAuthorization(binding);
    context.header('set-cookie', `showroom_calendar_binding=${binding}; HttpOnly; SameSite=Lax; Path=${callback.pathname}; Max-Age=600`);
    return context.json(result);
  });
  router.get(callback.pathname, async context => {
    const cookies = (context.req.header('cookie') ?? '').split(';').map(value => value.trim())
      .filter(value => value.startsWith('showroom_calendar_binding='));
    if (cookies.length !== 1) throw new ApiError(401, 'CALENDAR_OAUTH_BINDING', 'Return using the browser that initiated operator authorization.');
    const binding = cookies[0]!.slice('showroom_calendar_binding='.length);
    context.header('set-cookie', `showroom_calendar_binding=; HttpOnly; SameSite=Lax; Path=${callback.pathname}; Max-Age=0`);
    return context.json(await oauth.exchangeCallback(context.req.url, binding));
  });
  router.post('/v1/operator/calendar/appointments/:confirmationId/cancel', async context => {
    const { confirmed } = z.object({ confirmed: z.literal(true) }).strict().parse(await jsonBody(context.req.raw, 128));
    const confirmationId = z.uuid().parse(context.req.param('confirmationId'));
    return context.json(await calendar.cancel({ confirmationId, confirmed }));
  });
  return {
    router,
    service: {
      draft: (input, product) => createAppointmentDraft(config, { ...input, productId: product.id, productName: product.name }),
      checkAvailability: draft => calendar.checkAvailability({ ...draft, attendees: [...draft.attendees] }),
      confirm: input => calendar.confirm({ ...input, draft: { ...input.draft, attendees: [...input.draft.attendees] } }),
    },
  };
}
