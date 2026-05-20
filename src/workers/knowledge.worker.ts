/**
 * Knowledge extraction worker.
 *
 * Polls campaign_knowledge_files where extraction_status='pending', extracts
 * text from the S3 object, writes extracted_text + status='extracted'.
 * AI summarization is wired up in Phase 9 (will set summary + document_type).
 */
import { loadEnv } from '../config/env';
import { initDb, closeDb } from '../config/db';
import { createLogger } from '../config/logger';
import { claimNextPending, markExtracted, markExtractionFailed } from '../services/knowledge.service';
import { getObjectBuffer } from '../services/s3.service';
import { extractText } from '../services/extraction.service';

const POLL_INTERVAL_MS = 5_000;
const MAX_CONSECUTIVE_ERRORS = 10;

let shouldStop = false;
const log = createLogger(process.env.LOG_LEVEL ?? 'info').child({ worker: 'knowledge' });

async function processOne(): Promise<boolean> {
  const file = await claimNextPending();
  if (!file) return false;

  log.info({ fileId: file.id, fileName: file.fileName }, 'extraction: claimed');
  try {
    if (!file.s3Url) {
      // Already-pasted notes are stored as extracted; should not be queued. Mark complete.
      await markExtracted(file.id, { extractedText: file.extractedText ?? '' });
      return true;
    }
    const key = file.s3Url.replace(/^s3:\/\/[^/]+\//, '');
    const buf = await getObjectBuffer(key);
    const { text } = await extractText(buf, file.fileName, file.fileType ?? undefined);
    await markExtracted(file.id, { extractedText: text });
    log.info({ fileId: file.id, chars: text.length }, 'extraction: done');
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ fileId: file.id, err: msg }, 'extraction: failed');
    await markExtractionFailed(file.id, msg);
    return true;
  }
}

async function main(): Promise<void> {
  await loadEnv();
  initDb();
  log.info('starting knowledge worker');

  let errors = 0;
  while (!shouldStop) {
    try {
      const did = await processOne();
      errors = 0;
      if (!did) await sleep(POLL_INTERVAL_MS);
    } catch (err) {
      errors++;
      log.error({ err }, 'poll error');
      if (errors >= MAX_CONSECUTIVE_ERRORS) {
        log.fatal('too many consecutive errors, exiting');
        process.exit(1);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  await closeDb();
  log.info('knowledge worker stopped');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const close = (signal: string) => {
  log.info({ signal }, 'shutting down');
  shouldStop = true;
};
process.on('SIGINT', () => close('SIGINT'));
process.on('SIGTERM', () => close('SIGTERM'));

main().catch((err) => {
  log.fatal({ err }, 'fatal worker error');
  process.exit(1);
});
