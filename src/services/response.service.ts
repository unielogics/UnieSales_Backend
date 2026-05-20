import type { ErrorDetail } from '../utils/errors.js';

export interface ApiSuccess<T> {
  success: true;
  data: T;
  message: string;
  errors: never[];
}

export interface ApiError {
  success: false;
  data: null;
  message: string;
  errors: ErrorDetail[];
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiError;

export function ok<T>(data: T, message = 'OK'): ApiSuccess<T> {
  return { success: true, data, message, errors: [] };
}

export function fail(message: string, errors: ErrorDetail[] = []): ApiError {
  return { success: false, data: null, message, errors };
}

/**
 * True when payload already conforms to the envelope contract — used by the
 * Fastify onSend hook to avoid double-wrapping handlers that opt to return
 * envelopes directly.
 */
export function isEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.success === 'boolean' &&
    'data' in v &&
    typeof v.message === 'string' &&
    Array.isArray(v.errors)
  );
}
