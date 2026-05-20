# UnieSales Frontend API Reference

This is the contract the **UnieSales_FrontEnd** Claude Code track wires against. Every backend route is listed here with method, auth, body, and response shape. Statuses, classifications, and other enums are at the bottom.

- Production base URL: `http://54.235.111.20` (will become `https://api.<your-domain>` once DNS + cert land)
- Local dev: `http://localhost:4000`
- All bodies are JSON unless explicitly marked `multipart/form-data`
- All IDs are UUID v4 strings
- All timestamps are ISO-8601 UTC strings

---

## 1. Conventions

### 1.1 Response envelope

Every endpoint returns this exact shape — success or failure. Build one `ApiEnvelope<T>` type in your client and use it everywhere.

```ts
type ApiSuccess<T> = { success: true;  data: T;    message: string; errors: [] };
type ApiError     = { success: false; data: null; message: string; errors: ErrorDetail[] };
type ErrorDetail  = { field?: string; reason: string };
type ApiEnvelope<T> = ApiSuccess<T> | ApiError;
```

Treat `success: false` as the **only** failure signal — don't branch on HTTP status alone. Status codes still follow REST conventions (400 / 401 / 403 / 404 / 409 / 500).

Examples:

```jsonc
// 200 OK
{ "success": true,  "data": { "lead": {...} }, "message": "OK", "errors": [] }

// 400 Bad Request
{ "success": false, "data": null, "message": "Validation failed",
  "errors": [{ "field": "email", "reason": "Invalid email" }] }

// 409 Conflict (campaign activation gate)
{ "success": false, "data": null, "message": "Campaign cannot be activated yet",
  "errors": [
    { "field": "goal", "reason": "campaign goal not defined" },
    { "field": "playbook", "reason": "campaign playbook has not been approved" }
  ] }
```

### 1.2 Auth header

Every endpoint except `/health`, `/`, `POST /api/auth/register`, `POST /api/auth/login`, and `GET /api/auth/google/callback` requires:

```
Authorization: Bearer <jwt>
```

JWT TTL is 7 days. Store it in memory + a `HttpOnly` cookie or `localStorage` (your choice; CORS allows credentials).

### 1.3 Workspace path param

Anything workspace-scoped lives under `/api/workspaces/:workspaceId/...`. The backend validates that `req.user` is a member; non-members get 403. Use this guarantee in the UI — once the user picked a workspace, every call carries the ID in the path.

### 1.4 Roles

Per-workspace roles: `owner` > `admin` > `viewer`.

| Action | Min role |
|---|---|
| Read everything | viewer |
| Create / update / delete most resources | admin |
| Workspace creation (`POST /api/workspaces`) | any authenticated user (becomes `owner` of the new workspace) |

Each endpoint below tags the **min role** it needs.

### 1.5 Pagination

List endpoints that paginate use these query params:

| Param | Default | Max |
|---|---|---|
| `limit` | 50 | 500 |
| `offset` | 0 | — |

Responses include `total` (when meaningful), `limit`, and `offset`.

### 1.6 Error fields

`errors[].field` is dot-notated (`fieldMapping.email`, `campaign.status`). The frontend can map these directly to form fields.

---

## 2. Quick-start auth flow

```ts
// 1. Register (first user becomes the owner of any workspace they later create)
POST /api/auth/register
Body:    { email, password, name? }
Returns: { user: User (no passwordHash), token: string }

// 2. Login
POST /api/auth/login
Body:    { email, password }
Returns: { user, token }

// 3. Use the token on every subsequent call
fetch('/api/workspaces', { headers: { Authorization: `Bearer ${token}` } });

// 4. Refresh user state (e.g. on app boot if you stored the token)
GET /api/auth/me
Returns: { user }
```

`password` requires ≥ 12 characters. `email` is normalized to lowercase server-side.

---

## 3. Endpoints

> **Legend.** **Auth:** `🟢 public` · `🔵 authed` (Bearer required) · `🟣 member` (workspace member) · `🟠 admin` (workspace admin or owner).

### 3.1 Health

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | 🟢 | Returns `{ success, status, database, timestamp, ... }`. Use for load-balancer probes only. |
| GET | `/` | 🟢 | Returns `{ name: "uniesales-api", version: "0.1.0" }`. |

