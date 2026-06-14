# UnieSales — Public-site Intake Integration

This document describes how `uniewms.com`, `unielogics.com`, and `uniecortex.com` should submit their forms to UnieSales. Hand it to whoever maintains each site's form handlers.

---

## TL;DR — one URL per site

| Site | Endpoint | Auth |
|---|---|---|
| **uniewms.com** | `POST https://api.uniesales.com/public/intake/uniewms` | Browser (CORS allowlisted) |
| **unielogics.com** | `POST https://api.uniesales.com/public/intake/unielogics` | Browser (CORS allowlisted) |
| **uniecortex.com** | `POST https://api.uniesales.com/public/intake/uniecortex` | Server-to-server (HMAC) |

Every request uses the same JSON body envelope (described below). A `tag` field inside the body identifies which form on that site fired the request. The site name is derived from the URL — no `source` field needed.

---

## Body envelope (all three endpoints)

```json
{
  "tag": "<form tag — see per-site list below>",
  "page_url": "https://uniewms.com/warehouse-review?interest=managed",
  "contact": {
    "contactName": "Sarah Tran",
    "email": "sarah@acme3pl.com",
    "phone": "+17185551234",
    "company": "Acme 3PL",
    "title": "Operations",
    "city": "Austin",
    "state": "TX"
  },
  "fields": {
    "anything": "the form collects goes here, verbatim",
    "nested": { "is": "fine" },
    "arrays": ["too"]
  },
  "meta": {
    "submittedAt": "2026-05-26T22:00:00Z",
    "utm": { "source": "google", "campaign": "wms" }
  },
  "hp_email": ""
}
```

### Required vs optional

- **`tag`** — required. Must match one of the tags listed for the site below.
- **`page_url`** — required. Full URL of the page the form was on (including query string). Stored on the lead as `source_url` and surfaced in the AI's outbound copy.
- **`contact.email`** — required. Must be a valid email.
- **`contact.contactName`** — optional but recommended. If present and the site doesn't already split first/last, UnieSales auto-splits server-side.
- Everything else in `contact` (`phone`, `company`, `title`, `city`, `state`) — optional.
- **`fields`** — optional but recommended. Anything specific to that form goes here. The entire object is preserved verbatim in the lead's `custom_fields` JSONB. Nested objects + arrays are fine. The AI reads these naturally when drafting outbound copy.
- **`meta`** — optional. Use for analytics: `submittedAt`, `utm`, A/B variant, anything you want preserved.
- **`hp_email`** — optional, but include the field on the form. See *Honeypot* below.

### Reserved keys

`fields` MUST NOT contain a key named `site`, `tag`, `page_url`, `contact`, `fields`, `meta`, or `flat`. The endpoint rejects submissions that try to overwrite envelope metadata with a 400.

---

## Per-site tags

### uniewms — `POST /public/intake/uniewms`

| `tag` | Triggered by |
|---|---|
| `talk_to_sales` | `/talk-to-sales` form |
| `broker_apply` | `/broker-program/apply` form |
| `warehouse_review` | `/warehouse-review` form |

### unielogics — `POST /public/intake/unielogics`

| `tag` | Triggered by |
|---|---|
| `audit` | `/audit` multi-step funnel |
| `join` | `/join` (provider sign-up) |
| `get_started` | `/get-started` |
| `developer` | Footer developer widget |

### uniecortex — `POST /public/intake/uniecortex` (HMAC required)

| `tag` | Triggered by |
|---|---|
| `audit_request` | Cortex audit-request form |
| `partner_application` | Cortex partner application form |

---

## Response contract

| HTTP | Body | When |
|---|---|---|
| **201** | `{ "success": true, "data": { "lead_id": "uuid" }, "message": "OK" }` | Successful submission — a new lead exists |
| **200** | `{ "success": true, "data": { "lead_id": null, "status": "ok" } }` | Honeypot caught a bot. Silent success — do not expose this distinction to the user |
| **400** | `{ "success": false, "message": "Validation failed", "errors": [...] }` | Bad body shape (missing email, unknown tag, reserved key collision, etc.) |
| **401** | `{ "error": "invalid signature" }` | `uniecortex` only — HMAC mismatch |
| **409** | `{ "success": false, "message": "Lead already exists for this campaign" }` | Same email already submitted the same form before. Treat as success on the UI side — the lead is already in the system |
| **429** | Rate-limit response | More than 5 requests/min from one IP. Throttle client-side or back off |

**Frontend behavior:** treat any 2xx OR 409 as success. The user should see the same "got it" confirmation either way — never reveal whether their email was already on file.

---

## Browser endpoints — CORS, rate-limit, honeypot

### CORS allowlist (already deployed)

The browser endpoints (`uniewms`, `unielogics`) accept these origins:

```
https://uniewms.com,  https://www.uniewms.com
https://unielogics.com, https://www.unielogics.com
https://*.amplifyapp.com         (AWS Amplify preview deploys for both sites)
```

If your form lives on a different host, ping the UnieSales backend owner to add the origin to `CORS_ORIGINS`.

### Rate limit

**5 requests / minute / IP.** Enough for office networks and legitimate testing. Tighten later if abuse appears.

### Honeypot — bot screening

Include a hidden field named `hp_email` on every form. Real users won't see it (hide with CSS `display: none` or `position: absolute; left: -9999px`); bots that auto-fill all inputs trip it.

**HTML pattern:**

```html
<div aria-hidden="true" style="position:absolute;left:-9999px;height:1px;overflow:hidden">
  <label>
    Don't fill this out
    <input name="hp_email" type="text" autocomplete="off" tabindex="-1" />
  </label>
</div>
```

When the field is non-empty in the POST body, UnieSales returns a fake 200 with `lead_id: null` and silently logs the event. Never tell the user why — let the bot think it worked.

---

## uniecortex — HMAC signing (server-to-server)

The `uniecortex` endpoint is meant for CortexBackend's mirror call after its own provisioning. Browser CORS does **not** apply — the request must be signed.

### Required header

```
X-UnieSales-Signature: sha256=<hex-encoded HMAC-SHA256>
```

The hex is `HMAC-SHA256(rawBody, UNIESALES_INTAKE_HMAC_SECRET)`.

### Signing example (Node)

```js
const crypto = require('node:crypto');
const body = JSON.stringify(payload);
const sig = crypto
  .createHmac('sha256', process.env.UNIESALES_INTAKE_HMAC_SECRET)
  .update(body)
  .digest('hex');

await fetch('https://api.uniesales.com/public/intake/uniecortex', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-UnieSales-Signature': `sha256=${sig}`,
  },
  body, // exact same string used to compute the signature
});
```

### Signing example (Python)

```python
import hmac, hashlib, json, requests, os
body = json.dumps(payload)
sig = hmac.new(
    os.environ['UNIESALES_INTAKE_HMAC_SECRET'].encode(),
    body.encode(),
    hashlib.sha256,
).hexdigest()
requests.post(
    'https://api.uniesales.com/public/intake/uniecortex',
    headers={
        'Content-Type': 'application/json',
        'X-UnieSales-Signature': f'sha256={sig}',
    },
    data=body,
)
```

**Critical:** compute the signature on the exact bytes you POST. If you JSON-stringify twice or trim whitespace, the signature won't match. Send the same string you signed.

### Failure mode

If the HMAC is missing or wrong, UnieSales returns `401 { "error": "invalid signature" }`. Cortex should **fire and forget** — don't block the user-facing flow on a UnieSales failure. The Cortex provisioning is the user's source of truth; this mirror is a downstream signal.

### Secret rotation

The shared secret lives in AWS Secrets Manager at `uniesales/prod/app` under the key `UNIESALES_INTAKE_HMAC_SECRET`. On Cortex's side, store it in your own secret store and inject as `UNIESALES_INTAKE_HMAC_SECRET` env var. Coordinate rotations out-of-band — when UnieSales rotates, Cortex needs the new value within the next deploy cycle.

---

## End-to-end examples

### UnieWMS — Talk to Sales

```bash
curl -i -X POST https://api.uniesales.com/public/intake/uniewms \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://uniewms.com' \
  -d '{
    "tag": "talk_to_sales",
    "page_url": "https://uniewms.com/talk-to-sales",
    "contact": {
      "contactName": "Sarah Tran",
      "email": "sarah@acme3pl.com",
      "phone": "7185551234",
      "company": "Acme 3PL",
      "title": "Operations"
    },
    "fields": {
      "role": "Operations",
      "address": "200 Main St, Brooklyn NY",
      "currentWms": "None / paper",
      "warehouseSites": "3",
      "monthlyVolume": "12000",
      "integrationTimeline": "Within 1-2 months",
      "employees": 45,
      "clients": 18,
      "notes": "Looking to digitize for Q3",
      "tag": "sales",
      "program": ""
    },
    "meta": { "submittedAt": "2026-05-26T22:00:00Z" },
    "hp_email": ""
  }'
```

### UnieWMS — Warehouse Review

```json
{
  "tag": "warehouse_review",
  "page_url": "https://uniewms.com/warehouse-review?interest=managed",
  "contact": { "contactName": "Maya Patel", "email": "maya@northwind3pl.com", "phone": "4155551234", "company": "Northwind 3PL", "title": "COO", "city": "Austin", "state": "TX" },
  "fields": {
    "interest": "managed",
    "employees": 62, "clients": 24, "warehouseSites": 3,
    "monthlyVolume": "5,000 – 20,000",
    "timeline": "30 - 60 days",
    "currentWms": "Manual paper",
    "equipment": ["Tablets", "Handheld scanners"],
    "smsConsent": false,
    "notes": "Q3 digitization goal"
  },
  "hp_email": ""
}
```

