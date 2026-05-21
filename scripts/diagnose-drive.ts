/**
 * One-off diagnostic: connect to RDS, grab the workspace's Gmail account,
 * call Drive API with various queries, dump the raw result so we can see
 * exactly what Google returns.
 *
 * Run: cd /opt/uniesales/UnieSales_Backend && npx tsx scripts/diagnose-drive.ts <workspaceId>
 */
import { loadEnv } from '../src/config/env';
import { initDb, getDb, closeDb } from '../src/config/db';
import { gmailAccounts } from '../src/db/schema/gmail-accounts';
import { workspaces } from '../src/db/schema/workspaces';
import { and, eq } from 'drizzle-orm';
import { authClientForAccount } from '../src/services/gmail.service';
import { google } from 'googleapis';

async function main() {
  const workspaceId = process.argv[2];
  if (!workspaceId) {
    console.error('Usage: npx tsx scripts/diagnose-drive.ts <workspaceId>');
    process.exit(1);
  }

  await loadEnv();
  initDb();
  const db = getDb();

  const ws = (
    await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
  )[0];
  console.log('Workspace:', ws?.name ?? '(not found)');

  const account = (
    await db
      .select()
      .from(gmailAccounts)
      .where(and(eq(gmailAccounts.workspaceId, workspaceId), eq(gmailAccounts.isActive, true)))
      .limit(1)
  )[0];
  if (!account) {
    console.error('No connected Gmail account on this workspace');
    process.exit(1);
  }
  console.log('Account email:', account.email);
  console.log('Token expiry:', account.tokenExpiry);
  console.log('Has refresh token:', !!account.refreshTokenEncrypted);

  const auth = await authClientForAccount(account);

  // 1. Token info — see what scopes are actually granted
  try {
    const tokenInfo = await auth.getAccessToken();
    const url = `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${tokenInfo.token}`;
    const res = await fetch(url);
    const info = await res.json();
    console.log('\n--- TOKEN INFO ---');
    console.log(JSON.stringify(info, null, 2));
  } catch (err) {
    console.error('tokeninfo failed:', err);
  }

  const drive = google.drive({ version: 'v3', auth });

  // 2. Plain list — no orderBy
  console.log('\n--- LIST: just mimeType filter, no orderBy ---');
  try {
    const res = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
      pageSize: 10,
      fields: 'files(id, name, ownedByMe, owners(emailAddress, displayName), modifiedTime)',
    });
    console.log('count:', res.data.files?.length ?? 0);
    console.log(JSON.stringify(res.data.files, null, 2));
  } catch (err) {
    console.error('list failed:', err);
  }

  // 3. With shared-drive flags
  console.log('\n--- LIST: with includeItemsFromAllDrives + supportsAllDrives ---');
  try {
    const res = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
      pageSize: 10,
      fields: 'files(id, name, ownedByMe, owners(emailAddress, displayName))',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    console.log('count:', res.data.files?.length ?? 0);
    console.log(JSON.stringify(res.data.files, null, 2));
  } catch (err) {
    console.error('list with all-drives failed:', err);
  }

  // 4. ALL files (not just sheets), to confirm Drive sees anything at all
  console.log('\n--- LIST: ANY file (first 5) just to prove Drive sees anything ---');
  try {
    const res = await drive.files.list({
      pageSize: 5,
      fields: 'files(id, name, mimeType, ownedByMe)',
    });
    console.log('count:', res.data.files?.length ?? 0);
    console.log(JSON.stringify(res.data.files, null, 2));
  } catch (err) {
    console.error('any-file list failed:', err);
  }

  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
