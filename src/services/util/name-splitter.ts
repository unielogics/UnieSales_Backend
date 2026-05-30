/**
 * splitName — best-effort first/last name split for inbound intake forms.
 *
 * Forms in the public sites vary: UnieWMS sends a single "Name" field;
 * UnieCortex sends First/Last already split. The intake service runs every
 * incoming `contact.contactName` through this helper so the AI's `first_name`
 * greeting hook works regardless of source.
 *
 * The output is best-effort, not authoritative — operators can edit the lead
 * after import. Goals:
 *  - "Sarah Tran"            → { first: "Sarah", last: "Tran" }
 *  - "Mary-Beth O'Connor"    → { first: "Mary-Beth", last: "O'Connor" }
 *  - "Smith, John"           → { first: "John", last: "Smith" }      (comma form)
 *  - "Dr. John Doe Jr."      → { first: "John", last: "Doe" }        (titles + suffixes stripped)
 *  - "Madonna"               → { first: "Madonna", last: null }      (single token)
 *  - ""  /  "   "  /  null   → { first: null, last: null }
 *  - "李雷"                  → { first: "李雷", last: null }         (codepoint-safe single token)
 *
 * We intentionally do NOT try to split CJK / RTL names — passing them through
 * unsplit is safer than guessing wrong.
 */

export interface SplitName {
  first: string | null;
  last: string | null;
}

// Common prefix titles to strip. Matches case-insensitively, with or without
// the trailing period.
const TITLE_PREFIXES = new Set([
  'mr', 'mrs', 'ms', 'mx', 'miss',
  'dr', 'prof', 'professor',
  'sir', 'madam', 'madame',
  'rev', 'reverend', 'fr', 'sr',
  'lt', 'capt', 'maj', 'col', 'gen', 'sgt',
  'hon', 'judge',
]);

// Common name suffixes to strip from the end. Matches case-insensitively.
const NAME_SUFFIXES = new Set([
  'jr', 'sr',
  'ii', 'iii', 'iv', 'v',
  'phd', 'md', 'mba', 'dds', 'esq', 'cpa',
]);

function normalizeToken(s: string): string {
  // Strip trailing periods/commas for matching against the title/suffix sets.
  return s.replace(/[.,]+$/g, '').toLowerCase();
}

/**
 * Split a free-form name string into first + last. Returns nulls when the
 * input is empty or unsalvageable. Never throws.
 */
export function splitName(input: string | null | undefined): SplitName {
  if (input == null) return { first: null, last: null };
  const trimmed = String(input).trim().replace(/\s+/g, ' ');
  if (!trimmed) return { first: null, last: null };

  // Comma form: "Last, First [middle...]" — common in CRM exports.
  if (trimmed.includes(',')) {
    const [lastPart, firstPart = ''] = trimmed.split(',', 2).map((s) => s.trim());
    const firstOnly = stripSuffixesAndTitles(firstPart || '').first;
    const lastOnly = stripSuffixesAndTitles(lastPart || '').first; // last side has one token usually
    return {
      first: firstOnly || (lastOnly ? null : null),
      last: lastOnly || null,
    };
  }

  return stripSuffixesAndTitles(trimmed);
}

/**
 * Tokenize on whitespace, strip leading title tokens + trailing suffix tokens,
 * then assign first = first remaining token, last = last remaining token.
 * Middle tokens are dropped (operators can edit later if it matters).
 */
function stripSuffixesAndTitles(s: string): SplitName {
  let tokens = s.split(' ').filter(Boolean);

  // Strip leading titles ("Dr.", "Mr", "Prof.")
  while (tokens.length > 1 && TITLE_PREFIXES.has(normalizeToken(tokens[0]!))) {
    tokens.shift();
  }
  // Strip trailing suffixes ("Jr", "III", "PhD")
  while (tokens.length > 1 && NAME_SUFFIXES.has(normalizeToken(tokens[tokens.length - 1]!))) {
    tokens.pop();
  }

  if (tokens.length === 0) return { first: null, last: null };
  if (tokens.length === 1) return { first: tokens[0]!, last: null };
  return {
    first: tokens[0]!,
    last: tokens[tokens.length - 1]!,
  };
}