### 3.2 Auth

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/api/auth/register` | 🟢 | `{ email, password, name? }` | `{ user, token }` |
| POST | `/api/auth/login` | 🟢 | `{ email, password }` | `{ user, token }` |
| GET | `/api/auth/me` | 🔵 | — | `{ user }` |

### 3.3 Workspaces

| Method | Path | Auth | Body / Notes | Returns |
|---|---|---|---|---|
| GET | `/api/workspaces` | 🔵 | List workspaces the caller belongs to | `{ workspaces: (Workspace & { role })[] }` |
| POST | `/api/workspaces` | 🔵 | Caller auto-becomes owner of the new workspace. | `{ workspace }` |
| GET | `/api/workspaces/:wid` | 🟣 | — | `{ workspace, role }` |
| PATCH | `/api/workspaces/:wid` | 🟠 | Any subset of workspace fields incl. `isActive`. **Use `isActive: false` instead of DELETE.** | `{ workspace }` |
| GET | `/api/workspaces/:wid/dashboard` | 🟣 | Aggregate counts | `DashboardSummary` (see §4.4) |

**Create body (`POST /api/workspaces`):**

```ts
{
  name: string,                          // required
  companyName: string,                   // required
  brandName?: string,
  industry?: string,
  website?: string,
  defaultFromEmail?: string,
  defaultSenderName?: string,
  defaultBookingLink?: string,
  notificationEmail?: string,
  autoReplyEnabled?: boolean,
  autoReplyConfidenceThreshold?: number  // 0..1
}
```

`Workspace` shape:

```ts
{
  id: string, name: string, companyName: string, brandName: string|null,
  industry: string|null, website: string|null,
  defaultFromEmail: string|null, defaultSenderName: string|null,
  defaultBookingLink: string|null, notificationEmail: string|null,
  crmType: 'internal' | string, autoReplyEnabled: boolean,
  autoReplyConfidenceThreshold: string,   // numeric stored as string
  isActive: boolean, createdAt, updatedAt
}
```

### 3.4 Campaigns

State machine: `draft → needs_training → training_in_progress → needs_review → ready_to_activate → active ⇄ paused → archived`.

| Method | Path | Auth | Body / Notes | Returns |
|---|---|---|---|---|
| GET | `/api/workspaces/:wid/campaigns` | 🟣 | List | `{ campaigns: Campaign[] }` |
| POST | `/api/workspaces/:wid/campaigns` | 🟠 | See body below | `{ campaign }` |
| GET | `/api/workspaces/:wid/campaigns/:cid` | 🟣 | — | `{ campaign }` |
| PATCH | `/api/workspaces/:wid/campaigns/:cid` | 🟠 | Partial update | `{ campaign }` |
| POST | `/api/workspaces/:wid/campaigns/:cid/activate` | 🟠 | Runs **12-check activation gate**. On failure returns 409 with `errors[]` listing every blocker. | `{ campaign, activation }` |
| POST | `/api/workspaces/:wid/campaigns/:cid/pause` | 🟠 | Only from `active`. | `{ campaign }` |
| POST | `/api/workspaces/:wid/campaigns/:cid/archive` | 🟠 | Use instead of DELETE. | `{ campaign }` |
| POST | `/api/workspaces/:wid/campaigns/:cid/test` | 🟠 | Stub — runs against `campaign_test_scenarios` (TBD). | `{ ran, results }` |

**Create / update body:**

```ts
{
  name: string,                  // required on create
  campaignType?: string,
  targetAudience?: string,
  offer?: string,
  goalSummary?: string,
  primaryCta?: string,
  aiPositioning?: string,
  aiRules?: string,
  safeAutoReplyRules?: unknown,  // JSON
  handoffRules?: unknown,        // JSON
  maxFollowups?: number,         // default 4
  followupSchedule?: unknown,    // JSON
  dailySendLimit?: number,       // default 25
  gmailAccountId?: string
}
```

### 3.5 Campaign setup

All four sub-objects are **singleton per campaign**: GET returns the one (or null), PATCH upserts. Editing an approved playbook or demo-guide flips it back to `draft` automatically.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/workspaces/:wid/campaigns/:cid/goal` | 🟣 | `{ goal }` |
| PATCH | `/api/workspaces/:wid/campaigns/:cid/goal` | 🟠 | First write must include `primaryGoal` + `primaryCta`. |
| GET / PATCH | `/api/workspaces/:wid/campaigns/:cid/exit-rules` | 🟣 / 🟠 | All fields optional; defaults match the spec. |
| GET | `/api/workspaces/:wid/campaigns/:cid/playbook` | 🟣 | `{ playbook }` |
| PATCH | `/api/workspaces/:wid/campaigns/:cid/playbook` | 🟠 | — |
| POST | `/api/workspaces/:wid/campaigns/:cid/playbook/generate` | 🟠 | **Calls Anthropic Sonnet (heavy).** Returns generated playbook + `ai.actionId` + `ai.confidence`. |
| POST | `/api/workspaces/:wid/campaigns/:cid/playbook/approve` | 🟠 | Sets `approval_status='approved'`, `approved_at=now`. |
| GET / PATCH | `/api/workspaces/:wid/campaigns/:cid/demo-guide` | 🟣 / 🟠 | Same pattern as playbook. |
| POST | `/api/workspaces/:wid/campaigns/:cid/demo-guide/generate` | 🟠 | Heavy AI. |
| POST | `/api/workspaces/:wid/campaigns/:cid/demo-guide/approve` | 🟠 | — |

