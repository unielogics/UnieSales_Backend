import Anthropic from '@anthropic-ai/sdk';
import { env } from './env';

let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (client) return client;
  const apiKey = env().ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured in Secrets Manager');
  }
  client = new Anthropic({ apiKey });
  return client;
}
