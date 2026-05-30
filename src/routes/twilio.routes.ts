/**
 * Twilio webhook endpoints. These are PUBLIC — Twilio cannot send our app
 * auth tokens, so the security boundary is the X-Twilio-Signature header
 * (validated against the workspace auth token + the canonical URL).
 *
 * Phase 1: receive + verify + log only. Phase 2 will route inbound texts to
 * the existing classify_reply pipeline and persist them as SMS messages.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../config/env';
import { validateTwilioSignature } from '../services/twilio.service';
import {
  findLeadByPhoneAnywhere,
  isStopKeyword,
  recordInboundSms,
} from '../services/sms.service';
import { processInboundReply } from '../services/reply.service';
import * as suppressionService from '../services/suppression.service';

const INBOUND_PATH = '/api/twilio/inbound';
const STATUS_PATH = '/api/twilio/status';

function publicUrlFor(fastifyPath: string): string {
  // Twilio signs against the exact URL it POSTed to (the publicly visible
  // one). nginx maps public `/x` → backend `/api/x`, so the URL Twilio used
  // is the fastify path with the leading `/api` stripped.
  const base = env().APP_BASE_URL.replace(/\/+$/, '');
  const publicPath = fastifyPath.replace(/^\/api/, '');
  return `${base}${publicPath}`;
}

function flattenParams(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof body === 'object' && body !== null) {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      out[k] = v == null ? '' : String(v);
    }
  }
  return out;
}

function signatureFrom(req: FastifyRequest): string | undefined {
  const sig = req.headers['x-twilio-signature'];
  return Array.isArray(sig) ? sig[0] : sig;
}

export async function registerTwilioRoutes(app: FastifyInstance): Promise<void> {
  // Inbound SMS from a lead.
  app.post(INBOUND_PATH, async (req, reply) => {
    const params = flattenParams(req.body);
    if (!validateTwilioSignature({
      url: publicUrlFor(INBOUND_PATH),
      params,
      signature: signatureFrom(req),
    })) {
      req.log.warn({ from: params.From, sid: params.MessageSid }, 'twilio inbound: bad signature');
      reply.code(403);
      return { error: 'invalid signature' };
    }

    const from = params.From ?? '';
    const to = params.To ?? '';
    const body = params.Body ?? '';
    const sid = params.MessageSid ?? '';

    req.log.info(
      { from, to, sid, body: body.slice(0, 200), numMedia: params.NumMedia },
      'twilio inbound message',
    );

    // STOP / UNSUBSCRIBE etc. — suppress the lead's address (and close the
    // lead) so we never re-engage. Twilio also blocks future sends at the
    // carrier level, but mirroring here keeps the cold-start picker honest.
    if (isStopKeyword(body)) {
      try {
        const lead = await findLeadByPhoneAnywhere(from);
        if (lead) {
          await suppressionService.suppressEmailAndCloseLeads(
            lead.workspaceId,
            lead.email,
            'sms_stop_keyword',
          );
          req.log.info({ leadId: lead.id, from }, 'sms STOP — suppressed + closed');
        }
      } catch (err) {
        req.log.error({ err, from }, 'sms STOP handling failed');
      }
      reply.header('Content-Type', 'text/xml');
      return '<?xml version="1.0" encoding="UTF-8"?><Response/>';
    }

    // Persist + route through the existing reply pipeline (one brain for
    // both channels). Failures here must not break the webhook — Twilio
    // retries on non-2xx, which would dupe.
    try {
      const res = await recordInboundSms({
        fromNumber: from,
        toNumber: to,
        body,
        twilioMessageSid: sid,
      });
      if (res?.newInboundReply) {
        // Fire-and-forget — Twilio's webhook timeout is short, the classify
        // + auto-reply can take several seconds. Errors are logged inside.
        processInboundReply({
          workspaceId: res.lead.workspaceId,
          threadId: res.newInboundReply.threadId,
          leadId: res.newInboundReply.leadId,
          campaignId: res.newInboundReply.campaignId,
        }).catch((err) =>
          req.log.error({ err, leadId: res.lead.id }, 'sms reply pipeline failed'),
        );
      }
    } catch (err) {
      req.log.error({ err, from, sid }, 'sms inbound persistence failed');
    }

    reply.header('Content-Type', 'text/xml');
    return '<?xml version="1.0" encoding="UTF-8"?><Response/>';
  });

  // Delivery status callbacks (queued → sent → delivered / failed).
  app.post(STATUS_PATH, async (req, reply) => {
    const params = flattenParams(req.body);
    if (!validateTwilioSignature({
      url: publicUrlFor(STATUS_PATH),
      params,
      signature: signatureFrom(req),
    })) {
      reply.code(403);
      return { error: 'invalid signature' };
    }

    req.log.info(
      {
        sid: params.MessageSid,
        status: params.MessageStatus,
        errorCode: params.ErrorCode,
        errorMessage: params.ErrorMessage,
      },
      'twilio status callback',
    );

    reply.code(204);
    return '';
  });
}
