import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { verifyToken } from '../services/auth.service';
import { UnauthorizedError } from '../utils/errors';

/**
 * preHandler that requires a valid Bearer token and attaches req.user.
 * Throw to short-circuit; the global error handler will format the envelope.
 */
export const requireAuth: preHandlerHookHandler = async (req: FastifyRequest, _reply: FastifyReply) => {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    throw new UnauthorizedError('Missing bearer token');
  }
  const token = header.slice('bearer '.length).trim();
  if (!token) throw new UnauthorizedError('Missing bearer token');

  req.user = verifyToken(token);
};
