/**
 * Per-(site, tag) form schemas for the Sales Training "Test Inbound" feature.
 *
 * These describe the question shape each live public form asks, so the
 * training UI can render an editable form pre-filled with a realistic
 * example. When the operator clicks "Run test", the answers flow through the
 * same `intake.submit()` envelope shape a real form submission would
 * produce — meaning the AI sees identical context for the test as it would
 * for a real lead.
 *
 * Field definitions are derived from the Layer-1 curl-verification examples
 * in `~/.claude/plans/claude-backend-handoff-gleaming-moore.md`. When a
 * public form gains or loses a field, edit this file (no DB migration
 * needed).
 *
 * Keep in sync with:
 *   - `src/config/intake-routing.ts` (the (site, tag) → campaign map)
 *   - `src/services/intake.service.ts` (the protected envelope keys)
 *   - `UnieSales_Frontend/src/lib/util/intake-urls.ts` (display URLs)
 */

export type IntakeSite = 'uniewms' | 'unielogics' | 'uniecortex' | 'unieconnect';

export type FieldType =
  | 'text'
  | 'email'
  | 'phone'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'textarea';

export interface IntakeFormField {
  /** Wire name as posted in `body.fields.<name>`. */
  name: string;
  /** Human-readable label rendered above the input. */
  label: string;
  type: FieldType;
  /** Options for `select` / `multiselect`. */
  options?: string[];
  /** True ⇒ form refuses to submit if blank. */
  required?: boolean;
  /** One-line helper text under the input. */
  helper?: string;
  /** Realistic example value used to pre-fill the test form. */
  example: string;
}

export interface IntakeContactExample {
  contactName: string;
  email: string;
  phone?: string;
  company?: string;
  title?: string;
  city?: string;
  state?: string;
}

export interface IntakeFormSchema {
  site: IntakeSite;
  tag: string;
  /** Display name for the test-inbound UI ("UnieWMS — Talk to Sales"). */
  displayName: string;
  /** Full public URL of the form (matches frontend `intakeSourceLink`). */
  publicUrl: string;
  /** Server-to-server forms (Cortex) don't accept browser submissions. */
  serverToServer?: boolean;
  /** Subset of contact fields the form asks. Form-specific — the developer
   *  widget asks just name+email; talk-to-sales asks name/email/phone/company/title. */
  contactFields: IntakeFormField[];
  /** Form-specific custom fields. Land in `lead.custom_fields.fields`. */
  customFields: IntakeFormField[];
  /** Pre-fill values for the contact panel. The operator typically overrides
   *  `email` with their test recipient before sending. */
  exampleContact: IntakeContactExample;
}

// ─── Helpers ──────────────────────────────────────────────────────────────
const F = {
  // Common contact-field templates so each schema below stays readable.
  name: (req = true): IntakeFormField => ({
    name: 'contactName', label: 'Full name', type: 'text',
    required: req, example: 'Sarah Tran',
  }),
  email: (req = true): IntakeFormField => ({
    name: 'email', label: 'Work email', type: 'email',
    required: req, example: 'sarah@acme3pl.com',
  }),
  phone: (req = false): IntakeFormField => ({
    name: 'phone', label: 'Phone', type: 'phone',
    required: req, example: '+1 718 555 1234',
  }),
  company: (req = true): IntakeFormField => ({
    name: 'company', label: 'Company', type: 'text',
    required: req, example: 'Acme 3PL',
  }),
  title: (req = false): IntakeFormField => ({
    name: 'title', label: 'Title', type: 'text',
    required: req, example: 'Operations Director',
  }),
};

const EXAMPLE_3PL: IntakeContactExample = {
  contactName: 'Sarah Tran',
  email: 'sarah@acme3pl.com',
  phone: '+1 718 555 1234',
  company: 'Acme 3PL',
  title: 'Operations Director',
};

const EXAMPLE_SHIPPER: IntakeContactExample = {
  contactName: 'Jane Smith',
  email: 'jane@brandco.com',
  phone: '+1 415 555 9876',
  company: 'Brand Co',
  title: 'COO',
};

