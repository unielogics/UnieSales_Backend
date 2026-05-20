import { parse as parseCsvSync } from 'csv-parse/sync';

export interface ExtractionResult {
  text: string;
  detectedMime?: string;
}

/**
 * Convert a knowledge-file buffer into plain text. Supports PDF, CSV, TXT, MD.
 * DOCX/PPTX support can be layered in later (mammoth/officeparser).
 */
export async function extractText(buf: Buffer, fileName: string, mime?: string): Promise<ExtractionResult> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf') || mime === 'application/pdf') {
    return { text: await extractPdf(buf), detectedMime: 'application/pdf' };
  }
  if (lower.endsWith('.csv') || mime === 'text/csv') {
    return { text: extractCsv(buf), detectedMime: 'text/csv' };
  }
  if (lower.endsWith('.json') || mime === 'application/json') {
    return { text: buf.toString('utf-8'), detectedMime: 'application/json' };
  }
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || mime === 'text/markdown') {
    return { text: buf.toString('utf-8'), detectedMime: 'text/markdown' };
  }
  // default: treat as plain text
  return { text: buf.toString('utf-8'), detectedMime: mime ?? 'text/plain' };
}

async function extractPdf(buf: Buffer): Promise<string> {
  // unpdf is a small ESM-only PDF.js wrapper. Dynamic import keeps it out of CommonJS require graph.
  const { extractText: unpdfExtract } = await import('unpdf');
  const result = await unpdfExtract(new Uint8Array(buf));
  if (Array.isArray(result.text)) return result.text.join('\n\n');
  return String(result.text ?? '');
}

function extractCsv(buf: Buffer): string {
  const rows: string[][] = parseCsvSync(buf.toString('utf-8'), {
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  });
  // Flatten to a readable text form: each row on its own line, columns joined with " | "
  return rows.map((r) => r.join(' | ')).join('\n');
}