### 3.6 Knowledge files

S3 path: `workspaces/{wid}/campaigns/{cid}/knowledge/original/{filename}`. Uploads trigger an async extraction worker; status moves `pending → processing → extracted → failed`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/workspaces/:wid/campaigns/:cid/knowledge` | 🟣 | `{ files: KnowledgeFile[] }` |
| POST | `/api/workspaces/:wid/campaigns/:cid/knowledge/upload` | 🟠 | **multipart/form-data**: `file` (required), `documentType` (optional). Max 50 MB. |
| POST | `/api/workspaces/:wid/campaigns/:cid/knowledge/paste` | 🟠 | Body: `{ fileName, content, documentType? }`. Stored with status=`extracted`. |
| GET | `/api/workspaces/:wid/campaigns/:cid/knowledge/:fileId` | 🟣 | `{ file, presignedUrl }` — 15-minute S3 download URL when present. |
| PATCH | `/api/workspaces/:wid/campaigns/:cid/knowledge/:fileId` | 🟠 | `{ documentType?, isActive?, summary? }` |
| DELETE | `/api/workspaces/:wid/campaigns/:cid/knowledge/:fileId` | 🟠 | Removes DB row + S3 object. |
| POST | `/api/workspaces/:wid/campaigns/:cid/knowledge/:fileId/extract` | 🟠 | Re-queue for extraction. |
| POST | `/api/workspaces/:wid/campaigns/:cid/knowledge/:fileId/summarize` | 🟠 | AI summary (light); stub for now — summary runs automatically by the worker. |

**Multipart example (browser):**

```ts
const fd = new FormData();
fd.append('file', fileObject);
fd.append('documentType', 'product_overview');
await fetch(`/api/workspaces/${wid}/campaigns/${cid}/knowledge/upload`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  body: fd,
});
```

### 3.7 Lead sources

Three source types: `google_sheet`, `csv_upload`, `manual`. Imports are dedupe-safe (partial unique on `workspace+campaign+lower(email)`).

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/workspaces/:wid/campaigns/:cid/lead-sources` | 🟣 | List |
| POST | `/api/workspaces/:wid/campaigns/:cid/lead-sources/google-sheet` | 🟠 | `{ sourceName?, googleSheetId, googleSheetTab?, fieldMapping? }` |
| POST | `/api/workspaces/:wid/campaigns/:cid/lead-sources/csv` | 🟠 | **multipart**: `file`, optional `sourceName`, optional `fieldMapping` (JSON string). |
| POST | `/api/workspaces/:wid/campaigns/:cid/lead-sources/manual` | 🟠 | `{ sourceName? }` |
| POST | `/api/workspaces/:wid/campaigns/:cid/lead-sources/:sourceId/map-columns` | 🟠 | `{ fieldMapping }`. See §4.3 for the system fields. **`email` is required** in the mapping. |
| GET | `/api/workspaces/:wid/campaigns/:cid/lead-sources/:sourceId/preview` | 🟣 | First 5 rows + column names (CSV only in v1). |
| POST | `/api/workspaces/:wid/campaigns/:cid/lead-sources/:sourceId/import` | 🟠 | Runs the import. Returns `{ created, skipped_existing, skipped_invalid, total_rows }`. |
| DELETE | `/api/workspaces/:wid/campaigns/:cid/lead-sources/:sourceId` | 🟠 | — |

