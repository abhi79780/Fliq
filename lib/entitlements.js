/**
 * FLIQ Central Subscription Entitlement and Usage Enforcement Service
 *
 * Source of truth: Firestore (with fallback local persistence for offline / preview)
 * Enforces:
 * - Exact plan limits: Free (3), Creator (100), Team (500)
 * - Atomic usage accounting with concurrency safety
 * - Automatic monthly usage period reset (YYYY-MM)
 * - Feature access control: AI explanations, PDF export, Team collaboration, Priority scanning
 * - History retention limits: Free (7 days), Creator (90 days), Team (365 days)
 * - Subscription lifecycle: Active, Canceled (at period end vs immediate), Past-due grace, Expired, Revoked, Refunded
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export const PLAN_CONFIGS = {
  free: {
    plan: 'free',
    name: 'Free',
    monthlyPrice: 0,
    yearlyPrice: 0,
    monthlyScans: 3,
    historyRetentionDays: 7,
    allowAiExplanations: false,
    allowPdfExport: false,
    allowTeamCollaboration: false,
    allowPriorityScan: false,
    allowAdvancedChecks: false,
    supportLevel: 'community'
  },
  creator: {
    plan: 'creator',
    name: 'Creator',
    monthlyPrice: 9,
    yearlyPrice: 84,
    monthlyScans: 100,
    historyRetentionDays: 90,
    allowAiExplanations: true,
    allowPdfExport: true,
    allowTeamCollaboration: false,
    allowPriorityScan: false,
    allowAdvancedChecks: true,
    supportLevel: 'email'
  },
  team: {
    plan: 'team',
    name: 'Team',
    monthlyPrice: 19.99,
    yearlyPrice: 188,
    monthlyScans: 500,
    historyRetentionDays: 365,
    allowAiExplanations: true,
    allowPdfExport: true,
    allowTeamCollaboration: true,
    allowPriorityScan: true,
    allowAdvancedChecks: true,
    supportLevel: 'priority'
  }
};

/**
 * Returns canonical current usage period string: 'YYYY-MM' (UTC)
 */
