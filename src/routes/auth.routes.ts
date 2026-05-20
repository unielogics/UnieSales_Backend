import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getUserById, login, publicUser, register } from '../services/auth.service';
import { requireAuth } from '../middleware/auth';
import { NotFoundError, ValidationError } from '../utils/errors';
import { ok } from '../services/response.service';

const RegisterSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12, 'password must be at least 12 chars').max(200),
  name: z.string().min(1).max(120).optional(),
});

const LoginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(
      'Validation failed',
      result.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return result.data;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/register', async (req, reply) => {
    const input = parseBody(RegisterSchema, req.body);
    const { user, token } = await register(input);
    reply.code(201);
    return ok({ user: publicUser(user), token }, 'Registered');
  });

  app.post('/api/auth/login', async (req) => {
    const input = parseBody(LoginSchema, req.body);
    const { user, token } = await login(input);
    return ok({ user: publicUser(user), token }, 'Logged in');
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
    if (!req.user) throw new NotFoundError('User not found');
    const user = await getUserById(req.user.id);
    if (!user) throw new NotFoundError('User not found');
    return ok({ user: publicUser(user) });
  });
}
