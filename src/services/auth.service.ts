import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../config/db';
import { env } from '../config/env';
import { users, type User } from '../db/schema/users';
import { ConflictError, UnauthorizedError } from '../utils/errors';
import type { AuthedUser, JwtPayload } from '../types/api';

const SALT_ROUNDS = 12;
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signToken(user: Pick<User, 'id' | 'email'>): string {
  const { JWT_SECRET } = env();
  const payload: JwtPayload = { sub: user.id, email: user.email };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL_SECONDS });
}

export function verifyToken(token: string): AuthedUser {
  const { JWT_SECRET } = env();
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    if (!decoded.sub || !decoded.email) throw new Error('malformed token');
    return { id: decoded.sub, email: decoded.email };
  } catch {
    throw new UnauthorizedError('Invalid or expired token');
  }
}

export async function register(input: { email: string; password: string; name?: string }): Promise<{ user: User; token: string }> {
  const db = getDb();
  const normalizedEmail = input.email.trim().toLowerCase();

  const existing = await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);
  if (existing.length > 0) {
    throw new ConflictError('Email already registered', [{ field: 'email', reason: 'already in use' }]);
  }

  const passwordHash = await hashPassword(input.password);
  const inserted = await db
    .insert(users)
    .values({
      email: normalizedEmail,
      passwordHash,
      name: input.name ?? null,
    })
    .returning();

  const user = inserted[0]!;
  return { user, token: signToken(user) };
}

export async function login(input: { email: string; password: string }): Promise<{ user: User; token: string }> {
  const db = getDb();
  const normalizedEmail = input.email.trim().toLowerCase();

  const rows = await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);
  const user = rows[0];
  if (!user || !user.isActive) throw new UnauthorizedError('Invalid credentials');

  const ok = await verifyPassword(input.password, user.passwordHash);
  if (!ok) throw new UnauthorizedError('Invalid credentials');

  await db.update(users).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(users.id, user.id));
  return { user, token: signToken(user) };
}

export async function getUserById(id: string): Promise<User | null> {
  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Strip the password hash from a user before returning over the API. */
export function publicUser(user: User) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { passwordHash: _ph, ...rest } = user;
  return rest;
}
