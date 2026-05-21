import { google, type Auth } from 'googleapis';
import { env } from './env';

/**
 * Scopes the backend asks for. One Google account = Gmail + Calendar + Drive
 * (drive.file = only files the app creates or the user explicitly opens with
 * it — least-privilege Drive scope).
 *
 * NOTE on incremental auth: Google rejects re-prompts that drop scopes. If you
 * trim this list, existing tokens still work but new connects only get the
 * narrower set. Always run a full re-OAuth (disconnect + connect) when you
 * change scopes in a way that needs the broader grant.
 */
export const GOOGLE_OAUTH_SCOPES = [
  'openid',
  'email',
  'profile',
  // Gmail — send, draft, read, label
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.readonly',
  // Calendar — read + write events so the AI can book meetings
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  // Drive — only files created or opened by the app
  'https://www.googleapis.com/auth/drive.file',
  // Sheets — read-only, for Lead Source -> Google Sheet imports
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