export function getCurrentUsagePeriod(date = new Date()) {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Determines the effective active plan taking into account subscription status,
 * expiration dates, cancel_at_period_end, and past-due grace period.
 */
export function resolveEffectivePlan(userData = {}) {
  const rawPlan = String(userData?.plan || 'free').trim().toLowerCase();
  const plan = (rawPlan === 'creator' || rawPlan === 'team') ? rawPlan : 'free';
  const status = String(userData?.subscriptionStatus || 'active').trim().toLowerCase();

  // Free plan is always free
  if (plan === 'free') {
    return { plan: 'free', status: 'active', isPaid: false };
  }

  const now = Date.now();
  const periodEnd = userData?.currentPeriodEnd ? new Date(userData.currentPeriodEnd).getTime() : null;
  const isCanceledAtPeriodEnd = Boolean(userData?.cancelAtPeriodEnd);

  // Revoked or refunded immediately loses paid status
  if (status === 'refunded' || status === 'revoked') {
    return { plan: 'free', status, isPaid: false };
  }

  // Canceled at period end: retains paid plan until the period expires
  if (isCanceledAtPeriodEnd) {
    if (periodEnd && now > periodEnd) {
      return { plan: 'free', status: 'expired', isPaid: false };
    }
    return { plan, status: 'canceled_active_until_period_end', isPaid: true };
  }

  // Immediate cancellation
  if (status === 'canceled') {
    return { plan: 'free', status: 'canceled', isPaid: false };
  }

  // Expired
  if (status === 'expired') {
    return { plan: 'free', status: 'expired', isPaid: false };
  }

  // Past due: 3-day grace period
  if (status === 'past_due') {
    const anchor = periodEnd || (userData?.updatedAt ? new Date(userData.updatedAt).getTime() : now);
    const graceMs = 3 * 24 * 60 * 60 * 1000;
    if (now > anchor + graceMs) {
      return { plan: 'free', status: 'past_due_restricted', isPaid: false };
    }
    return { plan, status: 'past_due_grace', isPaid: true };
  }

  // If periodEnd has passed by more than 24h without renewal update
  if (periodEnd && !isCanceledAtPeriodEnd && now > periodEnd + (24 * 60 * 60 * 1000)) {
    return { plan: 'free', status: 'expired', isPaid: false };
  }

  return { plan, status: 'active', isPaid: true };
}

/**
 * Returns a standardized user entitlement object.
 */
export function formatUserEntitlement(userId, rawUser = {}) {
  const effective = resolveEffectivePlan(rawUser);
  const planConfig = PLAN_CONFIGS[effective.plan] || PLAN_CONFIGS.free;
  const currentPeriod = getCurrentUsagePeriod();

  const recordPeriod = rawUser.currentUsagePeriod || currentPeriod;
  const rawUsage = typeof rawUser.monthlyScanUsage === 'number' ? rawUser.monthlyScanUsage : 0;
  const monthlyScanUsage = (recordPeriod === currentPeriod) ? rawUsage : 0;

  const limit = planConfig.monthlyScans;
  const scansRemaining = Math.max(0, limit - monthlyScanUsage);

  return {
    userId,
    plan: planConfig.plan,
    planName: planConfig.name,
    subscriptionStatus: effective.status,
    isPaid: effective.isPaid,
    billingInterval: rawUser.billingInterval || 'monthly',
    monthlyScansLimit: limit,
    monthlyScanUsage,
    scansRemaining,
    currentUsagePeriod: currentPeriod,
    historyRetentionDays: planConfig.historyRetentionDays,
    allowAiExplanations: planConfig.allowAiExplanations,
    allowPdfExport: planConfig.allowPdfExport,
    allowTeamCollaboration: planConfig.allowTeamCollaboration,
    allowPriorityScan: planConfig.allowPriorityScan,
    allowAdvancedChecks: planConfig.allowAdvancedChecks,
    polarCustomerId: rawUser.polarCustomerId || null,
    polarSubscriptionId: rawUser.polarSubscriptionId || null,
    cancelAtPeriodEnd: Boolean(rawUser.cancelAtPeriodEnd),
    currentPeriodStart: rawUser.currentPeriodStart || null,
    currentPeriodEnd: rawUser.currentPeriodEnd || null,
    nextBillingDate: effective.isPaid ? (rawUser.currentPeriodEnd || null) : null
  };
}

/**
 * Reads user subscription record from Firestore or fallback local storage.
 */
export async function getUserRecord(userId, { db, localDataDir }) {
  if (!userId) return null;

  if (db && userId !== 'local') {
    try {
      const doc = await db.collection('users').doc(userId).get();
      if (doc.exists) {
        return doc.data();
      }
    } catch (err) {
      console.warn('[Entitlements] Firestore user read warning:', err.message);
    }
  }

  if (localDataDir) {
    try {
      const file = path.join(localDataDir, 'subscriptions.json');
      const list = JSON.parse(await fs.readFile(file, 'utf8'));
      const found = list.find(s => s.userId === userId);
      if (found) return found;
    } catch {}
  }

  return null;
}

/**
 * Returns the full user entitlement object, resolving live from the database.
 */
export async function getUserEntitlement(userId, { db, localDataDir }) {
  const record = await getUserRecord(userId, { db, localDataDir });
  return formatUserEntitlement(userId, record || {});
}

// In-process concurrency lock for local fallback storage
export const localLockQueue = new Map();

export async function withLocalLock(userId, fn) {
  let prevPromise = localLockQueue.get(userId) || Promise.resolve();
  let release;
  const lockPromise = new Promise(resolve => { release = resolve; });
  const queuedPromise = prevPromise.catch(() => {}).then(() => lockPromise);
  localLockQueue.set(userId, queuedPromise);

  try {
    await prevPromise.catch(() => {});
    return await fn();
  } finally {
    release();
    if (localLockQueue.get(userId) === queuedPromise) {
      localLockQueue.delete(userId);
    }
  }
}

/**
 * Atomically checks scan limits and increments usage.
 * Uses Firestore transactions when Firestore is connected, or an in-memory lock
 * for local fallback to prevent race conditions.
 *
 * Throws an Error with status 403 and code SCAN_LIMIT_REACHED if the user is at/over limit.
 */
export async function checkAndIncrementScanUsage(userId, { db, localDataDir, isPriority = false }) {
  if (!userId) {
    const err = new Error('Authentication required to run scans.');
    err.status = 401;
    throw err;
  }

  // Path 1: Firestore atomic transaction
  if (db && userId !== 'local') {
    return await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(userId);
      const snap = await transaction.get(userRef);
      const rawData = snap.exists ? snap.data() : { plan: 'free' };

      const effective = resolveEffectivePlan(rawData);
      const planConfig = PLAN_CONFIGS[effective.plan] || PLAN_CONFIGS.free;

      if (isPriority && !planConfig.allowPriorityScan) {
        const err = new Error('Priority scanning requires a Team subscription.');
        err.status = 403;
        err.code = 'UPGRADE_REQUIRED';
        err.requiredPlan = 'team';
        throw err;
      }

      const currentPeriod = getCurrentUsagePeriod();
      const recordPeriod = rawData.currentUsagePeriod || currentPeriod;
      const currentUsage = (recordPeriod === currentPeriod && typeof rawData.monthlyScanUsage === 'number')
        ? rawData.monthlyScanUsage
        : 0;

      const limit = planConfig.monthlyScans;
      if (currentUsage >= limit) {
        const err = new Error(`Monthly scan limit reached for ${planConfig.name} plan (${currentUsage}/${limit} scans used). Upgrade your plan to run more scans.`);
        err.status = 403;
        err.code = 'SCAN_LIMIT_REACHED';
        err.details = {
          plan: planConfig.plan,
          limit,
          usage: currentUsage,
          remaining: 0
        };
        throw err;
      }

      const newUsage = currentUsage + 1;
      const updates = {
        monthlyScanUsage: newUsage,
        currentUsagePeriod: currentPeriod,
        lastScanAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (!snap.exists) {
        updates.plan = 'free';
        updates.planName = 'Free';
        updates.subscriptionStatus = 'active';
        updates.createdAt = new Date().toISOString();
      }

      transaction.set(userRef, updates, { merge: true });

      return {
        success: true,
        plan: planConfig.plan,
        usage: newUsage,
        limit,
        remaining: limit - newUsage,
        currentPeriod
      };
    });
  }

  // Path 2: Local fallback with atomic locking
  return await withLocalLock(userId, async () => {
    let list = [];
    const file = localDataDir ? path.join(localDataDir, 'subscriptions.json') : null;
    if (file) {
      try {
        list = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {}
    }

    let userRecord = list.find(s => s.userId === userId);
    if (!userRecord) {
      userRecord = { userId, plan: 'free', monthlyScanUsage: 0 };
    }

    const effective = resolveEffectivePlan(userRecord);
    const planConfig = PLAN_CONFIGS[effective.plan] || PLAN_CONFIGS.free;

    if (isPriority && !planConfig.allowPriorityScan) {
      const err = new Error('Priority scanning requires a Team subscription.');
      err.status = 403;
      err.code = 'UPGRADE_REQUIRED';
      err.requiredPlan = 'team';
      throw err;
    }

    const currentPeriod = getCurrentUsagePeriod();
    const recordPeriod = userRecord.currentUsagePeriod || currentPeriod;
    const currentUsage = (recordPeriod === currentPeriod && typeof userRecord.monthlyScanUsage === 'number')
      ? userRecord.monthlyScanUsage
      : 0;

    const limit = planConfig.monthlyScans;
    if (currentUsage >= limit) {
      const err = new Error(`Monthly scan limit reached for ${planConfig.name} plan (${currentUsage}/${limit} scans used). Upgrade your plan to run more scans.`);
      err.status = 403;
      err.code = 'SCAN_LIMIT_REACHED';
      err.details = {
        plan: planConfig.plan,
        limit,
        usage: currentUsage,
        remaining: 0
      };
      throw err;
    }

    const newUsage = currentUsage + 1;
    userRecord.monthlyScanUsage = newUsage;
    userRecord.currentUsagePeriod = currentPeriod;
    userRecord.lastScanAt = new Date().toISOString();
    userRecord.updatedAt = new Date().toISOString();

    const idx = list.findIndex(s => s.userId === userId);
    if (idx >= 0) list[idx] = userRecord;
    else list.push(userRecord);

    if (file) {
      await fs.writeFile(file, JSON.stringify(list, null, 2), 'utf8');
    }

    return {
      success: true,
      plan: planConfig.plan,
      usage: newUsage,
      limit,
      remaining: limit - newUsage,
      currentPeriod
    };
  });
}

/**
 * Reverts/refunds 1 scan usage count if a scan execution fails.
 * Ensures users are not penalized for scans that encountered execution failures.
 */
export async function refundScanUsage(userId, { db, localDataDir } = {}) {
  if (!userId) return null;

  // Path 1: Firestore atomic transaction
  if (db && userId !== 'local') {
    return await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(userId);
      const snap = await transaction.get(userRef);
      if (!snap.exists) return null;
      const rawData = snap.data();
      const currentPeriod = getCurrentUsagePeriod();
      const recordPeriod = rawData.currentUsagePeriod || currentPeriod;
      const currentUsage = (recordPeriod === currentPeriod && typeof rawData.monthlyScanUsage === 'number')
        ? rawData.monthlyScanUsage
        : 0;

      if (currentUsage <= 0) return null;

      const newUsage = currentUsage - 1;
      transaction.set(userRef, {
        monthlyScanUsage: newUsage,
        updatedAt: new Date().toISOString()
      }, { merge: true });

      return {
        success: true,
        usage: newUsage,
        currentPeriod
      };
    });
  }

  // Path 2: Local fallback with atomic locking
  return await withLocalLock(userId, async () => {
    let list = [];
    const file = localDataDir ? path.join(localDataDir, 'subscriptions.json') : null;
    if (file) {
      try {
        list = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {}
    }

    const userRecord = list.find(s => s.userId === userId);
    if (!userRecord) return null;

    const currentPeriod = getCurrentUsagePeriod();
    const recordPeriod = userRecord.currentUsagePeriod || currentPeriod;
    const currentUsage = (recordPeriod === currentPeriod && typeof userRecord.monthlyScanUsage === 'number')
      ? userRecord.monthlyScanUsage
      : 0;

    if (currentUsage <= 0) return null;

    const newUsage = currentUsage - 1;
    userRecord.monthlyScanUsage = newUsage;
    userRecord.updatedAt = new Date().toISOString();

    const idx = list.findIndex(s => s.userId === userId);
    if (idx >= 0) list[idx] = userRecord;

    if (file) {
      await fs.writeFile(file, JSON.stringify(list, null, 2), 'utf8');
    }

    return {
      success: true,
      usage: newUsage,
      currentPeriod
    };
  });
}

