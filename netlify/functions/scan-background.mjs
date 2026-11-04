import { runAuditScan } from './audit-engine.mjs';
import { getTestById } from './storage.mjs';

/**
 * Netlify Background Function: scan-background.mjs
 * 
 * Invoked asynchronously via Netlify's Background Function infrastructure.
 * Netlify automatically acknowledges requests to this function with HTTP 202 Accepted
 * and permits up to 15 minutes (900 seconds) of background execution time.
 */
export const handler = async (event, context) => {
  console.log('[scan-background] Netlify Background Function triggered.');

  try {
    let payload = {};
    if (event.body) {
      payload = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    }

    const { testId, url, owner } = payload;
    if (!testId || !url) {
      console.warn('[scan-background] Background invocation missing required testId or url payload.');
      return;
    }

    console.log(`[scan-background] Starting background audit for test ${testId} (${url})...`);
    const job = getTestById(testId) || { id: testId, url, owner };
    await runAuditScan(job);
    console.log(`[scan-background] Background audit finished for test ${testId}.`);
  } catch (err) {
    console.error('[scan-background] Execution exception in background task:', err);
  }
};
