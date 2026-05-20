import pino, { type LoggerOptions } from 'pino';

export function pinoOptions(level = 'info'): LoggerOptions {
  return {
    level,
    base: undefined, // drop pid/hostname noise
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.password_hash',
        '*.access_token',
        '*.refresh_token',
        '*.access_token_encrypted',
        '*.refresh_token_encrypted',
        '*.JWT_SECRET',
        '*.ENCRYPTION_KEY',
        '*.ANTHROPIC_API_KEY',
        '*.OPENAI_API_KEY',
        '*.GOOGLE_CLIENT_SECRET',
        '*.HUBSPOT_CLIENT_SECRET',
      ],
      remove: true,
    },
  };
}

/**
 * Standalone logger for non-Fastify code (workers, scripts).
 * Fastify constructs its own pino internally from pinoOptions().
 */
export function createLogger(level = 'info') {
  return pino(pinoOptions(level));
}
