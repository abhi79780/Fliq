import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseConcurrentScans,
  acquireScanSlot,
  releaseScanSlot,
  getQueueStatus,
  withDeadline,
  validateTarget
} from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');

describe('FLIQ Scan Queue & Concurrency Reliability Suite', () => {

  test('1. parseConcurrentScans returns correct bounded values', () => {
    assert.equal(parseConcurrentScans(undefined, 'production'), 1);
    assert.equal(parseConcurrentScans(undefined, 'development'), 3);
    assert.equal(parseConcurrentScans('2', 'production'), 2);
    assert.equal(parseConcurrentScans('3', 'production'), 3);
    assert.equal(parseConcurrentScans('10', 'production'), 1); // Exceeds max 3, falls back to default
    assert.equal(parseConcurrentScans('invalid', 'production'), 1);
  });

  test('2. acquireScanSlot grants slot and returns idempotent release function', async () => {
    const initialStatus = getQueueStatus();
    const testJobId = `test-job-acquire-${Date.now()}`;
    
    // Acquire a slot
    const release = await acquireScanSlot(testJobId, 5000);
    assert.ok(typeof release === 'function', 'Must return release function');
    
    const statusDuring = getQueueStatus();
    assert.ok(statusDuring.activeScans >= 1, 'Active scans must be incremented');
    assert.ok(statusDuring.activeJobIds.includes(testJobId), 'Job ID must be tracked');

    // Call release
    release();
    const statusAfter = getQueueStatus();
    assert.equal(statusAfter.activeJobIds.includes(testJobId), false, 'Job ID must be removed');

    // Calling release a second time must be idempotent (no negative count)
    release();
    const statusDouble = getQueueStatus();
    assert.equal(statusDouble.activeScans, statusAfter.activeScans, 'Release must be idempotent');
  });

  test('3. acquireScanSlot queues excess requests and resolves when slot is released', async () => {
    const jobA = `job-a-${Date.now()}`;
    const jobB = `job-b-${Date.now()}`;

    // Acquire slot for job A
    const releaseA = await acquireScanSlot(jobA, 5000);
    const max = getQueueStatus().maxConcurrent;

    // Fill all remaining concurrent slots
    const extraReleases = [];
    while (getQueueStatus().activeScans < max) {
      const r = await acquireScanSlot(`job-extra-${extraReleases.length}`, 5000);
      extraReleases.push(r);
    }

    // Now all slots are full. Job B should enter the wait queue
    let jobBAcquired = false;
    let releaseB = null;
    const jobBPromise = acquireScanSlot(jobB, 5000).then(r => {
      jobBAcquired = true;
      releaseB = r;
      return r;
    });

    // Check queue status: Job B must be waiting
    const queuedStatus = getQueueStatus();
    assert.ok(queuedStatus.waitingScans >= 1, 'Job B must be waiting in queue');
    assert.equal(jobBAcquired, false, 'Job B must not acquire slot before release');

    // Release slot A: Job B should now be unblocked and acquire slot
    releaseA();
    await jobBPromise;

    assert.equal(jobBAcquired, true, 'Job B must acquire slot after slot A released');
    assert.ok(typeof releaseB === 'function');

    // Cleanup
    releaseB();
    for (const r of extraReleases) r();
  });

  test('4. acquireScanSlot times out gracefully when no slot becomes available', async () => {
    const jobBlocker = `job-blocker-${Date.now()}`;
    const jobTimeout = `job-timeout-${Date.now()}`;

    // Fill slots
    const blockerReleases = [];
    const max = getQueueStatus().maxConcurrent;
    for (let i = getQueueStatus().activeScans; i < max; i++) {
      const r = await acquireScanSlot(`blocker-${i}`, 5000);
      blockerReleases.push(r);
    }

    // Attempt to acquire with very short timeout (50ms)
    await assert.rejects(
      async () => {
        await acquireScanSlot(jobTimeout, 50);
      },
      (err) => {
        assert.equal(err.code, 'QUEUE_TIMEOUT');
        assert.equal(err.status, 503);
        return true;
      },
      'Queue wait must reject with QUEUE_TIMEOUT when maxWaitMs is exceeded'
    );

    // Verify queue is cleaned up (timed out item removed)
    const status = getQueueStatus();
    assert.equal(status.waitingScans, 0, 'Timed out item must be spliced from scanWaitQueue');

    // Cleanup blockers
    for (const r of blockerReleases) r();
  });

  test('5. withDeadline resolves on time and falls back when exceeded', async () => {
    // Fast promise resolves normally
    const fast = Promise.resolve('fast-result');
    const fastRes = await withDeadline(fast, 1000, 'fallback', 'fast-op');
    assert.equal(fastRes, 'fast-result');

    // Slow promise hits deadline and returns fallback
    const slow = new Promise(resolve => setTimeout(() => resolve('slow-result'), 500));
    const slowRes = await withDeadline(slow, 50, 'fallback', 'slow-op');
    assert.equal(slowRes, 'fallback');

    // Rejection is properly propagated without unhandled rejection
    const failing = Promise.reject(new Error('operational error'));
    await assert.rejects(
      async () => withDeadline(failing, 1000, null, 'failing-op'),
      /operational error/
    );
  });

  test('6. validateTarget enforces SSRF defense and accepts public domains', async () => {
    // Valid public domains
    const ex = await validateTarget('https://example.com');
    assert.equal(ex.hostname, 'example.com');
    assert.equal(ex.url, 'https://example.com/');

    // Block localhost
    await assert.rejects(async () => validateTarget('http://localhost:8080'), /not publicly reachable/);
    await assert.rejects(async () => validateTarget('http://127.0.0.1'), /restricted network address/);
    await assert.rejects(async () => validateTarget('http://169.254.169.254'), /not publicly reachable/);
    await assert.rejects(async () => validateTarget('http://metadata.google.internal'), /not publicly reachable/);
    await assert.rejects(async () => validateTarget('http://10.0.0.1'), /restricted network address/);
    await assert.rejects(async () => validateTarget('http://192.168.1.1'), /restricted network address/);
  });

  test('7. releaseScanSlot on unacquired job does not decrement count or corrupt queue', async () => {
    const initialStatus = getQueueStatus();
    // Releasing a completely unknown job ID must be a safe no-op
    releaseScanSlot('rogue-job-never-acquired');
    const afterRogue = getQueueStatus();
    assert.equal(afterRogue.activeScans, initialStatus.activeScans, 'Rogue release must not decrement active count');
  });
});