// ─── Schemas ──────────────────────────────────────────────────────────────
export const INTAKE_FORM_SCHEMAS: Record<string, IntakeFormSchema> = {
  // ── UnieWMS ─────────────────────────────────────────────────────────────
  'uniewms.talk_to_sales': {
    site: 'uniewms',
    tag: 'talk_to_sales',
    displayName: 'UnieWMS — Talk to Sales',
    publicUrl: 'https://uniewms.com/talk-to-sales',
    contactFields: [F.name(), F.email(), F.phone(), F.company(), F.title()],
    customFields: [
      {
        name: 'monthlyVolume',
        label: 'Monthly order volume',
        type: 'select',
        options: ['<1,000', '1,000-5,000', '5,000-12,000', '12,000-50,000', '50,000+'],
        required: true,
        example: '5,000-12,000',
      },
      {
        name: 'integrationTimeline',
        label: 'Integration timeline',
        type: 'select',
        options: ['ASAP', 'Within 1-2 months', '3-6 months', 'Just exploring'],
        required: true,
        example: 'Within 1-2 months',
      },
      {
        name: 'employees',
        label: 'Warehouse headcount',
        type: 'number',
        example: '45',
      },
      {
        name: 'clients',
        label: 'Number of brand clients',
        type: 'number',
        helper: '3PLs only — leave blank if you ship your own brand',
        example: '18',
      },
      {
        name: 'notes',
        label: 'What\'s prompting the conversation?',
        type: 'textarea',
        example: 'Current WMS bills per pick and we just hit 10k orders/mo — economics are upside-down.',
      },
    ],
    exampleContact: EXAMPLE_3PL,
  },

  'uniewms.broker_apply': {
    site: 'uniewms',
    tag: 'broker_apply',
    displayName: 'UnieWMS — Broker Program',
    publicUrl: 'https://uniewms.com/broker-program/apply',
    contactFields: [F.name(), F.email(), F.phone(), F.company(), F.title()],
    customFields: [
      {
        name: 'brokerType',
        label: 'Broker type',
        type: 'select',
        options: ['3PL consultant', 'WMS reseller', 'Carrier broker', 'Independent agent', 'Other'],
        required: true,
        example: '3PL consultant',
      },
      {
        name: 'activeClients',
        label: 'Active client count',
        type: 'number',
        example: '12',
      },
      {
        name: 'typicalDealSize',
        label: 'Typical client deal size',
        type: 'select',
        options: ['<$5k/mo', '$5k-$25k/mo', '$25k-$100k/mo', '$100k+/mo'],
        example: '$25k-$100k/mo',
      },
      {
        name: 'notes',
        label: 'Why UnieWMS?',
        type: 'textarea',
        example: 'My clients keep churning off [Competitor] for pick-pack billing. Looking for a flat-fee partner I can stand behind.',
      },
    ],
    exampleContact: {
      contactName: 'Marcus Reed',
      email: 'marcus@reedlogistics.com',
      phone: '+1 312 555 0044',
      company: 'Reed Logistics Advisory',
      title: 'Managing Partner',
    },
  },

  'uniewms.warehouse_review': {
    site: 'uniewms',
    tag: 'warehouse_review',
    displayName: 'UnieWMS — Warehouse Review',
    publicUrl: 'https://uniewms.com/warehouse-review',
    contactFields: [F.name(), F.email(), F.phone(), F.company(), F.title()],
    customFields: [
      {
        name: 'currentWms',
        label: 'Current WMS',
        type: 'text',
        helper: 'Vendor name; "spreadsheets" or "none" is a valid answer',
        example: 'ShipBob',
      },
      {
        name: 'monthlyVolume',
        label: 'Monthly order volume',
        type: 'select',
        options: ['<1,000', '1,000-5,000', '5,000-12,000', '12,000-50,000', '50,000+'],
        required: true,
        example: '12,000-50,000',
      },
      {
        name: 'painPoints',
        label: 'Top operational pain points',
        type: 'textarea',
        required: true,
        example: 'Pick-and-pack billing is unpredictable. We have 6 brand clients and reconciling their invoices each month takes 3 days.',
      },
      {
        name: 'reviewGoal',
        label: 'What would a "useful" review look like?',
        type: 'textarea',
        example: 'A side-by-side of our current per-order cost vs UnieWMS flat fee, plus an honest opinion on whether switching is worth it.',
      },
    ],
    exampleContact: EXAMPLE_3PL,
  },

  // ── UnieLogics ──────────────────────────────────────────────────────────
  'unielogics.audit': {
    site: 'unielogics',
    tag: 'audit',
    displayName: 'UnieLogics — Audit',
    publicUrl: 'https://unielogics.com/audit',
    contactFields: [F.name(), F.email(), F.phone(), F.company(), F.title()],
    customFields: [
      {
        name: 'auditType',
        label: 'Audit type',
        type: 'select',
        options: ['label-spine', 'carrier-invoice', 'dim-weight', 'accessorial-charges', 'full-spectrum'],
        required: true,
        example: 'label-spine',
      },
      {
        name: 'persona',
        label: 'Your role',
        type: 'select',
        options: ['warehouse', 'finance', 'logistics-manager', 'founder', 'consultant'],
        required: true,
        example: 'warehouse',
      },
      {
        name: 'carriersUsed',
        label: 'Carriers used',
        type: 'multiselect',
        options: ['FedEx', 'UPS', 'USPS', 'DHL', 'Regional', 'Other'],
        example: 'FedEx, UPS',
      },
      {
        name: 'monthlyParcels',
        label: 'Monthly parcel volume',
        type: 'select',
        options: ['<10k', '10k-50k', '50k-100k', '100k+'],
        required: true,
        example: '50k-100k',
      },
      {
        name: 'notes',
        label: 'What are you hoping to recover?',
        type: 'textarea',
        example: 'Suspect dim-weight overcharges and late-delivery refunds we never claimed.',
      },
    ],
    exampleContact: EXAMPLE_SHIPPER,
  },

  'unielogics.join': {
    site: 'unielogics',
    tag: 'join',
    displayName: 'UnieLogics — Join Network',
    publicUrl: 'https://unielogics.com/join',
    contactFields: [F.name(), F.email(), F.phone(), F.company(), F.title()],
    customFields: [
      {
        name: 'providerType',
        label: 'Provider type',
        type: 'select',
        options: ['3PL', 'carrier', 'fulfillment-tech', 'consultant', 'other'],
        required: true,
        example: '3PL',
      },
      {
        name: 'coverage',
        label: 'Coverage area',
        type: 'text',
        example: 'US East Coast + Texas',
      },
      {
        name: 'specialty',
        label: 'Specialty',
        type: 'textarea',
        example: 'B2C apparel + small-parcel; sub-day shipping out of NJ.',
      },
    ],
    exampleContact: EXAMPLE_3PL,
  },

  'unielogics.get_started': {
    site: 'unielogics',
    tag: 'get_started',
    displayName: 'UnieLogics — Get Started',
    publicUrl: 'https://unielogics.com/get-started',
    contactFields: [F.name(), F.email(), F.company(false)],
    customFields: [
      {
        name: 'interest',
        label: 'What are you looking for?',
        type: 'select',
        options: ['Free audit', 'Join the network', 'Talk to sales', 'Just browsing'],
        required: true,
        example: 'Free audit',
      },
      {
        name: 'notes',
        label: 'Anything we should know?',
        type: 'textarea',
        example: 'Found you via Reddit — interested in the dim-weight audit.',
      },
    ],
    exampleContact: { ...EXAMPLE_SHIPPER, phone: undefined, title: undefined },
  },

  'unielogics.developer': {
    site: 'unielogics',
    tag: 'developer',
    displayName: 'UnieLogics — Developer Widget',
    publicUrl: 'https://unielogics.com/',
    contactFields: [F.name(), F.email()],
    customFields: [
      {
        name: 'useCase',
        label: 'Use case',
        type: 'textarea',
        required: true,
        example: 'Building a shipping rate comparator inside our checkout. Need a UnieLogics rate API.',
      },
      {
        name: 'volume',
        label: 'Expected request volume',
        type: 'select',
        options: ['<1k/day', '1k-10k/day', '10k-100k/day', '100k+/day'],
        example: '1k-10k/day',
      },
    ],
    exampleContact: {
      contactName: 'Priya Shah',
      email: 'priya@checkoutworks.io',
      company: 'Checkoutworks',
    },
  },

  'unielogics.industry_problems': {
    site: 'unielogics',
    tag: 'industry_problems',
    displayName: 'UnieLogics — Industry Problems',
    publicUrl: 'https://unielogics.com/industry-problems',
    contactFields: [F.name(), F.email(), F.company()],
    customFields: [
      {
        name: 'problemArea',
        label: 'Which problem hits hardest?',
        type: 'select',
        options: [
          'Dim-weight overcharges',
          'Late-delivery refunds',
          'Accessorial creep',
          'Multi-carrier visibility',
          'Returns reverse logistics',
          'Other',
        ],
        required: true,
        example: 'Dim-weight overcharges',
      },
      {
        name: 'severity',
        label: 'How bad?',
        type: 'select',
        options: ['Annoying', 'Costing real money', 'Existential'],
        example: 'Costing real money',
      },
      {
        name: 'notes',
        label: 'Tell us more',
        type: 'textarea',
        example: 'Audited Q1 and found ~$48k in dim-weight charges that look wrong. No idea where to start.',
      },
    ],
    exampleContact: EXAMPLE_SHIPPER,
  },

  'unielogics.products_inquiry': {
    site: 'unielogics',
    tag: 'products_inquiry',
    displayName: 'UnieLogics — Products Inquiry',
    publicUrl: 'https://unielogics.com/products',
    contactFields: [F.name(), F.email(), F.phone(false), F.company()],
    customFields: [
      {
        name: 'productInterest',
        label: 'Which product are you interested in?',
        type: 'multiselect',
        options: [
          'UnieWMS',
          'UnieLogics Audit',
          'UnieLogics Network',
          'UnieCortex',
          'UnieConnect',
        ],
        required: true,
        example: 'UnieWMS, UnieLogics Audit',
      },
      {
        name: 'currentStack',
        label: 'Current logistics stack',
        type: 'text',
        example: 'ShipBob + ShipStation + Excel',
      },
      {
        name: 'notes',
        label: 'What\'s the use case?',
        type: 'textarea',
        example: 'Evaluating WMS replacement with an audit kicker. Decision-maker by end of quarter.',
      },
    ],
    exampleContact: EXAMPLE_SHIPPER,
  },

  'unielogics.services_inquiry': {
    site: 'unielogics',
    tag: 'services_inquiry',
    displayName: 'UnieLogics — Services Inquiry',
    publicUrl: 'https://unielogics.com/services',
    contactFields: [F.name(), F.email(), F.phone(false), F.company()],
    customFields: [
      {
        name: 'serviceInterest',
        label: 'Which service?',
        type: 'select',
        options: [
          'Carrier negotiation',
          'Invoice audit',
          'Implementation consulting',
          'Network buildout',
          'Other',
        ],
        required: true,
        example: 'Carrier negotiation',
      },
      {
        name: 'urgency',
        label: 'Urgency',
        type: 'select',
        options: ['Just exploring', 'Within a quarter', 'Right now'],
        example: 'Within a quarter',
      },
      {
        name: 'notes',
        label: 'Context',
        type: 'textarea',
        example: 'Contract with FedEx renews in 60 days — need leverage data fast.',
      },
    ],
    exampleContact: EXAMPLE_SHIPPER,
  },

  // ── UnieCortex ──────────────────────────────────────────────────────────
  // Server-to-server intake — no public browser form. Test sends still work
  // (we insert the lead the same way) but the operator should understand
  // these don't have a public URL to verify against.
  'uniecortex.audit_request': {
    site: 'uniecortex',
    tag: 'audit_request',
    displayName: 'UnieCortex — Audit Request (HMAC mirror)',
    publicUrl: 'https://uniecortex.com/audit',
    serverToServer: true,
    contactFields: [F.name(), F.email(), F.phone(false), F.company(), F.title(false)],
    customFields: [
      {
        name: 'audit_type',
        label: 'Audit type',
        type: 'select',
        options: ['warehouse', 'carrier', 'finance', 'multi-vertical'],
        required: true,
        example: 'warehouse',
      },
      {
        name: 'problems',
        label: 'Problems flagged',
        type: 'textarea',
        helper: 'Free-form list of what Cortex spotted',
        example: 'dim-weight overcharges, late-delivery refunds, accessorial creep on hazmat',
      },
      {
        name: 'parcels',
        label: 'Monthly parcel volume',
        type: 'select',
        options: ['<10k', '10k-50k', '50k-100k', '100k+'],
        required: true,
        example: '50k-100k',
      },
    ],
    exampleContact: EXAMPLE_SHIPPER,
  },

  'uniecortex.partner_application': {
    site: 'uniecortex',
    tag: 'partner_application',
    displayName: 'UnieCortex — Partner Application (HMAC mirror)',
    publicUrl: 'https://uniecortex.com/partners',
    serverToServer: true,
    contactFields: [F.name(), F.email(), F.phone(false), F.company(), F.title(false)],
    customFields: [
      {
        name: 'partner_type',
        label: 'Partner type',
        type: 'select',
        options: ['warehouse', 'carrier', 'finance', 'tech-integration'],
        required: true,
        example: 'warehouse',
      },
      {
        name: 'specialization',
        label: 'Specialization',
        type: 'text',
        example: 'Hazmat + cold-chain B2B',
      },
      {
        name: 'notes',
        label: 'Why UnieCortex?',
        type: 'textarea',
        example: 'My clients keep asking for proactive cost audits; would love access to the audit engine.',
      },
    ],
    exampleContact: EXAMPLE_3PL,
  },

  'uniecortex.website_catalog_audit': {
    site: 'uniecortex',
    tag: 'website_catalog_audit',
    displayName: 'UnieConnect — Catalog Audit (Cortex mirror)',
    publicUrl: 'https://uniecortex.com/catalog-audit',
    serverToServer: true,
    contactFields: [F.name(), F.email(), F.phone(false), F.company(), F.title(false)],
    customFields: [
      {
        name: 'cortex_reference',
        label: 'Cortex reference',
        type: 'text',
        required: true,
        example: 'cat_audit_01JZ9Q9Q4G6DP',
      },
      {
        name: 'confidence',
        label: 'Confidence',
        type: 'text',
        example: '0.86',
      },
      {
        name: 'product_count',
        label: 'Product count',
        type: 'number',
        example: '184',
      },
      {
        name: 'blockers',
        label: 'Blockers',
        type: 'textarea',
        example: 'missing GTINs, duplicate SKUs, incomplete dimensions',
      },
      {
        name: 'savings',
        label: 'Estimated savings',
        type: 'text',
        example: '$14,200 annual parcel savings',
      },
      {
        name: 'next_actions',
        label: 'Next actions',
        type: 'textarea',
        example: 'Clean SKU metadata, normalize variants, run carrier/service mapping.',
      },
    ],
    exampleContact: EXAMPLE_SHIPPER,
  },
};

/**
 * Lookup helper. Returns null for unknown (site, tag) pairs — e.g. the
 * unieconnect product which has no public intake forms yet.
 */
export function lookupFormSchema(site: string, tag: string): IntakeFormSchema | null {
  return INTAKE_FORM_SCHEMAS[`${site}.${tag}`] ?? null;
}

/**
 * All schemas for a given site, in display order. Empty for sites with no
 * public intake (currently `unieconnect`).
 */
export function formSchemasForSite(site: string): IntakeFormSchema[] {
  return Object.values(INTAKE_FORM_SCHEMAS).filter((s) => s.site === site);
}
