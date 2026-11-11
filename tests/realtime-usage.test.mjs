import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PLAN_CONFIGS,
  getCurrentUsagePeriod,
  resolveEffectivePlan,
  formatUserEntitlement,
  getUserEntitlement,
  checkAndIncrementScanUsage,
  refundScanUsage,
  withLocalLock
} from '../lib/entitlements.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const testDataDir = path.join(rootDir, 'data');

// Mock in-memory Firestore with transaction support
function createMockDb() {
  const collections = new Map();
  let transactionQueue = Promise.resolve();

  const getCol = (name) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };

  return {
    collection(name) {
      const col = getCol(name);
      return {
        doc(id) {
          return {
            id,
            async get() {
              const val = col.get(id);
              return {
                id,
                exists: val !== undefined,
                data: () => val ? JSON.parse(JSON.stringify(val)) : undefined
              };
            },
            async set(data, opts = {}) {
              const prev = col.get(id) || {};
              const next = opts.merge ? { ...prev, ...data } : { ...data };
              col.set(id, JSON.parse(JSON.stringify(next)));
            }
          };
        }
      };
    },
    async runTransaction(updateFn) {
      const prevTx = transactionQueue;
      let releaseTx;
      transactionQueue = new Promise(resolve => { releaseTx = resolve; });
      await prevTx;

      try {
        const stagedWrites = [];
        const transaction = {
          async get(docRef) {
            return await docRef.get();
          },
          set(docRef, data, opts) {
            stagedWrites.push(() => docRef.set(data, opts));
          }
        };

        const result = await updateFn(transaction);

        for (const write of stagedWrites) {
          await write();
        }

        return result;
      } finally {
        releaseTx();
      }
    },
    _clear() {
      collections.clear();
      transactionQueue = Promise.resolve();
    }
  };
}