### 3.8 Leads (mini CRM)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/workspaces/:wid/leads` | 🟣 | See filters below |
| POST | `/api/workspaces/:wid/leads` | 🟠 | Suppression-checked; 409 if email is suppressed |
| GET | `/api/workspaces/:wid/leads/:leadId` | 🟣 | — |
| PATCH | `/api/workspaces/:wid/leads/:leadId` | 🟠 | — |
| DELETE | `/api/workspaces/:wid/leads/:leadId` | 🟠 | Hard delete |
| POST | `/api/workspaces/:wid/leads/bulk-update` | 🟠 | `{ leadIds: string[1..500], patch: LeadPatch }` |
| POST | `/api/workspaces/:wid/leads/:leadId/score` | 🟠 | **AI light call** — sets `leadScore`, `leadScoreReason`, `status='scored'` |
| POST | `/api/workspaces/:wid/leads/:leadId/generate-email` | 🟠 | **AI light call** — body `{ stage?: 'cold'\|'followup_1'\|'followup_2'\|'followup_3'\|'breakup' }` |
| POST | `/api/workspaces/:wid/leads/:leadId/pause` | 🟠 | `{ pausedUntil?: ISO }` |
| POST | `/api/workspaces/:wid/leads/:leadId/close` | 🟠 | `{ closeReason, status? }` (status must be `closed_*`) |
| POST | `/api/workspaces/:wid/leads/:leadId/suppress` | 🟠 | `{ reason? }` — adds email to suppression + closes matching leads |
| POST | `/api/workspaces/:wid/leads/:leadId/send-next` | 🟠 | Stub — for v1 use `gmail/send`; sequencer is the followup worker |

**Filters (`GET /leads` query string):**

| Param | Type | Notes |
|---|---|---|
| `campaignId` | UUID | filter by campaign |
| `status` | string | comma-separated to OR (`status=replied,interested`) |
| `lifecycleStatus` | `active` \| `paused` \| `closed` | — |
| `q` | string | substring match against company / contact / email (ILIKE) |
| `limit` | int | default 50, max 500 |
| `offset` | int | default 0 |
| `orderBy` | `created_at` \| `updated_at` \| `last_engagement_at` \| `lead_score` | default `created_at` |
| `orderDir` | `asc` \| `desc` | default `desc` |

Returns `{ items: Lead[], total: number, limit: number, offset: number }`.

**Create body (`POST /leads`):**

```ts
{
  email: string,                 // required
  campaignId?: string,
  companyName?, contactName?, title?, website?, phone?, linkedinUrl?, segment?,
  source?, sourceNotes?,
  status?: LeadStatus            // see §4.2
}
```

