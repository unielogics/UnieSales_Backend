/**
 * Twilio SMS integration. Two responsibilities:
 *   1. sendSms — outbound text via Messaging Service (preferred) or from-number.
 *   2. validateTwilioSignature — verify the X-Twilio-Signature on incoming
 *      webhooks. Twilio webhooks are public endpoints; the signature IS the
 *      auth boundary, so this check is non-negotiable.
 */
import twilio, { type Twilio } from 'twilio';
import { env } from '../config/env';
import { createLogger } from '../config/logger';

const log = createLogger(process.env.LOG_LEVEL ?? 'info').child({ service: 'twilio' });

let cachedClient: Twilio | null = null;

function getClient(): Twilio {
  const e = env();
  if (!e.TWILIO_ACCOUNT_SID || !e.TWILIO_AUTH_TOKEN) {
    throw new Error('Twilio is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing)');
  }
  if (!cachedClient) cachedClient = twilio(e.TWILIO_ACCOUNT_SID, e.TWILIO_AUTH_TOKEN);
  return cachedClient;
}

export function twilioConfigured(): boolean {
  const e = env();
  return (
    !!e.TWILIO_ACCOUNT_SID &&
    !!e.TWILIO_AUTH_TOKEN &&
    (!!e.TWILIO_FROM_NUMBER || !!e.TWILIO_MESSAGING_SERVICE_SID)
  );
}

export interface SendSmsInput {
  /** Destination, E.164 (+15551234567). */
  to: string;
  /** Plain text body. SMS-safe length: ~160 chars / segment. */
  body: string;
  /** Twilio status callback URL — receives delivery receipts. */
  statusCallback?: string;
}

export interface SendSmsResult {
  sid: string;
  status: string;
}

export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  const e = env();
  const c = getClient();
  const useService = !!e.TWILIO_MESSAGING_SERVICE_SID;
  const message = await c.messages.create({
    to: input.to,
    body: input.body,
    ...(useService
      ? { messagingServiceSid: e.TWILIO_MESSAGING_SERVICE_SID }
      : { from: e.TWILIO_FROM_NUMBER }),
    ...(input.statusCallback ? { statusCallback: input.statusCallback } : {}),
  });
  log.info({ to: input.to, sid: message.sid, status: message.status }, 'sms sent');
  return { sid: message.sid, status: message.status };
}

/**
 * Validate Twilio's X-Twilio-Signature header. Per Twilio: HMAC-SHA1 of
 * the full request URL concatenated with alphabetically-sorted form params,
 * keyed by the Auth Token, then base64. SDK handles the math.
 */
export function validateTwilioSignature(opts: {
  url: string;
  params: Record<string, string>;
  signature: string | undefined;
}): boolean {
  if (!opts.signature) return false;
  const e = env();
  if (!e.TWILIO_AUTH_TOKEN) return false;
  try {
    return twilio.validateRequest(e.TWILIO_AUTH_TOKEN, opts.signature, opts.url, opts.params);
  } catch {
    return false;
  }
}
