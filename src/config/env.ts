import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  APP_BASE_URL: z.string().url().default('http://localhost:4000'),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_SECRET_ID: z.string().default('uniesales/prod/app'),
  S3_BUCKET: z.string().default('uniesales-prod-files'),

  ANTHROPIC_API_KEY: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  ANTHROPIC_MODEL_LIGHT: z.string().default('claude-haiku-4-5'),
  ANTHROPIC_MODEL_HEAVY: z.string().default('claude-sonnet-4-6'),

  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_REDIRECT_URI: z.string().default(''),

  HUBSPOT_CLIENT_ID: z.string().default(''),
  HUBSPOT_CLIENT_SECRET: z.string().default(''),

  // Twilio (SMS channel). FROM_NUMBER is the E.164 number used for outbound;
  // MESSAGING_SERVICE_SID is preferred when set (carries 10DLC + opt-out + pooling).
  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  TWILIO_FROM_NUMBER: z.string().default(''),
  TWILIO_MESSAGING_SERVICE_SID: z.string().default(''),

  JWT_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),

  AUTO_REPLY_DEFAULT: z.coerce.boolean().default(false),
  AUTO_REPLY_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  DEFAULT_SEND_LIMIT_PER_INBOX: z.coerce.number().int().positive().default(25),

  CORS_ORIGINS: z.string().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Shared secret used to verify HMAC signatures on the public uniecortex
  // intake endpoint (server-to-server mirror from CortexBackend). The same
  // value is provisioned out-of-band into the Cortex deploy so its requests
  // can be signed with HMAC-SHA256. Optional in dev; required in production
  // for the cortex endpoint to accept anything.
  UNIESALES_INTAKE_HMAC_SECRET: z.string().default(''),

  // Firebase service-account JSON (stringified) for FCM push delivery to the
  // mobile app. Optional — when empty, notifications are still persisted but
  // no push is sent. Provisioned in Secrets Manager for Phase 3 (mobile push).
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().default(''),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Load env vars from a .env file if present (no `dotenv` dependency needed — minimal parser).
 * Tolerant to comments and quoted values. Does not overwrite existing process.env entries.
 */
function loadDotEnv(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf-8');
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

/**
 * Pull values from AWS Secrets Manager and merge into process.env without overwriting existing keys.
 * Existing env vars win — useful for local overrides.
 */
async function loadFromSecretsManager(region: string, secretId: string): Promise<void> {
  const client = new SecretsManagerClient({ region });
  const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!res.SecretString) return;
  const parsed: Record<string, string> = JSON.parse(res.SecretString);
  for (const [k, v] of Object.entries(parsed)) {
    if (v === '' || v == null) continue;
    if (!(k in process.env)) {
      process.env[k] = String(v);
    }
  }
}

let cached: Env | null = null;

export async function loadEnv(): Promise<Env> {
  if (cached) return cached;

  // 1. .env (local dev fallback)
  loadDotEnv(path.resolve(process.cwd(), '.env'));

  // 2. Secrets Manager (production / when AWS creds available)
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const secretId = process.env.AWS_SECRET_ID ?? 'uniesales/prod/app';
  const skipSecrets = process.env.SKIP_SECRETS_MANAGER === 'true';

  if (!skipSecrets) {
    try {
      await loadFromSecretsManager(region, secretId);
    } catch (err) {
      // In dev with no AWS creds this will fail — that's fine if .env has everything.
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          `Failed to load secrets from Secrets Manager (${secretId} in ${region}): ${(err as Error).message}`,
        );
      }
    }
  }

  // 3. Validate
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}

export function env(): Env {
  if (!cached) {
    throw new Error('env() called before loadEnv() — make sure to await loadEnv() at boot.');
  }
  return cached;
}