### 3.9 Suppression list

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/workspaces/:wid/suppression` | 🟣 | `{ suppression: SuppressionEntry[] }` |
| POST | `/api/workspaces/:wid/suppression` | 🟠 | `{ email, reason? }` — auto-closes matching leads. |
| DELETE | `/api/workspaces/:wid/suppression/:entryId` | 🟠 | Removes the entry. Does **not** automatically re-open closed leads. |

### 3.10 Gmail

OAuth flow:

1. UI hits `POST /api/workspaces/:wid/gmail/connect` (admin) → returns `{ authUrl }`.
2. UI redirects user to `authUrl` (Google consent screen).
3. Google redirects back to `GOOGLE_REDIRECT_URI` (= `https://api.<domain>/api/auth/google/callback`).
4. Backend exchanges the code, encrypts tokens, upserts `gmail_accounts`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/workspaces/:wid/gmail/connect` | 🟠 | Returns `{ authUrl }`. 400 if Google OAuth secrets are missing. |
| GET | `/api/auth/google/callback` | 🟢 | Called by Google (not the UI). Returns `{ gmailAccount: { id, email, workspaceId } }`. |
| GET | `/api/workspaces/:wid/gmail/accounts` | 🟣 | Token columns stripped from response. |
| POST | `/api/workspaces/:wid/gmail/accounts/:gaid/sync` | 🟠 | Body `{ gmailThreadId }` — pulls a thread from Gmail and persists. |
| POST | `/api/workspaces/:wid/gmail/accounts/:gaid/pause` | 🟠 | Soft pause (keeps tokens). |
| PATCH | `/api/workspaces/:wid/gmail/accounts/:gaid/send-limits` | 🟠 | `{ dailySendLimit?, maxNewThreadsPerDay? }` |
| DELETE | `/api/workspaces/:wid/gmail/accounts/:gaid` | 🟠 | **Disconnect** — clears encrypted tokens, marks inactive. History preserved. |
| POST | `/api/workspaces/:wid/gmail/send` | 🟠 | See body below — enforces send-gate & daily-limit. |
| POST | `/api/workspaces/:wid/gmail/create-draft` | 🟠 | Same body shape as `send`. |
| POST | `/api/gmail/check-all-inboxes` | 🔵 | Cron stub — the `gmail-worker` already polls every 5 min. |
| POST | `/api/gmail/process-reply` | 🔵 | Worker hook stub. |

**Send body (`POST /gmail/send` and `/gmail/create-draft`):**

```ts
{
  gmailAccountId: string,       // required
  to: string,                   // required, valid email
  subject: string,              // required, max 998
  body: string,                 // required, plain text
  threadId?: string,            // Gmail thread id — continues an existing thread
  inReplyToMessageId?: string,
  references?: string,
  campaignId?: string,
  leadId?: string
}
```

Returns `{ gmailMessageId, gmailThreadId }`.

### 3.11 Threads

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/workspaces/:wid/threads` | 🟣 | Filters: `campaignId?`, `limit?`, `offset?` |
| GET | `/api/workspaces/:wid/threads/:threadId` | 🟣 | `{ thread: Thread & { messages, lead } }` — full message list + lead summary |
| POST | `/api/workspaces/:wid/threads/:threadId/summarize` | 🟠 | AI light — returns `{ summary, key_points, current_state, recommended_next_action }` |
| POST | `/api/workspaces/:wid/threads/:threadId/draft-reply` | 🟠 | AI light — returns the full **classification result** (see §4.6) |
| POST | `/api/workspaces/:wid/threads/:threadId/send-reply` | 🟠 | `{ subject?, body }` — continues the Gmail thread |
| POST | `/api/workspaces/:wid/threads/:threadId/handoff` | 🟠 | Sets thread to `handoff`, lead status to `handoff_required`, `ai_owner=false` |
| POST | `/api/workspaces/:wid/threads/:threadId/stop-sequence` | 🟠 | `{ reason? }` — closes the lead and stops the sequencer |

### 3.12 Handoff queue

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/workspaces/:wid/handoffs` | 🟣 | Leads where `status='handoff_required'` |
| POST | `/api/workspaces/:wid/handoffs/:leadId/create` | 🟠 | `{ summary? }` |
| POST | `/api/workspaces/:wid/handoffs/:leadId/resolve` | 🟠 | `{ resolution?: 'continue' \| 'closed' }` — `continue` puts the lead back in `replied/active`; `closed` closes it. |

### 3.13 AI actions queue

Every AI call (score, generate-email, classify-reply, summarize, playbook, demo-guide, training reply) writes an `ai_actions` row. The queue is the audit log + the approval surface for auto-actions later.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/workspaces/:wid/ai-actions` | 🟣 | Filters: `status?`, `limit?` (default 100, max 500). Newest first. |
| GET | `/api/workspaces/:wid/ai-actions/:actionId` | 🟣 | — |
| POST | `/api/workspaces/:wid/ai-actions/:actionId/approve` | 🟠 | Sets `status='approved'`. |
| POST | `/api/workspaces/:wid/ai-actions/:actionId/reject` | 🟠 | `{ reason? }` |
| POST | `/api/workspaces/:wid/ai-actions/:actionId/regenerate` | 🟠 | Stub — re-trigger the upstream endpoint (`/leads/:id/score`, `/threads/:id/draft-reply`, etc) instead. |

### 3.14 Followups

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/workspaces/:wid/followups/run` | 🟠 | Manual trigger for this workspace. Returns `{ scanned, sent, blocked, errors }`. |
| POST | `/api/followups/run-all` | 🔵 | Cross-workspace — usually only the `followup-worker` calls this. |

### 3.15 Domain health

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/workspaces/:wid/domain-health` | 🟣 | Last 50 checks across all this workspace's domains. |
| POST | `/api/workspaces/:wid/domain-health/check` | 🟠 | `{ domain, gmailAccountId?, dkimSelector? }` — DNS lookup, scores 0–100, syncs `gmail_account.health_status`. |

