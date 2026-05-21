import { google } from 'googleapis';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../config/db';
import { gmailAccounts } from '../db/schema/gmail-accounts';
import { authClientForAccount } from './gmail.service';
import { ConflictError, NotFoundError } from '../utils/errors';

export interface DriveSpreadsheet {
  id: string;
  name: string;
  modifiedTime: string | null;
  owners: { emailAddress: string; displayName: string | null }[];
  webViewLink: string | null;
}

export interface SheetTab {
  /** Tab title — what the Sheets API expects in A1 ranges */
  title: string;
  /** Tab gid — useful if the user wants to deep-link */
  sheetId: number;
}

/**
 * Pick the workspace's active Gmail account to use as the OAuth identity for
 * Drive/Sheets calls. For now we pick the first one — the UI doesn't yet let
 * the user choose which inbox owns a given source. Multi-inbox routing lands
 * with the calendar integration.
 */
async function pickAccount(workspaceId: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(gmailAccounts)
    .where(and(eq(gmailAccounts.workspaceId, workspaceId), eq(gmailAccounts.isActive, true)))
    .limit(1);
  const account = rows[0];
  if (!account) {
    throw new ConflictError('No connected Google account', [
      { field: 'gmailAccountId', reason: 'connect a Google account first via Settings' },
    ]);
  }
  return account;
}

/**
 * List every Google Sheet the connected account can see (owned or shared with).
 * Returns the most recently modified first, capped at `limit` per call.
 *
 * Requires the `drive.metadata.readonly` OAuth scope. If the token doesn't have
 * it (older connection from before we expanded scopes), Google returns 403
 * "insufficient permissions" — surface that to the caller with a clear message
 * so the UI can prompt a reconnect.
 */
export async function listSpreadsheets(
  workspaceId: string,
  opts: { q?: string; limit?: number; pageToken?: string } = {},
): Promise<{ files: DriveSpreadsheet[]; nextPageToken: string | null }> {
  const account = await pickAccount(workspaceId);
  const auth = await authClientForAccount(account);
  const drive = google.drive({ version: 'v3', auth });

  // Q syntax: limit to spreadsheets, exclude trashed; optional name fuzzy match
  let q = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
  if (opts.q) {
    // Sheet name contains the search term (case-insensitive)
    const escaped = opts.q.replace(/'/g, "\\'");
    q += ` and name contains '${escaped}'`;
  }

  try {
    const res = await drive.files.list({
      q,
      pageSize: Math.min(opts.limit ?? 50, 100),
      pageToken: opts.pageToken,
      fields: 'nextPageToken, files(id, name, modifiedTime, owners(emailAddress, displayName), webViewLink)',
      orderBy: 'modifiedByMeTime desc',
      // includeItemsFromAllDrives + supportsAllDrives lets us see shared-drive sheets too
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    return {
      files: (res.data.files ?? []).map((f) => ({
        id: f.id!,
        name: f.name ?? '(untitled)',
        modifiedTime: f.modifiedTime ?? null,
        owners: (f.owners ?? []).map((o) => ({
          emailAddress: o.emailAddress ?? '',
          displayName: o.displayName ?? null,
        })),
        webViewLink: f.webViewLink ?? null,
      })),
      nextPageToken: res.data.nextPageToken ?? null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Drive API call failed';
    if (msg.includes('insufficient') || msg.includes('403')) {
      throw new ConflictError(
        'Connected Google account lacks Drive list permission — disconnect and reconnect to grant the new scope',
        [{ field: 'oauth_scope', reason: 'drive.metadata.readonly missing on token' }],
      );
    }
    throw err;
  }
}

/**
 * List the tabs (sub-sheets) inside a given spreadsheet. The user picks which
 * tab to import from on the Lead Source step.
 */
export async function listSheetTabs(
  workspaceId: string,
  spreadsheetId: string,
): Promise<SheetTab[]> {
  const account = await pickAccount(workspaceId);
  const auth = await authClientForAccount(account);
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title))',
  });
  const tabs = (res.data.sheets ?? []).map((s) => ({
    title: s.properties?.title ?? '',
    sheetId: s.properties?.sheetId ?? 0,
  }));
  if (tabs.length === 0) throw new NotFoundError('Spreadsheet has no tabs');
  return tabs;
}

/**
 * Read all rows from a sheet tab and return as { header: value } objects,
 * keyed by the first row's column names. Empty rows are skipped.
 *
 * Used by lead-source.service.ts when importing a `google_sheet` source.
 */
export async function readSheetRows(
  workspaceId: string,
  spreadsheetId: string,
  tabTitle: string,
): Promise<Record<string, string>[]> {
  const account = await pickAccount(workspaceId);
  const auth = await authClientForAccount(account);
  const sheets = google.sheets({ version: 'v4', auth });

  // Pull everything (Google caps each request at 10MB so this is fine for typical
  // lead lists; we can paginate later if anyone has 50k+ row sheets).
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabTitle}!A:ZZ`,
  });
  const values = res.data.values ?? [];
  if (values.length === 0) return [];

  const headers = (values[0] ?? []).map((h) => String(h ?? '').trim());
  if (headers.length === 0) return [];

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    // Skip rows where every cell is empty
    if (row.every((c) => c == null || String(c).trim() === '')) continue;
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      if (!h) return;
      obj[h] = row[idx] != null ? String(row[idx]) : '';
    });
    rows.push(obj);
  }
  return rows;
}