### UnieLogics — Audit (multi-step)

The full nested payload from `buildAuditPayload()` works as-is. Don't flatten it — UnieSales preserves the nested structure in `custom_fields.fields` and also provides a flat key→value namespace at `custom_fields.flat` for AI prompts.

```json
{
  "tag": "audit",
  "page_url": "https://unielogics.com/audit?type=label-spine&persona=warehouse",
  "contact": { "contactName": "Jane Smith", "email": "jane@brand.co", "phone": "+15551234567", "company": "Brand Co", "title": "COO" },
  "fields": {
    "mode": "complete",
    "persona": "warehouse",
    "auditType": "label-spine",
    "identity": { "fullName": "Jane Smith", "workEmail": "jane@brand.co", "company": "Brand Co" },
    "common": {
      "primaryProblem": "carrier overcharges",
      "monthlyVolumeBand": "10,000 – 50,000",
      "locationsCount": "2 – 5",
      "systemsInUse": ["WMS", "TMS"],
      "timeline": "1 – 3 months"
    },
    "answers": {
      "carriersUsed": ["FedEx", "UPS"],
      "monthlyParcels": "100k+",
      "avgWeightBand": "10–25 lb",
      "labelCsvAvailable": true
    },
    "scheduling": { "date": "2026-06-05", "timeSlot": "14:00", "timezone": "America/New_York" },
    "consent": true,
    "meta": { "submittedAt": "2026-05-26T22:00:00Z", "pageUrl": "...", "utm": {} }
  },
  "hp_email": ""
}
```

### UnieCortex — Audit Request (HMAC)

```bash
SECRET="$UNIESALES_INTAKE_HMAC_SECRET"
BODY='{"tag":"audit_request","page_url":"https://uniecortex.com/audit","contact":{"contactName":"Robert Lee","email":"robert@enterprise.co","phone":"+15551112222","company":"Enterprise Co","title":"VP Logistics"},"fields":{"audit_type":"warehouse","problems":["dim-weight overcharges","late-delivery refunds"],"volume":{"parcels":"12k/mo"},"has_data_ready":true}}'

SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')

curl -i -X POST https://api.uniesales.com/public/intake/uniecortex \
  -H 'Content-Type: application/json' \
  -H "X-UnieSales-Signature: sha256=$SIG" \
  -d "$BODY"
```

---

## What happens after a successful POST

1. **Lead is created** in the UnieSales `leads` table with `import_origin = 'intake'`.
2. The full envelope is preserved in `leads.custom_fields` under a fixed shape:
   ```json
   {
     "site": "uniewms",
     "tag": "warehouse_review",
     "page_url": "...",
     "contact": { ... },
     "fields": { ... },             // raw form payload, verbatim
     "meta": { ... },
     "flat": { "monthlyVolume": "12000", "answers.carriersUsed": "FedEx, UPS" }
   }
   ```
3. **Name auto-splits**: `contactName` → `first_name` + `last_name` (operator can edit later).
4. **AI triage runs within ~30 seconds:**
   - `score_lead` → 0–100 score with reasoning
   - `classify_lead` → temperature (hot / warm / cold / frozen) + intent labels
   - Creates an `intake_summary` note on the lead's timeline
   - Creates a `review_ai_draft` task for the operator (priority scaled to temperature)
   - Sets `pipeline_stage = 'ai_reviewed'`
5. **The operator sees it** in Sales mode → Cockpit (live AI activity feed) + Inbound Leads + Pipeline.
6. **No outbound email goes out automatically** — the runner is triage-only in v1. The operator approves the AI's drafted reply from the lead modal.

---

## Status checks for the public-site engineer

- [ ] Form POSTs to the correct URL for your site
- [ ] All form fields end up under the body's `fields` object (don't flatten — nested is fine and preferred)
- [ ] `contact.email` is sent and valid
- [ ] `page_url` includes the current URL with query string
- [ ] Hidden `hp_email` honeypot field is on the form
- [ ] CORS allowlist includes the form's origin
- [ ] (uniecortex only) HMAC header is included and signed against the exact body bytes
- [ ] Frontend handles 2xx, 409, 4xx, and 5xx without exposing internal status details to the visitor

---

## Questions / changes

Field-mapping requests (renaming `monthlyVolume` to `monthly_volume`, etc.) — not needed. UnieSales preserves whatever key names you send. The AI is happy with either.

Adding a new form to an existing site — open a PR on this repo that adds a new tag to the site's enum in `config/intake-routing.ts` and seeds a campaign in `scripts/seed-inbound-intake.sql`. Until that ships, sending an unknown tag returns 400.

Adding a fourth site — bigger change. Drop a note and we'll add the new endpoint + CORS + campaign seed.