### 3.16 Training Studio

Chat-based campaign setup. Flow: **start → message ⇄ message → (optionally generate-playbook + generate-demo-guide) → approve**.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/workspaces/:wid/campaigns/:cid/training/start` | 🟠 | Seeds an opening assistant message. Sets campaign status to `training_in_progress`. |
| GET | `/api/workspaces/:wid/campaigns/:cid/training/:sessionId` | 🟠 | Full session + messages |
| POST | `/api/workspaces/:wid/campaigns/:cid/training/:sessionId/message` | 🟠 | `{ message }` — appends user turn, returns AI reply |
| POST | `/api/workspaces/:wid/campaigns/:cid/training/:sessionId/generate-playbook` | 🟠 | Heavy AI — uses transcript + context, upserts the playbook (`approval_status='draft'`) |
| POST | `/api/workspaces/:wid/campaigns/:cid/training/:sessionId/generate-demo-guide` | 🟠 | Heavy AI — same pattern |
| POST | `/api/workspaces/:wid/campaigns/:cid/training/:sessionId/approve` | 🟠 | Closes the session, moves campaign to `needs_review` |

---

## 4. Reference data

### 4.1 Campaign statuses

```
draft
needs_training
training_in_progress
needs_review
ready_to_activate
active
paused
archived
```

### 4.2 Lead statuses

```
new
pending_review
ready_to_score
scored
ready_to_send
sent_email_1
sent_followup_1
sent_followup_2
sent_followup_3
replied
interested
info_sent
objection
meeting_requested
call_link_sent
call_scheduled
handoff_required
paused
closed_no_response
closed_not_interested
closed_bad_fit
closed_wrong_person
closed_unsubscribed
closed_bounced
closed_duplicate
closed_manual
```

`lifecycleStatus` is the rollup: `active` | `paused` | `closed`.

### 4.3 Lead-source system fields (used in `fieldMapping`)

```
company_name
contact_name
email           // REQUIRED in every mapping
title
website
phone
linkedin_url
segment
source_notes
```

`fieldMapping` is `Record<sourceColumn, systemField>`. Example:

```jsonc
{ "fieldMapping": {
    "Company":    "company_name",
    "Full Name":  "contact_name",
    "Work Email": "email",
    "Role":       "title"
}}
```

### 4.4 Dashboard shape

```ts
{
  workspace: Workspace,
  counts: {
    campaigns: { total, active, draft },
    leads:     { total, active, closed },
    gmail_accounts: number,
    pending_ai_actions: number,
    send_volume_7d: number,
    handoff_queue: number,
    replied_7d: number,
  }
}
```

### 4.5 Knowledge `documentType`

```
product_overview
faq
pricing
pitch_deck
objection_library
compliance
case_study
demo_notes
uploaded_notes
other
```

### 4.6 Reply classifications (24)

These are what `/threads/:id/draft-reply` returns under `ai.classification`:

```
positive_interest        meeting_request          send_more_info
pricing_question         objection_existing_system objection_not_now
objection_cost           objection_skeptical       referral
wrong_person             out_of_office             unsubscribe
not_interested           bounce                    angry_or_sensitive
unknown_needs_review     continue_nurture          pause_out_of_office
close_not_interested     close_bad_fit             close_wrong_person
close_unsubscribed       close_bounced             handoff_required
call_scheduled           reactivation_candidate
```

Full classification response:

```ts
{
  classification: string,            // one of the above
  confidence: number,                // 0..1
  lead_temperature: 'hot' | 'warm' | 'cold' | 'frozen',
  should_auto_reply: boolean,
  should_create_draft: boolean,
  should_handoff: boolean,
  should_stop_sequence: boolean,
  should_pause: boolean,
  close_reason: string | null,
  summary: string,
  detected_pain_points: string[],
  recommended_next_action: string,
  reply_subject: string | null,
  reply_body: string | null,
  handoff_summary: string | null,
}
```

### 4.7 AI action types

Stored on `ai_actions.action_type`:

```
score_lead
generate_email
classify_reply
generate_reply
create_draft
send_email
handoff
stop_sequence
pause_lead
generate_playbook
generate_demo_guide
summarize_thread
extract_knowledge
summarize_knowledge
```

`status`: `pending` | `processing` | `completed` | `failed` | `cancelled` | `approved` | `rejected`.

### 4.8 Email message `direction`

```
inbound | outbound | draft
```

### 4.9 Domain health check fields

```ts
{
  domain: string,
  spfStatus:   'pass' | 'fail' | 'unknown',
  dkimStatus:  'pass' | 'fail' | 'unknown',
  dmarcStatus: 'pass' | 'fail' | 'unknown',
  mxStatus:    'pass' | 'fail' | 'unknown',
  healthScore: number,         // 0..100
  recommendation: string,
  checkedAt: string
}
```

`gmail_account.health_status` derived from score: `healthy` (≥80) | `warning` (≥50) | `at_risk` (<50) | `paused` | `disconnected` | `unknown`.

---

## 5. Recommended UX flows

These map UI screens to the endpoints they need. Build screens around these flows and you've covered the surface.

### 5.1 First-time onboarding

```
1. POST /api/auth/register
2. POST /api/auth/login (or use token from register)
3. POST /api/workspaces                              → user becomes owner
4. POST /api/workspaces/:wid/gmail/connect           → redirect to Google
5. (Google → /api/auth/google/callback)              → backend stores account
6. GET  /api/workspaces/:wid/gmail/accounts          → confirm connected
7. POST /api/workspaces/:wid/domain-health/check     → seed initial health
```

### 5.2 Campaign creation (full lifecycle)

```
1. POST /api/workspaces/:wid/campaigns                              → status: draft
2. PATCH /api/workspaces/:wid/campaigns/:cid/goal                   → set primary_goal + primary_cta
3. POST  /api/workspaces/:wid/campaigns/:cid/knowledge/upload (×N)  → drop in PDFs, FAQs, pricing docs
   (worker auto-extracts + summarizes — poll /knowledge until status=extracted)
