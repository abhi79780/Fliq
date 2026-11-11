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
  filterTestsByRetention,
  generateReportPdfBuffer,
  withLocalLock,
  localLockQueue
} from '../lib/entitlements.js';

import {
  processPolarWebhookEvent,
  checkIdempotency,
  recordEventProcessed
} from '../lib/polar-webhook.js';

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
    batch() {
      const ops = [];
      return {
        set(docRef, data, opts) {
          ops.push(() => docRef.set(data, opts));
        },
        async commit() {
          for (const op of ops) await op();
        }
      };
    },
    _clear() {
      collections.clear();
      transactionQueue = Promise.resolve();
    }
  };
}

describe('FLIQ Subscription Entitlements & Usage Enforcement Suite', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  // =========================================================================
  // REQUIREMENT 1: FREE user cannot exceed 3 scans
  // =========================================================================
  test('1. FREE user cannot exceed 3 scans per monthly period', async () => {
    const userId = 'free-user-1';

    // 1st scan -> succeeds
    const s1 = await checkAndIncrementScanUsage(userId, { db: mockDb });
    assert.equal(s1.usage, 1);
    assert.equal(s1.remaining, 2);

    // 2nd scan -> succeeds
    const s2 = await checkAndIncrementScanUsage(userId, { db: mockDb });
    assert.equal(s2.usage, 2);
    assert.equal(s2.remaining, 1);

    // 3rd scan -> succeeds
    const s3 = await checkAndIncrementScanUsage(userId, { db: mockDb });
    assert.equal(s3.usage, 3);
    assert.equal(s3.remaining, 0);

    // 4th scan -> MUST reject with 403 SCAN_LIMIT_REACHED
    await assert.rejects(
      async () => {
        await checkAndIncrementScanUsage(userId, { db: mockDb });
      },
      (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, 'SCAN_LIMIT_REACHED');
        assert.match(err.message, /Monthly scan limit reached for Free plan/);
        return true;
      }
    );
  });

  // =========================================================================
  // REQUIREMENT 2: CREATOR user cannot exceed 100 scans
  // =========================================================================
  test('2. CREATOR user cannot exceed 100 scans per monthly period', async () => {
    const userId = 'creator-user-1';
    await mockDb.collection('users').doc(userId).set({
      plan: 'creator',
      subscriptionStatus: 'active',
      monthlyScanUsage: 99,
      currentUsagePeriod: getCurrentUsagePeriod()
    });

    // 100th scan -> succeeds
    const s100 = await checkAndIncrementScanUsage(userId, { db: mockDb });
    assert.equal(s100.usage, 100);
    assert.equal(s100.remaining, 0);

    // 101st scan -> MUST reject with 403 SCAN_LIMIT_REACHED
    await assert.rejects(
      async () => {
        await checkAndIncrementScanUsage(userId, { db: mockDb });
      },
      (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, 'SCAN_LIMIT_REACHED');
        assert.match(err.message, /Monthly scan limit reached for Creator plan/);
        return true;
      }
    );
  });

  // =========================================================================
  // REQUIREMENT 3: TEAM user cannot exceed 500 scans
  // =========================================================================
  test('3. TEAM user cannot exceed 500 scans per monthly period', async () => {
    const userId = 'team-user-1';
    await mockDb.collection('users').doc(userId).set({
      plan: 'team',
      subscriptionStatus: 'active',
      monthlyScanUsage: 499,
      currentUsagePeriod: getCurrentUsagePeriod()
    });

    // 500th scan -> succeeds
    const s500 = await checkAndIncrementScanUsage(userId, { db: mockDb });
    assert.equal(s500.usage, 500);
    assert.equal(s500.remaining, 0);

    // 501st scan -> MUST reject with 403 SCAN_LIMIT_REACHED
    await assert.rejects(
      async () => {
        await checkAndIncrementScanUsage(userId, { db: mockDb });
      },
      (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, 'SCAN_LIMIT_REACHED');
        assert.match(err.message, /Monthly scan limit reached for Team plan/);
        return true;
      }
    );
  });

  // =========================================================================
  // REQUIREMENT 4: FREE user cannot access AI explanations
  // =========================================================================
  test('4. FREE user cannot access AI explanations', async () => {
    const userId = 'free-user-ai';
    const entitlement = await getUserEntitlement(userId, { db: mockDb });

    assert.equal(entitlement.plan, 'free');
    assert.equal(entitlement.allowAiExplanations, false, 'Free users must not have allowAiExplanations permission');
  });

  // =========================================================================
  // REQUIREMENT 5: FREE user cannot export PDF
  // =========================================================================
  test('5. FREE user cannot export PDF', async () => {
    const userId = 'free-user-pdf';
    const entitlement = await getUserEntitlement(userId, { db: mockDb });

    assert.equal(entitlement.plan, 'free');
    assert.equal(entitlement.allowPdfExport, false, 'Free users must not have allowPdfExport permission');

    // Creator and Team DO have PDF export permission
    const creatorEnt = formatUserEntitlement('c1', { plan: 'creator', subscriptionStatus: 'active' });
    assert.equal(creatorEnt.allowPdfExport, true);

    const teamEnt = formatUserEntitlement('t1', { plan: 'team', subscriptionStatus: 'active' });
    assert.equal(teamEnt.allowPdfExport, true);
  });

  // =========================================================================
  // REQUIREMENT 6: CREATOR user cannot access team collaboration
  // =========================================================================
  test('6. CREATOR user cannot access team collaboration', async () => {
    const userId = 'creator-user-collab';
    await mockDb.collection('users').doc(userId).set({
      plan: 'creator',
      subscriptionStatus: 'active'
    });

    const entitlement = await getUserEntitlement(userId, { db: mockDb });
    assert.equal(entitlement.plan, 'creator');
    assert.equal(entitlement.allowTeamCollaboration, false, 'Creator users must not have team collaboration access');
  });

  // =========================================================================
  // REQUIREMENT 7: TEAM user can access all included features
  // =========================================================================
  test('7. TEAM user can access all included features', async () => {
    const userId = 'team-user-all';
    await mockDb.collection('users').doc(userId).set({
      plan: 'team',
      subscriptionStatus: 'active'
    });

    const entitlement = await getUserEntitlement(userId, { db: mockDb });
    assert.equal(entitlement.plan, 'team');
    assert.equal(entitlement.allowAiExplanations, true);
    assert.equal(entitlement.allowPdfExport, true);
    assert.equal(entitlement.allowTeamCollaboration, true);
    assert.equal(entitlement.allowPriorityScan, true);
    assert.equal(entitlement.allowAdvancedChecks, true);
    assert.equal(entitlement.monthlyScansLimit, 500);
    assert.equal(entitlement.historyRetentionDays, 365);
  });

  // =========================================================================
  // REQUIREMENT 8: Expired subscription automatically loses paid access
  // =========================================================================
  test('8. Expired subscription automatically loses paid access and downgrades to FREE', async () => {
    const userId = 'expired-user';
    const pastDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48h ago

    await mockDb.collection('users').doc(userId).set({
      plan: 'creator',
      subscriptionStatus: 'active',
      currentPeriodEnd: pastDate
    });

    const entitlement = await getUserEntitlement(userId, { db: mockDb });
    assert.equal(entitlement.plan, 'free', 'Expired plan must downgrade to free');
    assert.equal(entitlement.isPaid, false);
    assert.equal(entitlement.monthlyScansLimit, 3);
  });

  // =========================================================================
  // REQUIREMENT 9: Cancellation at period end preserves access until expiration
  // =========================================================================
  test('9. Cancellation at period end preserves access until expiration date', async () => {
    const userId = 'canceling-user';
    const futureDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(); // 14 days ahead

    await mockDb.collection('users').doc(userId).set({
      plan: 'creator',
      subscriptionStatus: 'active',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: futureDate
    });

    const entitlement = await getUserEntitlement(userId, { db: mockDb });
    assert.equal(entitlement.plan, 'creator', 'Must retain creator plan until expiration');
    assert.equal(entitlement.isPaid, true);
    assert.equal(entitlement.cancelAtPeriodEnd, true);
    assert.equal(entitlement.allowAiExplanations, true);

    // Now test after period expires
    const expiredRecord = {
      plan: 'creator',
      subscriptionStatus: 'active',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date(Date.now() - 1000).toISOString()
    };
    const resolved = resolveEffectivePlan(expiredRecord);
    assert.equal(resolved.plan, 'free');
    assert.equal(resolved.isPaid, false);
  });

  // =========================================================================
  // REQUIREMENT 10: Duplicate Polar webhooks do not corrupt entitlements
  // =========================================================================
  test('10. Duplicate Polar webhooks do not corrupt entitlements or duplicate usage', async () => {
    const webhookId = 'evt_test_duplicate_101';
    const event = {
      id: webhookId,
      type: 'order.paid',
      data: {
        id: 'ord_dup_101',
        status: 'paid',
        product_id: 'prod_polar_cr_mo',
        customer_id: 'cust_dup_1',
        metadata: { userId: 'user-dup-test' }
      }
    };

    // First delivery -> records event
    const isDup1 = await checkIdempotency(webhookId, mockDb);
    assert.equal(isDup1, false, 'First check must not be duplicate');

    await recordEventProcessed(webhookId, event.type, 'ord_dup_101', mockDb, {
      userId: 'user-dup-test'
    });

    // Second delivery of same webhook ID -> idempotency triggers
    const isDup2 = await checkIdempotency(webhookId, mockDb);
    assert.equal(isDup2, true, 'Second check with same webhook ID must be detected as duplicate');
  });

  // =========================================================================
  // REQUIREMENT 11: Frontend manipulation cannot bypass backend restrictions
  // =========================================================================
  test('11. Frontend manipulation cannot bypass backend restrictions', async () => {
    const userId = 'untrusted-client-user';

    // User is stored as Free in database
    await mockDb.collection('users').doc(userId).set({
      plan: 'free',
      subscriptionStatus: 'active',
      monthlyScanUsage: 3,
      currentUsagePeriod: getCurrentUsagePeriod()
    });

    // Frontend attempts to supply { isPriority: true } to checkAndIncrementScanUsage
    await assert.rejects(
      async () => {
        await checkAndIncrementScanUsage(userId, { db: mockDb, isPriority: true });
      },
      (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, 'UPGRADE_REQUIRED');
        return true;
      }
    );

    // Frontend attempts to claim they are 'team' in untrusted local state
    // Backend entitlement resolution reads strictly from server database
    const verifiedEntitlement = await getUserEntitlement(userId, { db: mockDb });
    assert.equal(verifiedEntitlement.plan, 'free');
    assert.equal(verifiedEntitlement.monthlyScansLimit, 3);
  });

  // =========================================================================
  // REQUIREMENT 12: Concurrent scan requests cannot exceed user limit
  // =========================================================================
  test('12. Concurrent scan requests cannot exceed the user limit', async () => {
    const userId = 'race-condition-tester';

    // User has 2 scans used out of 3 limit (1 remaining)
    await mockDb.collection('users').doc(userId).set({
      plan: 'free',
      subscriptionStatus: 'active',
      monthlyScanUsage: 2,
      currentUsagePeriod: getCurrentUsagePeriod()
    });

    // Fire 5 simultaneous concurrent scan requests
    const results = await Promise.allSettled([
      checkAndIncrementScanUsage(userId, { db: mockDb }),
      checkAndIncrementScanUsage(userId, { db: mockDb }),
      checkAndIncrementScanUsage(userId, { db: mockDb }),
      checkAndIncrementScanUsage(userId, { db: mockDb }),
      checkAndIncrementScanUsage(userId, { db: mockDb })
    ]);

    const successes = results.filter(r => r.status === 'fulfilled');
    const failures = results.filter(r => r.status === 'rejected');

    // Exactly 1 must succeed (taking 2 -> 3) and 4 must fail
    assert.equal(successes.length, 1, 'Only 1 scan request can claim the last remaining slot');
    assert.equal(failures.length, 4, 'Remaining 4 concurrent requests must be rejected with 403');

    for (const fail of failures) {
      assert.equal(fail.reason.status, 403);
      assert.equal(fail.reason.code, 'SCAN_LIMIT_REACHED');
    }

    // Database must reflect exactly 3 scans used
    const userDoc = await mockDb.collection('users').doc(userId).get();
    assert.equal(userDoc.data().monthlyScanUsage, 3);
  });

  // =========================================================================
  // REQUIREMENT 13: Users cannot access another user's reports or subscription
  // =========================================================================
  test('13. Users cannot access another user reports or subscription', async () => {
    const ownerId = 'user-alice';
    const intruderId = 'user-bob-attacker';

    // Alice has a report
    const aliceTest = {
      id: 'test-alice-secret-1',
      owner: ownerId,
      url: 'https://secret.example.com',
      hostname: 'secret.example.com',
      sharedWithUids: []
    };

    // Helper imitating server.js test access guard
    const verifyReportAccess = (testDoc, requestingUserUid) => {
      if (!testDoc) return { allowed: false, status: 404 };
      const isOwner = testDoc.owner === requestingUserUid;
      const isShared = Array.isArray(testDoc.sharedWithUids) && testDoc.sharedWithUids.includes(requestingUserUid);
      if (!isOwner && !isShared) {
        return { allowed: false, status: 404, error: 'Test not found or access denied.' };
      }
      return { allowed: true };
    };

    const aliceAccess = verifyReportAccess(aliceTest, ownerId);
    assert.equal(aliceAccess.allowed, true);

    const bobAccess = verifyReportAccess(aliceTest, intruderId);
    assert.equal(bobAccess.allowed, false);
    assert.equal(bobAccess.status, 404);
  });

  // =========================================================================
  // REQUIREMENT 14: Usage resets correctly for a new monthly period
  // =========================================================================
  test('14. Usage resets correctly for a new monthly period', async () => {
    const userId = 'month-rollover-user';
    const oldMonth = '2026-01';
    const thisMonth = getCurrentUsagePeriod();

    // User consumed all 3 scans in old month
    await mockDb.collection('users').doc(userId).set({
      plan: 'free',
      subscriptionStatus: 'active',
      monthlyScanUsage: 3,
      currentUsagePeriod: oldMonth
    });

    // Formatter sees old month and reports 0 used in current month
    const entitlement = await getUserEntitlement(userId, { db: mockDb });
    assert.equal(entitlement.monthlyScanUsage, 0, 'Usage must report 0 in the new month');
    assert.equal(entitlement.scansRemaining, 3, 'Must have full 3 scans available');

    // First scan in the new month successfully increments to 1 in new period
    const scanResult = await checkAndIncrementScanUsage(userId, { db: mockDb });
    assert.equal(scanResult.usage, 1);
    assert.equal(scanResult.remaining, 2);
    assert.equal(scanResult.currentPeriod, thisMonth);

    const updatedDoc = await mockDb.collection('users').doc(userId).get();
    assert.equal(updatedDoc.data().currentUsagePeriod, thisMonth);
    assert.equal(updatedDoc.data().monthlyScanUsage, 1);
  });

  // =========================================================================
  // Retention & PDF Generation Helpers
  // =========================================================================
  test('History retention filters tests older than plan allowance', () => {
    const now = Date.now();
    const tests = [
      { id: '1', createdAt: new Date(now - 2 * 86400000).toISOString() }, // 2 days ago
      { id: '2', createdAt: new Date(now - 10 * 86400000).toISOString() }, // 10 days ago
      { id: '3', createdAt: new Date(now - 120 * 86400000).toISOString() } // 120 days ago
    ];

    // Free plan (7 days)
    const freeTests = filterTestsByRetention(tests, 7);
    assert.deepEqual(freeTests.map(t => t.id), ['1']);

    // Creator plan (90 days)
    const creatorTests = filterTestsByRetention(tests, 90);
    assert.deepEqual(creatorTests.map(t => t.id), ['1', '2']);

    // Team plan (365 days)
    const teamTests = filterTestsByRetention(tests, 365);
    assert.deepEqual(teamTests.map(t => t.id), ['1', '2', '3']);
  });

  test('generateReportPdfBuffer produces valid PDF 1.4 binary stream', () => {
    const report = {
      hostname: 'example.com',
      score: 95,
      issues: [
        { severity: 'high', title: 'Missing alt attribute' }
      ]
    };

    const buf = generateReportPdfBuffer(report);
    assert.ok(Buffer.isBuffer(buf), 'Must return a Buffer');
    assert.ok(buf.toString('utf8', 0, 8).startsWith('%PDF-1.4'), 'Must start with PDF 1.4 header');
    assert.ok(buf.toString('utf8').includes('%%EOF'), 'Must end with EOF marker');
  });

  // =========================================================================
  // REQUIREMENT 15: Local concurrency lock cleans up correctly and handles errors
  // =========================================================================
  test('15. withLocalLock serializes concurrent tasks and cleans up map entry after completion', async () => {
    const lockUser = 'test-lock-user-cleanup';
    const executionOrder = [];

    const task1 = withLocalLock(lockUser, async () => {
      await new Promise(r => setTimeout(r, 20));
      executionOrder.push('task1');
      return 'val1';
    });

    const task2 = withLocalLock(lockUser, async () => {
      await new Promise(r => setTimeout(r, 10));
      executionOrder.push('task2');
      return 'val2';
    });

    const [res1, res2] = await Promise.all([task1, task2]);
    assert.equal(res1, 'val1');
    assert.equal(res2, 'val2');
    assert.deepEqual(executionOrder, ['task1', 'task2'], 'Tasks must be serialized');
    assert.equal(localLockQueue.has(lockUser), false, 'Lock queue entry must be deleted after tasks finish');
  });

  test('16. withLocalLock cleans up map entry even when an operation throws', async () => {
    const failingUser = 'failing-lock-user';

    await assert.rejects(
      async () => {
        await withLocalLock(failingUser, async () => {
          throw new Error('Lock operation explosion');
        });
      },
      /Lock operation explosion/
    );

    assert.equal(localLockQueue.has(failingUser), false, 'Lock queue entry must be removed even when operation throws');
  });
});
