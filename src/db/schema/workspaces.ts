import { pgTable, uuid, text, boolean, numeric, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

// Per-workspace handoff trigger. The AI checks these conditions when classifying
// inbound replies; any match → flip lead to handoff_required + ai_owner=false.
// Stored as a JSONB array so users can add / remove / edit / toggle each rule
// from Settings without a migration.
export type HandoffRule = {
  id: string;
  text: string;
  enabled: boolean;
  isDefault: boolean;
  // 'info' | 'warning' | 'danger' — UI tone, not load-bearing on the AI side.
  tone?: 'info' | 'warning' | 'danger';
};

// A sample email the operator pasted in — the AI mimics this voice.
export type EmailSample = {
  subject: string;
  body: string;
};

// A recurring window the operator is NOT available — the slot engine never
// offers a meeting time that overlaps one of these.
export type BlockedWindow = {
  id: string;
  label: string;
  days: number[]; // 0=Sun .. 6=Sat
  start: string; // "HH:MM" 24h, in the config timezone
  end: string; // "HH:MM" 24h, in the config timezone
};

// Per-workspace scheduling config. Drives the AI's meeting proposals: which
// open slots to offer a lead, working hours, call length, and blocked time.
export type CalendarConfig = {
  timezone: string; // IANA tz, e.g. "America/New_York"
  workingDays: number[]; // 0=Sun .. 6=Sat
  workingHours: { start: string; end: string }; // "HH:MM"
  meetingDurationMinutes: number;
  slotIntervalMinutes: number; // granularity of candidate start times
  minLeadTimeHours: number; // never offer a slot sooner than this
  slotsNextDay: number; // slots offered on the next working day
  slotsDayAfter: number; // slots offered on the working day after
  blockedWindows: BlockedWindow[];
};

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    name: text('name').notNull(),
    companyName: text('company_name').notNull(),
    brandName: text('brand_name'),
    industry: text('industry'),
    website: text('website'),

    defaultFromEmail: text('default_from_email'),
    defaultSenderName: text('default_sender_name'),
    defaultBookingLink: text('default_booking_link'),
    notificationEmail: text('notification_email'),

    crmType: text('crm_type').notNull().default('internal'),

    autoReplyEnabled: boolean('auto_reply_enabled').notNull().default(false),
    autoReplyConfidenceThreshold: numeric('auto_reply_confidence_threshold', {
      precision: 4,
      scale: 3,
    }).notNull().default('0.850'),

    handoffRules: jsonb('handoff_rules').$type<HandoffRule[]>().notNull().default([]),

    // Outbound email config (per workspace).
    // HTML footer/signature appended to every sent email.
    emailFooterHtml: text('email_footer_html'),
    // Free-text voice/style instructions fed to the email-writing AI.
    emailStyleGuide: text('email_style_guide'),
    // Operator-pasted example emails — few-shot voice samples for the AI.
    emailSamples: jsonb('email_samples').$type<EmailSample[]>(),

    // Scheduling config (working hours, call length, blocked time). Null →
    // the service falls back to DEFAULT_CALENDAR_CONFIG.
    calendarConfig: jsonb('calendar_config').$type<CalendarConfig>(),

    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    activeIdx: index('workspaces_active_idx').on(t.isActive),
  }),
);

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
