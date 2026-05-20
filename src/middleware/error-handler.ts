import type { FastifyInstance, FastifyError } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';
import { fail } from '../services/response.service.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    // App-level errors carry their own status + structured errors[]
    if (err instanceof AppError) {
      req.log.warn({ err, path: req.url }, 'app error');
      return reply.status(err.statusCode).send(fail(err.publicMessage, err.errors));
    }

    // Zod parse failures from request validation
    if (err instanceof ZodError) {
      const errors = err.issues.map((i) => ({
        field: i.path.join('.') || undefined,
        reason: i.message,
      }));
      return reply.status(400).send(fail('Validation failed', errors));
    }

    // Fastify validation errors (from schema)
    if (err.validation) {
      const errors = err.validation.map((v) => ({
        field: v.instancePath?.replace(/^\//, '') || undefined,
        reason: v.message ?? 'invalid',
      }));
      return reply.status(400).send(fail('Validation failed', errors));
    }

    // Unhandled — log full stack but expose generic message
    req.log.error({ err, path: req.url }, 'unhandled error');
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    const message = status >= 500 ? 'Internal server error' : err.message;
    return reply.status(status).send(fail(message));
  });

  app.setNotFoundHandler((req, reply) => {
    return reply.status(404).send(fail(`Route not found: ${req.method} ${req.url}`));
  });
}
