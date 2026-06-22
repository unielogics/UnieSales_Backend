/**
 * Public-intake routing — maps each (site, tag) tuple to the destination
 * workspace + campaign in UnieSales. The UUIDs MUST stay in lockstep with
 * scripts/seed-inbound-intake.sql. If you renumber a campaign there, update
 * here in the same commit or the public endpoint returns 400 on a valid POST.
 *
 * Why a static map and not a runtime DB lookup:
 *  - The intake endpoint must be fast (browser-facing) and resilient (a DB
 *    blip during a high-traffic moment shouldn't drop leads).
 *  - The set of 9 forms is closed for v1; a new form == one PR (enum + seed
 *    row + map entry) which is the right cadence.
 */

export const INTAKE_WORKSPACE_ID = '00000000-0000-4000-a000-000000000001';

export const INTAKE_SITES = ['uniewms', 'unielogics', 'uniecortex'] as const;
export type IntakeSite = (typeof INTAKE_SITES)[number];

// Per-site tag enums — the Zod validators on the routes reference these. A
// payload whose `tag` isn't in the per-site list returns 400 before any DB work.
export const SITE_TAGS = {
  uniewms: ['talk_to_sales', 'broker_apply', 'warehouse_review'],
  unielogics: [
    'audit',
    'join',
    'get_started',
    'developer',
    // Added 2026-05-26 alongside the unielogics.com form rewire (commit 70b71b9).
    'industry_problems',
    'products_inquiry',
    'services_inquiry',
  ],
  uniecortex: ['audit_request', 'partner_application', 'website_catalog_audit'],
} as const satisfies Record<IntakeSite, readonly string[]>;

export type UniewmsTag = (typeof SITE_TAGS.uniewms)[number];
export type UnielogicsTag = (typeof SITE_TAGS.unielogics)[number];
export type UniecortexTag = (typeof SITE_TAGS.uniecortex)[number];

// (site, tag) → campaign UUID. Keys are `${site}.${tag}` for type-safe lookup.
export const SOURCE_ROUTING: Record<string, { workspaceId: string; campaignId: string }> = {
  'uniewms.talk_to_sales':           { workspaceId: INTAKE_WORKSPACE_ID, campaignId: '00000000-0000-4001-a000-000000000001' },
  'uniewms.broker_apply':            { workspaceId: INTAKE_WORKSPACE_ID, campaignId: '00000000-0000-4001-a000-000000000002' },
  'uniewms.warehouse_review':        { workspaceId: INTAKE_WORKSPACE_ID, campaignId: '00000000-0000-4001-a000-000000000003' },
  'unielogics.audit':                { workspaceId: INTAKE_WORKSPACE_ID, campaignId: '00000000-0000-4001-a000-000000000004' },
  'unielogics.join':                 { workspaceId: INTAKE_WORKSPACE_ID, campaignId: '00000000-0000-4001-a000-000000000005' },
  'unielogics.get_started':          { workspaceId: INTAKE_WORKSPACE_ID, campaignId: '00000000-0000-4001-a000-000000000006' },
  'unielogics.developer':            { workspaceId: INTAKE_WORKSPACE_ID, campaignId: '00000000-0000-4001-a000-000000000007' },
  'uniecortex.audit_request':        { workspaceId: INTAKE_WORKSPACE_ID, campaignId: '00000000-0000-4001-a000-000000000008' },
  'uniecortex.partner_application':  { workspaceId: INTAKE_WORKSPACE_ID, campaignId: '00000000-0000-4001-a000-000000000009' },
  'uniecortex.website_catalog_audit': { workspaceId: INTAKE_WORKSPACE_ID, campaignId: '00000000-0000-4001-a000-000000000013' },
  // Added 2026-05-26 — unielogics.com form expansion. Suffixes continue sequentially.
  'unielogics.industry_problems':    { workspaceId: INTAKE_WORKSPACE_ID, campaignId: '00000000-0000-4001-a000-000000000010' },
  'unielogics.products_inquiry':     { workspaceId: INTAKE_WORKSPACE_ID, campaignId: '00000000-0000-4001-a000-000000000011' },
  'unielogics.services_inquiry':     { workspaceId: INTAKE_WORKSPACE_ID, campaignId: '00000000-0000-4001-a000-000000000012' },
};

export function lookupRouting(site: IntakeSite, tag: string): { workspaceId: string; campaignId: string } | null {
  return SOURCE_ROUTING[`${site}.${tag}`] ?? null;
}

/**
 * Origin validator for `@fastify/cors`. Accepts:
 *  - Exact-match hosts on the three sites and the existing app domain
 *  - Any subdomain of amplifyapp.com (AWS Amplify preview deploys)
 * Returns true if allowed; false otherwise → no Access-Control-Allow-Origin header.
 */
export function isAllowedIntakeOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  const exact = new Set([
    'app.uniesales.com',
    'uniewms.com',
    'www.uniewms.com',
    'unielogics.com',
    'www.unielogics.com',
  ]);
  if (exact.has(host)) return true;
  // Amplify preview subdomains: <branch>.<app-id>.amplifyapp.com
  if (host.endsWith('.amplifyapp.com')) return true;
  return false;
}