4. POST  /api/workspaces/:wid/campaigns/:cid/training/start         → status: training_in_progress
   loop: POST /training/:sid/message until user is satisfied
5. POST  /api/workspaces/:wid/campaigns/:cid/training/:sid/generate-playbook
6. PATCH /api/workspaces/:wid/campaigns/:cid/playbook               → user reviews/edits
7. POST  /api/workspaces/:wid/campaigns/:cid/playbook/approve
8. POST  /api/workspaces/:wid/campaigns/:cid/training/:sid/generate-demo-guide
9. PATCH /api/workspaces/:wid/campaigns/:cid/demo-guide             → user reviews/edits
10. POST /api/workspaces/:wid/campaigns/:cid/demo-guide/approve
11. PATCH /api/workspaces/:wid/campaigns/:cid/exit-rules            → tune if needed
12. POST /api/workspaces/:wid/campaigns/:cid/lead-sources/csv       → or /google-sheet / /manual
13. POST /api/workspaces/:wid/campaigns/:cid/lead-sources/:sid/map-columns
14. POST /api/workspaces/:wid/campaigns/:cid/lead-sources/:sid/import → leads created as pending_review
15. PATCH /api/workspaces/:wid/campaigns/:cid                       → set gmailAccountId
16. POST /api/workspaces/:wid/campaigns/:cid/training/:sid/approve  → status: needs_review
17. POST /api/workspaces/:wid/campaigns/:cid/activate               → 409 with blockers if not ready,
                                                                       200 with campaign + activation when green
