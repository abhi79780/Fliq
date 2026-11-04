import { runAuditScan } from './audit-engine.mjs';
import { getTestById, updateTestRecord } from './storage.mjs';

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

    const { testId, url, owner, callbackUrl } = payload;
    if (!testId || !url) {
      console.warn('[scan-background] Background invocation missing required testId or url payload.');
      return;
    }

    console.log(`[scan-background] Starting background audit for test ${testId} (${url})...`);
    const job = getTestById(testId) || { id: testId, url, owner };

    // Run audit with progress callback to sync with api.mjs
    await runAuditScan(job, async (fields) => {
      // 1. Update local storage in this background worker container
      updateTestRecord(testId, fields);

      // 2. Forward updates to api.mjs so polling clients see real-time progress
      if (callbackUrl) {
        try {
          await fetch(callbackUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-fliq-internal-secret': process.env.FLIQ_INTERNAL_SECRET || 'fliq-internal-secret-2026'
            },
            body: JSON.stringify({ testId, fields }),
            signal: AbortSignal.timeout(4000)
          });
        } catch (callErr) {
          // Non-fatal if callback fails momentarily
        }
      }
    });

    console.log(`[scan-background] Background audit completed for test ${testId}.`);
  } catch (err) {
    console.error('[scan-background] Execution exception in background task:', err);
  }
};