/**
 * Filters an array of test records according to the user's history retention limit.
 */
export function filterTestsByRetention(tests, historyRetentionDays) {
  if (!Array.isArray(tests)) return [];
  const days = Number(historyRetentionDays) || 7;
  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
  return tests.filter(t => {
    if (!t.createdAt) return true;
    const testTime = new Date(t.createdAt).getTime();
    return !isNaN(testTime) ? (testTime >= cutoff) : true;
  });
}

/**
 * Generates a standard PDF 1.4 binary buffer for a test report.
 */
export function generateReportPdfBuffer(report = {}) {
  const sanitizeText = (txt) => String(txt || '').replace(/[\\()]/g, '').slice(0, 80);
  const hostname = sanitizeText(report.hostname || report.url || 'Audit Report');
  const score = report.score !== undefined ? String(report.score) : 'N/A';
  const dateStr = new Date(report.completedAt || Date.now()).toISOString().slice(0, 10);
  const issues = Array.isArray(report.issues) ? report.issues : [];

  let textStream = 'BT\n/F1 20 Tf\n50 740 Td\n(FLIQ Website Quality Report) Tj\n';
  textStream += '/F1 12 Tf\n0 -30 Td\n(Target: ' + hostname + ') Tj\n';
  textStream += '0 -20 Td\n(Generated: ' + dateStr + ') Tj\n';
  textStream += '0 -20 Td\n(Overall Score: ' + score + ' / 100) Tj\n';
  textStream += '0 -30 Td\n(Summary of Audit Findings: ' + issues.length + ' issues detected) Tj\n';

  let yOffset = -20;
  for (let i = 0; i < Math.min(issues.length, 18); i++) {
    const issue = issues[i];
    const line = sanitizeText(`${i + 1}. [${issue.severity || 'Medium'}] ${issue.title || 'Issue'}`);
    textStream += `0 ${yOffset} Td\n(${line}) Tj\n`;
    yOffset = -18;
  }
  textStream += 'ET\n';

  const streamBytes = Buffer.from(textStream, 'utf8');

  const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  const obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
  const obj3 = '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n';
  const obj4 = '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';
  const obj5Header = `5 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n`;
  const obj5Footer = '\nendstream\nendobj\n';

  const head = Buffer.from('%PDF-1.4\n', 'utf8');
  const part1 = Buffer.from(obj1, 'utf8');
  const part2 = Buffer.from(obj2, 'utf8');
  const part3 = Buffer.from(obj3, 'utf8');
  const part4 = Buffer.from(obj4, 'utf8');
  const part5H = Buffer.from(obj5Header, 'utf8');
  const part5F = Buffer.from(obj5Footer, 'utf8');

  const offset1 = head.length;
  const offset2 = offset1 + part1.length;
  const offset3 = offset2 + part2.length;
  const offset4 = offset3 + part3.length;
  const offset5 = offset4 + part4.length;
  const offsetEnd = offset5 + part5H.length + streamBytes.length + part5F.length;

  const pad = (n) => String(n).padStart(10, '0');
  const xref = `xref\n0 6\n0000000000 65535 f \n${pad(offset1)} 00000 n \n${pad(offset2)} 00000 n \n${pad(offset3)} 00000 n \n${pad(offset4)} 00000 n \n${pad(offset5)} 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offsetEnd}\n%%EOF\n`;

  return Buffer.concat([
    head,
    part1,
    part2,
    part3,
    part4,
    part5H,
    streamBytes,
    part5F,
    Buffer.from(xref, 'utf8')
  ]);
}
