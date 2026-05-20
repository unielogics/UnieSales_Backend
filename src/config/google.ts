import { google, type Auth } from 'googleapis';
import { env } from './env';

/**
 * Scopes the backend asks for. Trim down before production launch if a tighter
 * scope set works (e.g. drop gmail.modify when label updates aren't needed).
 */
export const GOOGLE_OAUTH_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
] as const;

export function newOAuthClient(): Auth.OAuth2Client {
  const e = env();
  return new google.auth.OAuth2(e.GOOGLE_CLIENT_ID, e.GOOGLE_CLIENT_SECRET, e.GOOGLE_REDIRECT_URI);
}

/** Pre-authorised client built from previously-saved (decrypted) tokens. */
export function clientWithTokens(input: {
  accessToken: string;
  refreshToken: string | null;
  expiryDate: Date | null;
}): Auth.OAuth2Client {
  const c = newOAuthClient();
  c.setCredentials({
    access_token: input.accessToken,
    refresh_token: input.refreshToken ?? undefined,
    expiry_date: input.expiryDate?.getTime(),
  });
  return c;
}