describe('FLIQ Real-Time Subscription Usage Updates Suite', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  // =========================================================================
  // SCENARIO 1: Creator user completes scan -> usage updates 0/100 -> 1/100, 99 left
  // =========================================================================
  test('1. Creator user completes scan: usage updates from 0/100 to 1/100 and remaining from 100 to 99', async () => {
    const userId = 'realtime-creator-1';
    const period = getCurrentUsagePeriod();

    // Initial Creator account setup (0 scans consumed)
    await mockDb.collection('users').doc(userId).set({
      plan: 'creator',
      subscriptionStatus: 'active',
      monthlyScanUsage: 0,
      currentUsagePeriod: period,
      billingInterval: 'monthly',
      price: '$9 / month'
    });

    const initialEntitlement = await getUserEntitlement(userId, { db: mockDb });
    assert.equal(initialEntitlement.plan, 'creator');
    assert.equal(initialEntitlement.monthlyScanUsage, 0);
    assert.equal(initialEntitlement.monthlyScansLimit, 100);
    assert.equal(initialEntitlement.scansRemaining, 100);
    assert.equal(initialEntitlement.isPaid, true);

    // Backend claims scan slot & increments usage atomically
    const scanUsageResult = await checkAndIncrementScanUsage(userId, { db: mockDb });
    assert.equal(scanUsageResult.usage, 1);
    assert.equal(scanUsageResult.remaining, 99);

    // Completed scan resolves latest authoritative entitlement
    const completedEntitlement = await getUserEntitlement(userId, { db: mockDb });
    assert.equal(completedEntitlement.monthlyScanUsage, 1);
    assert.equal(completedEntitlement.monthlyScansLimit, 100);
    assert.equal(completedEntitlement.scansRemaining, 99);

    // Verify plan metadata remains strictly unchanged
    assert.equal(completedEntitlement.plan, 'creator');
    assert.equal(completedEntitlement.planName, 'Creator');
    assert.equal(completedEntitlement.isPaid, true);
    assert.equal(completedEntitlement.subscriptionStatus, 'active');
  });

  // =========================================================================
  // SCENARIO 2: Scan failure/timeout refunds usage quota
  // =========================================================================
  test('2. Scan failure or timeout refunds usage quota so users are not penalized', async () => {
    const userId = 'realtime-creator-fail-test';
    const period = getCurrentUsagePeriod();

    await mockDb.collection('users').doc(userId).set({
      plan: 'creator',
      subscriptionStatus: 'active',
      monthlyScanUsage: 0,
      currentUsagePeriod: period
    });

    // 1. Scan started: usage increments 0 -> 1
    const startResult = await checkAndIncrementScanUsage(userId, { db: mockDb });
    assert.equal(startResult.usage, 1);
    assert.equal(startResult.remaining, 99);

    // 2. Scan encounters fatal error or 90s timeout -> server calls refundScanUsage
    const refundResult = await refundScanUsage(userId, { db: mockDb });
    assert.ok(refundResult);
    assert.equal(refundResult.success, true);
    assert.equal(refundResult.usage, 0);

    // 3. User entitlement after refund returns full 100 remaining scans
    const postRefundEntitlement = await getUserEntitlement(userId, { db: mockDb });
    assert.equal(postRefundEntitlement.monthlyScanUsage, 0);
    assert.equal(postRefundEntitlement.scansRemaining, 100);
  });

  // =========================================================================
  // SCENARIO 3: Multiple consecutive scans update usage progressively (1/100, 2/100)
  // =========================================================================
  test('3. Multiple consecutive scans update usage progressively (1/100, 2/100, 3/100)', async () => {
    const userId = 'realtime-creator-consecutive';
    const period = getCurrentUsagePeriod();

    await mockDb.collection('users').doc(userId).set({
      plan: 'creator',
      subscriptionStatus: 'active',
      monthlyScanUsage: 0,
      currentUsagePeriod: period
    });

    // Scan 1
    const s1 = await checkAndIncrementScanUsage(userId, { db: mockDb });
    assert.equal(s1.usage, 1);
    assert.equal(s1.remaining, 99);

    let ent1 = await getUserEntitlement(userId, { db: mockDb });
    assert.equal(ent1.monthlyScanUsage, 1);
    assert.equal(ent1.scansRemaining, 99);

    // Scan 2
    const s2 = await checkAndIncrementScanUsage(userId, { db: mockDb });
    assert.equal(s2.usage, 2);
    assert.equal(s2.remaining, 98);

    let ent2 = await getUserEntitlement(userId, { db: mockDb });
    assert.equal(ent2.monthlyScanUsage, 2);
    assert.equal(ent2.scansRemaining, 98);

    // Scan 3
    const s3 = await checkAndIncrementScanUsage(userId, { db: mockDb });
    assert.equal(s3.usage, 3);
    assert.equal(s3.remaining, 97);

    let ent3 = await getUserEntitlement(userId, { db: mockDb });
    assert.equal(ent3.monthlyScanUsage, 3);
    assert.equal(ent3.scansRemaining, 97);
  });

  // =========================================================================
  // SCENARIO 4: Completed and failed test payloads include authoritative entitlement
  // =========================================================================
  test('4. Scan completion payload includes authoritative entitlement matching backend state', async () => {
    const userId = 'realtime-payload-test-user';
    const period = getCurrentUsagePeriod();

    await mockDb.collection('users').doc(userId).set({
      plan: 'creator',
      subscriptionStatus: 'active',
      monthlyScanUsage: 0,
      currentUsagePeriod: period
    });

    await checkAndIncrementScanUsage(userId, { db: mockDb });
    const latestEntitlement = await getUserEntitlement(userId, { db: mockDb });

    // Emulate server.js executeTest completion payload
    const completedPayload = {
      status: 'completed',
      progress: 100,
      stage: 'Complete',
      completedAt: new Date().toISOString(),
      score: 95,
      issues: [],
      entitlement: latestEntitlement
    };

    assert.ok(completedPayload.entitlement, 'Payload must contain entitlement');
    assert.equal(completedPayload.entitlement.monthlyScanUsage, 1);
    assert.equal(completedPayload.entitlement.scansRemaining, 99);
    assert.equal(completedPayload.entitlement.plan, 'creator');
  });

  // =========================================================================
  // SCENARIO 5: In-place DOM update function updates counters without full refresh
  // =========================================================================
  test('5. Billing UI update logic updates monthly usage and scans remaining elements correctly', () => {
    // Simulate DOM elements for Settings -> Billing
    const mockElements = {
      '#billing-monthly-usage': { textContent: '0 / 100 scans' },
      '#billing-scans-remaining': { textContent: '100 left' }
    };

    const mockDocument = {
      querySelector: (selector) => mockElements[selector] || null
    };

    // Implementation matching app.js updateBillingUi
    function simulateUpdateBillingUi(ent, doc = mockDocument) {
      if (!ent) return;
      const usageEl = doc.querySelector('#billing-monthly-usage');
      const remainingEl = doc.querySelector('#billing-scans-remaining');
      if (usageEl) {
        usageEl.textContent = `${ent.monthlyScanUsage || 0} / ${ent.monthlyScansLimit || 3} scans`;
      }
      if (remainingEl) {
        remainingEl.textContent = `${ent.scansRemaining ?? 3} left`;
      }
    }

    const updatedEntitlement = {
      plan: 'creator',
      planName: 'Creator',
      monthlyScanUsage: 1,
      monthlyScansLimit: 100,
      scansRemaining: 99
    };

    simulateUpdateBillingUi(updatedEntitlement, mockDocument);

    assert.equal(mockElements['#billing-monthly-usage'].textContent, '1 / 100 scans');
    assert.equal(mockElements['#billing-scans-remaining'].textContent, '99 left');

    // Simulate next scan
    const nextEntitlement = {
      plan: 'creator',
      planName: 'Creator',
      monthlyScanUsage: 2,
      monthlyScansLimit: 100,
      scansRemaining: 98
    };

    simulateUpdateBillingUi(nextEntitlement, mockDocument);

    assert.equal(mockElements['#billing-monthly-usage'].textContent, '2 / 100 scans');
    assert.equal(mockElements['#billing-scans-remaining'].textContent, '98 left');
  });

  // =========================================================================
  // SCENARIO 6: Cross-tab synchronization via broadcast channel payload
  // =========================================================================
  test('6. Cross-tab sync correctly formats and processes broadcast sync payload', () => {
    let tabA_broadcast = null;
    let tabB_received = null;

    // Tab A broadcasts updated entitlement
    const updatedEnt = {
      plan: 'creator',
      planName: 'Creator',
      isPaid: true,
      monthlyScanUsage: 1,
      monthlyScansLimit: 100,
      scansRemaining: 99
    };

    tabA_broadcast = {
      type: 'ENTITLEMENT_SYNC',
      entitlement: updatedEnt,
      timestamp: Date.now()
    };

    // Tab B listener handles incoming message
    if (tabA_broadcast?.type === 'ENTITLEMENT_SYNC' && tabA_broadcast.entitlement) {
      tabB_received = tabA_broadcast.entitlement;
    }

    assert.ok(tabB_received);
    assert.equal(tabB_received.monthlyScanUsage, 1);
    assert.equal(tabB_received.scansRemaining, 99);
    assert.equal(tabB_received.plan, 'creator');
  });

  // =========================================================================
  // SCENARIO 7: Concurrency lock prevents overshooting plan limit under heavy load
  // =========================================================================
  test('7. Concurrency lock prevents overshooting Creator 100-scan limit under load', async () => {
    const userId = 'creator-race-load-test';
    const period = getCurrentUsagePeriod();

    await mockDb.collection('users').doc(userId).set({
      plan: 'creator',
      subscriptionStatus: 'active',
      monthlyScanUsage: 99,
      currentUsagePeriod: period
    });

    // 10 concurrent requests at 99/100 -> exactly 1 succeeds, 9 fail with 403
    const tasks = Array.from({ length: 10 }).map(() =>
      checkAndIncrementScanUsage(userId, { db: mockDb })
    );

    const outcomes = await Promise.allSettled(tasks);
    const succeeded = outcomes.filter(o => o.status === 'fulfilled');
    const failed = outcomes.filter(o => o.status === 'rejected');

    assert.equal(succeeded.length, 1, 'Only 1 request can take the 100th scan');
    assert.equal(failed.length, 9, 'All 9 overflow requests must be rejected');

    for (const f of failed) {
      assert.equal(f.reason.status, 403);
      assert.equal(f.reason.code, 'SCAN_LIMIT_REACHED');
    }

    const finalEnt = await getUserEntitlement(userId, { db: mockDb });
    assert.equal(finalEnt.monthlyScanUsage, 100);
    assert.equal(finalEnt.scansRemaining, 0);
  });

  // =========================================================================
  // SCENARIO 8: Local file storage fallback accurately maintains usage & refund
  // =========================================================================
  test('8. Local file storage fallback maintains real-time usage and refund integrity', async () => {
    const tempDir = path.join(testDataDir, `realtime-local-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    try {
      const subFile = path.join(tempDir, 'subscriptions.json');
      const period = getCurrentUsagePeriod();
      const initial = [
        {
          userId: 'local-realtime-user',
          plan: 'creator',
          subscriptionStatus: 'active',
          monthlyScanUsage: 0,
          currentUsagePeriod: period
        }
      ];
      await fs.writeFile(subFile, JSON.stringify(initial, null, 2), 'utf8');

      // Scan 1 succeeds (0 -> 1)
      const scan1 = await checkAndIncrementScanUsage('local-realtime-user', { localDataDir: tempDir });
      assert.equal(scan1.usage, 1);
      assert.equal(scan1.remaining, 99);

      // Scan 2 fails -> refund
      const scan2 = await checkAndIncrementScanUsage('local-realtime-user', { localDataDir: tempDir });
      assert.equal(scan2.usage, 2);
      assert.equal(scan2.remaining, 98);

      const refund = await refundScanUsage('local-realtime-user', { localDataDir: tempDir });
      assert.equal(refund.usage, 1);

      const ent = await getUserEntitlement('local-realtime-user', { localDataDir: tempDir });
      assert.equal(ent.monthlyScanUsage, 1);
      assert.equal(ent.scansRemaining, 99);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