```

### 5.3 Daily operator dashboard

Hit these on dashboard load:

```
GET /api/workspaces/:wid/dashboard            → numbers
GET /api/workspaces/:wid/handoffs             → action items
GET /api/workspaces/:wid/ai-actions?status=pending&limit=20
GET /api/workspaces/:wid/threads?limit=20     → recent activity
GET /api/workspaces/:wid/domain-health        → sender health
```

### 5.4 Lead detail panel

```
GET /api/workspaces/:wid/leads/:leadId
GET /api/workspaces/:wid/threads?campaignId=...&limit=10   (filter for this lead's threads)
POST /api/workspaces/:wid/leads/:leadId/score              (if not yet scored)
POST /api/workspaces/:wid/leads/:leadId/generate-email     (manual draft)
POST /api/workspaces/:wid/leads/:leadId/pause              (snooze)
POST /api/workspaces/:wid/leads/:leadId/suppress           (do-not-contact)
```

### 5.5 Thread / inbox panel

```
GET  /api/workspaces/:wid/threads/:threadId               → messages + lead summary
POST /api/workspaces/:wid/threads/:threadId/summarize     → AI summary
POST /api/workspaces/:wid/threads/:threadId/draft-reply   → AI classification + suggested reply
POST /api/workspaces/:wid/threads/:threadId/send-reply    → send the (possibly user-edited) reply
POST /api/workspaces/:wid/threads/:threadId/handoff       → kick to a human
POST /api/workspaces/:wid/threads/:threadId/stop-sequence
```

---

## 6. Worker behavior (no UI endpoints, just FYI)

These run under PM2 on the EC2 host:

| Worker | Cadence | Effect |
|---|---|---|
| `gmail-worker` | every 5 min | polls every active Gmail account for inbound threads, syncs messages |
| `followup-worker` | every 10 min | scans `leads.next_action_at <= now`, runs the send-gate, calls AI, sends, advances the stage |
| `knowledge-worker` | every 5 s | extracts pending knowledge files from S3, summarizes via AI |
| `ai-worker` | every 30 s | reaps stuck `processing` rows older than 10 min; queue-depth heartbeat |
| `domain-health-worker` | every 6 hr | DNS check every active inbox, updates `gmail_account.health_status` |

Implication for the UI:

- After uploading knowledge, **poll** `GET /knowledge` until `extractionStatus === 'extracted'` (typically <10 s).
- After importing leads, the followup worker will start sending the moment the campaign is `active` and the lead has `next_action_at = now` (manual nudge for new leads: `PATCH /leads/:id { status: 'ready_to_send' }` then call `POST /followups/run` to fire immediately).
- The handoff queue and AI-actions queue fill in over time — design the dashboard to poll, or wire up your own SSE/WS later.

---

## 7. CORS, auth, and security

- CORS allowlist is controlled by `CORS_ORIGINS` in Secrets Manager. Add the frontend's origin (e.g. `https://app.<your-domain>`) there.
- Rate limit: 600 req/min per IP (global). `/health` is exempt.
- Helmet sets all standard security headers; no CSP (the frontend ships its own).
- Slow requests (>1 s) are logged.
- Every workspace-scoped route enforces membership. The frontend never needs to send a workspace ID in a body — always in the path.

---

## 8. Open items the backend doesn't cover yet (so the FE can plan around them)

These exist as **stubs** that return informational messages — they don't error, but they also don't do real work. They'll land in a future phase:

- `POST /api/workspaces/:wid/campaigns/:cid/test` — campaign test runner over `campaign_test_scenarios`
- `POST /api/workspaces/:wid/leads/:leadId/send-next` — explicit "send the next email now" (workaround: nudge `nextActionAt` and let the worker pick it up, or call `gmail/send` directly)
- `POST /api/gmail/check-all-inboxes` — manual inbox poll trigger (the worker already polls every 5 min)
- `POST /api/gmail/process-reply` — manual single-reply processor
- `POST /api/workspaces/:wid/ai-actions/:actionId/regenerate` — manually re-run an action (workaround: hit the upstream endpoint again, e.g. `/leads/:id/score`)

Everything else is fully implemented.

---

## 9. Glossary

| Term | Meaning |
|---|---|
| Workspace | A tenant. Owner + members. Holds campaigns, gmail accounts, leads, suppressions. |
| Campaign | A targeted outreach effort inside a workspace. Has goal, playbook, demo guide, exit rules, lead source, gmail account. |
| Playbook | AI's strategy bible for a campaign. Generated, edited, then approved. |
| Demo Guide | Call/discovery playbook for a campaign. Generated, edited, then approved. |
| Lead | A target person + their state (status, score, last contact, next action). |
| Thread | One Gmail thread between the lead and the sending Gmail account. Has many messages. |
| Handoff | A lead that the AI has flagged for human attention. |
| Suppression list | Workspace-level do-not-contact emails. Suppressing an email auto-closes matching leads. |
| Exit rules | Per-campaign limits (max attempts, max days, stop on unsubscribe/bounce/etc). |
| Send gate | Backend pre-flight check before any outbound. Returns `{ allowed, reason }`. |
| Domain health | DNS-based SPF/DKIM/DMARC/MX check. Drives `gmail_account.health_status`. |
| AI actions queue | Audit + review surface for every AI call. |
| Followup worker | The thing that sends the next email at the right time. |
| Training Studio | Chat-based campaign setup where the AI interviews the user, then generates a playbook + demo guide. |
