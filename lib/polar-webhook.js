/**
 * FLIQ Production Polar Webhook Handler
 *
 * Implements Standard Webhooks signature verification, idempotency protection,
 * secure Firebase user mapping, and complete subscription lifecycle management.
 *
 * Supported Events:
 * - order.paid
 * - order.refunded
 * - subscription.active
 * - subscription.updated
 * - subscription.canceled
 * - subscription.uncanceled
 * - subscription.past_due
 * - subscription.revoked
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// In-memory LRU cache of recently processed webhook IDs to short-circuit duplicate bursts
const recentWebhookIds = new Set();
const MAX_RECENT_WEBHOOK_IDS = 1000;

function rememberWebhookId(id) {
  if (!id) return;
  recentWebhookIds.add(id);
  if (recentWebhookIds.size > MAX_RECENT_WEBHOOK_IDS) {
    const first = recentWebhookIds.values().next().value;
    recentWebhookIds.delete(first);
  }
}

/**
 * Extracts and decodes secret bytes for Standard Webhook verification.
 * Polar secrets typically begin with 'whsec_' followed by base64-encoded key.
 */
export function getSecretBuffer(secret) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('POLAR_WEBHOOK_SECRET must be a non-empty string');
  }
  const trimmed = secret.trim();
  if (trimmed.startsWith('whsec_')) {
    return Buffer.from(trimmed.slice(6), 'base64');
  }
  // If valid base64 string, decode as base64, otherwise treat as utf-8
  try {
    const b64 = Buffer.from(trimmed, 'base64');
    if (b64.length > 0 && b64.toString('base64') === trimmed) {
      return b64;
    }
  } catch {}
  return Buffer.from(trimmed, 'utf8');
}

/**
 * Verifies standard webhook headers against raw body using HMAC-SHA256.
 */
export function verifyPolarWebhookSignature({
  webhookId,
  webhookTimestamp,
  webhookSignature,
  rawBody,
  secret,
  toleranceSeconds = 300
}) {
  if (!secret) {
    throw new Error('POLAR_WEBHOOK_SECRET is not configured');
  }
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    throw new Error('Missing required webhook headers (webhook-id, webhook-timestamp, webhook-signature)');
  }
  if (typeof rawBody !== 'string') {
    throw new Error('rawBody must be provided as a string');
  }

  const timestampNum = Number(webhookTimestamp);
  if (!Number.isFinite(timestampNum) || timestampNum <= 0) {
    throw new Error('Invalid webhook-timestamp header');
  }

  // Clock drift check
  if (toleranceSeconds > 0) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - timestampNum) > toleranceSeconds) {
      throw new Error(`Webhook timestamp outside tolerance window (${toleranceSeconds}s)`);
    }
  }

  const secretBuffer = getSecretBuffer(secret);
  const toSign = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const computedHmac = crypto.createHmac('sha256', secretBuffer).update(toSign).digest('base64');
  const expectedSig = `v1,${computedHmac}`;
  const expectedBuf = Buffer.from(expectedSig);

  const signatures = webhookSignature.split(' ').map(s => s.trim()).filter(Boolean);
  let verified = false;

  for (const sig of signatures) {
    if (!sig.startsWith('v1,')) continue;
    const sigBuf = Buffer.from(sig);
    if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      verified = true;
      break;
    }
  }

  if (!verified) {
    throw new Error('Webhook signature verification failed');
  }

  return true;
}

/**
 * Utility to generate standard Polar/Svix webhook signatures for tests and simulators.
 */
export function generatePolarWebhookSignature(payloadString, secret, options = {}) {
  const webhookId = options.webhookId || `msg_${crypto.randomUUID()}`;
  const timestamp = options.timestamp || Math.floor(Date.now() / 1000);
  const secretBuffer = getSecretBuffer(secret);
  const toSign = `${webhookId}.${timestamp}.${payloadString}`;
  const computedHmac = crypto.createHmac('sha256', secretBuffer).update(toSign).digest('base64');
  return {
    'webhook-id': webhookId,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${computedHmac}`
  };
}

/**
 * Reads configured Polar Product IDs from process.env.
 * Never hardcodes product IDs.
 */
export function getPolarProductConfig() {
  return {
    creatorMonthlyId: process.env.POLAR_PRODUCT_CREATOR_MONTHLY?.trim() || '',
    creatorYearlyId: process.env.POLAR_PRODUCT_CREATOR_YEARLY?.trim() || '',
    teamMonthlyId: process.env.POLAR_PRODUCT_TEAM_MONTHLY?.trim() || '',
    teamYearlyId: process.env.POLAR_PRODUCT_TEAM_YEARLY?.trim() || ''
  };
}

/**
 * Maps a Polar product ID or product metadata to a FLIQ plan and billing interval.
 */
export function mapPolarProductToPlan(productId, productData = {}) {
  const cfg = getPolarProductConfig();
  const pid = String(productId || '').trim();

  // 1. Direct environment-configured product ID match
  if (pid) {
    if (cfg.creatorMonthlyId && pid === cfg.creatorMonthlyId) {
      return { plan: 'creator', interval: 'monthly', name: 'Creator', price: 9 };
    }
    if (cfg.creatorYearlyId && pid === cfg.creatorYearlyId) {
      return { plan: 'creator', interval: 'yearly', name: 'Creator', price: 84 };
    }
    if (cfg.teamMonthlyId && pid === cfg.teamMonthlyId) {
      return { plan: 'team', interval: 'monthly', name: 'Team', price: 19.99 };
    }
    if (cfg.teamYearlyId && pid === cfg.teamYearlyId) {
      return { plan: 'team', interval: 'yearly', name: 'Team', price: 188 };
    }
  }

  // 2. Product name / metadata inspection as reliable secondary verification
  const name = String(productData?.name || '').toLowerCase();
  const isYearly = name.includes('year') || name.includes('annual');

  if (name.includes('creator')) {
    return {
      plan: 'creator',
      interval: isYearly ? 'yearly' : 'monthly',
      name: 'Creator',
      price: isYearly ? 84 : 9
    };
  }

  if (name.includes('team')) {
    return {
      plan: 'team',
      interval: isYearly ? 'yearly' : 'monthly',
      name: 'Team',
      price: isYearly ? 188 : 19.99
    };
  }

  // 3. Metadata fallback if set on checkout
  const metaPlan = String(productData?.metadata?.plan || '').toLowerCase();
  const metaInterval = String(productData?.metadata?.interval || '').toLowerCase();
  if (metaPlan === 'creator' || metaPlan === 'team') {
    const isYear = metaInterval === 'yearly' || metaInterval === 'annual';
    return {
      plan: metaPlan,
      interval: isYear ? 'yearly' : 'monthly',
      name: metaPlan === 'creator' ? 'Creator' : 'Team',
      price: metaPlan === 'creator' ? (isYear ? 84 : 9) : (isYear ? 188 : 19.99)
    };
  }

  return null;
}

/**
 * Extracts a verified Firebase user ID from the Polar event.
 * NEVER identifies users via unverified email addresses.
 */
export async function extractUserIdFromPolarEvent(event, db = null) {
  const data = event?.data || {};

  // 1. Explicit metadata attached during checkout
  const metadata = data.metadata || {};
  const metaUid = metadata.userId || metadata.fliqUserId || metadata.user_id || metadata.uid;
  if (metaUid && typeof metaUid === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(metaUid.trim())) {
    return { userId: metaUid.trim(), source: 'checkout_metadata' };
  }

  // 2. Customer external_id (bound to Firebase UID at customer creation)
  const customer = data.customer || {};
  const externalId = customer.external_id || data.user_id;
  if (externalId && typeof externalId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(externalId.trim())) {
    return { userId: externalId.trim(), source: 'customer_external_id' };
  }

  // 3. Customer metadata
  const custMeta = customer.metadata || {};
  const custMetaUid = custMeta.userId || custMeta.fliqUserId || custMeta.uid;
  if (custMetaUid && typeof custMetaUid === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(custMetaUid.trim())) {
    return { userId: custMetaUid.trim(), source: 'customer_metadata' };
  }

  // 4. Firestore lookup by previously verified Polar customer ID
  const customerId = data.customer_id || customer.id;
  if (db && customerId && typeof customerId === 'string') {
    try {
      const custDoc = await db.collection('polar_customers').doc(customerId).get();
      if (custDoc.exists && custDoc.data()?.userId) {
        return { userId: custDoc.data().userId, source: 'firestore_customer_link' };
      }
    } catch (err) {
      console.warn('[Polar Webhook] Notice: customer lookup query warning:', err.message);
    }
  }

  return {
    userId: null,
    source: null,
    error: 'No verified Firebase user ID found in checkout metadata or customer external_id'
  };
}

/**
 * Structured server-side logging without leaking secrets, tokens, or card numbers.
 */
export function logWebhook(level, message, meta = {}) {
  const safe = { ...meta };
  delete safe.secret;
  delete safe.POLAR_WEBHOOK_SECRET;
  delete safe.apiKey;
  delete safe.signature;
  delete safe.token;
  delete safe.cardNumber;
  delete safe.card;
  const metaStr = Object.keys(safe).length ? ` ${JSON.stringify(safe)}` : '';
  const prefix = '[Polar Webhook]';
  if (level === 'error') {
    console.error(`${prefix} ❌ ${message}${metaStr}`);
  } else if (level === 'warn') {
    console.warn(`${prefix} ⚠️ ${message}${metaStr}`);
  } else {
    console.log(`${prefix} ℹ️ ${message}${metaStr}`);
  }
}

/**
 * Fallback local storage for development/preview when Firestore is not configured.
 */
async function recordLocalSubscription(localDataDir, userId, subscriptionData) {
  if (!localDataDir) return;
  try {
    const file = path.join(localDataDir, 'subscriptions.json');
    let list = [];
    try {
      list = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {}
    const idx = list.findIndex(s => s.userId === userId);
    const entry = { userId, ...subscriptionData, updatedAt: new Date().toISOString() };
    if (idx >= 0) list[idx] = { ...list[idx], ...entry };
    else list.push(entry);
    await fs.writeFile(file, JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Polar Webhook] Local subscription fallback write notice:', err.message);
  }
}

/**
 * Checks idempotency in Firestore and in-memory cache.
 */
export async function checkIdempotency(webhookId, db) {
  if (!webhookId) return false;
  if (recentWebhookIds.has(webhookId)) {
    return true;
  }
  if (db) {
    try {
      const doc = await db.collection('webhook_events').doc(webhookId).get();
      if (doc.exists) {
        rememberWebhookId(webhookId);
        return true;
      }
    } catch (err) {
      console.warn('[Polar Webhook] Idempotency read warning:', err.message);
    }
  }
  return false;
}

/**
 * Records processed event for idempotency in Firestore and memory.
 */
export async function recordEventProcessed(webhookId, eventType, entityId, db, details = {}) {
  if (!webhookId) return;
  rememberWebhookId(webhookId);
  if (db) {
    try {
      await db.collection('webhook_events').doc(webhookId).set({
        webhookId,
        eventType,
        entityId: entityId || null,
        processedAt: new Date().toISOString(),
        status: 'processed',
        ...details
      });
    } catch (err) {
      console.warn('[Polar Webhook] Idempotency write warning:', err.message);
    }
  }
}

/**
 * Processes a verified Polar webhook event.
 */
export async function processPolarWebhookEvent(event, { db, localDataDir }) {
  const eventType = String(event?.type || '').trim();
  const data = event?.data || {};
  const entityId = data.id || null;

  logWebhook('info', `Processing event: ${eventType}`, { entityId });

  // ---------------------------------------------------------------------------
  // 1. ORDER EVENTS
  // ---------------------------------------------------------------------------
  if (eventType === 'order.paid') {
    // Strictly verify payment status
    if (data.status !== 'paid') {
      logWebhook('warn', `Received order.paid with unconfirmed status: ${data.status}. Denying access.`, { orderId: entityId });
      return { success: false, reason: 'order_status_not_paid' };
    }

    const { userId, error } = await extractUserIdFromPolarEvent(event, db);
    if (!userId) {
      logWebhook('error', `Cannot grant subscription for order.paid: ${error}`, { orderId: entityId });
      return { success: false, reason: 'unverified_user' };
    }

    const planInfo = mapPolarProductToPlan(data.product_id, data.product || data);
    if (!planInfo) {
      logWebhook('error', `Unknown Polar product ID (${data.product_id}) on order.paid. Check configuration.`, { orderId: entityId, productId: data.product_id });
      return { success: false, reason: 'unmapped_product' };
    }

    const customerId = data.customer_id || data.customer?.id || null;
    const subscriptionId = data.subscription_id || null;
    const nowIso = new Date().toISOString();

    const userUpdate = {
      plan: planInfo.plan,
      planName: planInfo.name,
      billingInterval: planInfo.interval,
      subscriptionStatus: 'active',
      polarCustomerId: customerId,
      polarSubscriptionId: subscriptionId,
      lastPaymentAt: nowIso,
      updatedAt: nowIso
    };

    if (db) {
      const batch = db.batch();
      // Update user
      batch.set(db.collection('users').doc(userId), userUpdate, { merge: true });
      // Update or record customer link
      if (customerId) {
        batch.set(db.collection('polar_customers').doc(customerId), {
          customerId,
          userId,
          updatedAt: nowIso
        }, { merge: true });
      }
      // Record order
      batch.set(db.collection('orders').doc(entityId), {
        id: entityId,
        userId,
        customerId,
        subscriptionId,
        amount: data.amount,
        currency: data.currency || 'usd',
        status: 'paid',
        plan: planInfo.plan,
        interval: planInfo.interval,
        paidAt: data.created_at || nowIso,
        updatedAt: nowIso
      }, { merge: true });

      await batch.commit();
    }

    await recordLocalSubscription(localDataDir, userId, userUpdate);
    logWebhook('info', `Granted ${planInfo.name} (${planInfo.interval}) to user`, { userId, orderId: entityId });
    return { success: true, action: 'order_paid_activated', plan: planInfo.plan, userId };
  }

  if (eventType === 'order.refunded') {
    const { userId } = await extractUserIdFromPolarEvent(event, db);
    const nowIso = new Date().toISOString();

    if (db) {
      await db.collection('orders').doc(entityId).set({
        status: 'refunded',
        refundedAt: nowIso,
        updatedAt: nowIso
      }, { merge: true });

      if (userId) {
        // Revert user to free plan if tied to this order
        await db.collection('users').doc(userId).set({
          plan: 'free',
          planName: 'Free',
          subscriptionStatus: 'refunded',
          refundedAt: nowIso,
          updatedAt: nowIso
        }, { merge: true });
      }
    }

    if (userId) {
      await recordLocalSubscription(localDataDir, userId, {
        plan: 'free',
        planName: 'Free',
        subscriptionStatus: 'refunded'
      });
    }

    logWebhook('info', `Order refunded. Reverted user access to free.`, { orderId: entityId, userId });
    return { success: true, action: 'order_refunded', userId };
  }

  // ---------------------------------------------------------------------------
  // 2. SUBSCRIPTION LIFECYCLE EVENTS
  // ---------------------------------------------------------------------------
  if (eventType === 'subscription.active') {
    const { userId, error } = await extractUserIdFromPolarEvent(event, db);
    if (!userId) {
      logWebhook('error', `Cannot activate subscription: ${error}`, { subscriptionId: entityId });
      return { success: false, reason: 'unverified_user' };
    }

    const planInfo = mapPolarProductToPlan(data.product_id, data.product || data);
    if (!planInfo) {
      logWebhook('error', `Unknown product on subscription.active: ${data.product_id}`, { subscriptionId: entityId });
      return { success: false, reason: 'unmapped_product' };
    }

    const customerId = data.customer_id || data.customer?.id || null;
    const nowIso = new Date().toISOString();

    const subData = {
      plan: planInfo.plan,
      planName: planInfo.name,
      billingInterval: planInfo.interval,
      subscriptionStatus: 'active',
      polarSubscriptionId: entityId,
      polarCustomerId: customerId,
      currentPeriodStart: data.current_period_start || null,
      currentPeriodEnd: data.current_period_end || null,
      cancelAtPeriodEnd: false,
      updatedAt: nowIso
    };

    if (db) {
      const batch = db.batch();
      batch.set(db.collection('users').doc(userId), subData, { merge: true });
      batch.set(db.collection('subscriptions').doc(entityId), {
        id: entityId,
        userId,
        customerId,
        plan: planInfo.plan,
        interval: planInfo.interval,
        status: 'active',
        currentPeriodStart: data.current_period_start || null,
        currentPeriodEnd: data.current_period_end || null,
        cancelAtPeriodEnd: false,
        updatedAt: nowIso
      }, { merge: true });

      if (customerId) {
        batch.set(db.collection('polar_customers').doc(customerId), {
          customerId,
          userId,
          updatedAt: nowIso
        }, { merge: true });
      }
      await batch.commit();
    }

    await recordLocalSubscription(localDataDir, userId, subData);
    logWebhook('info', `Subscription active. Granted ${planInfo.name}`, { userId, subscriptionId: entityId });
    return { success: true, action: 'subscription_active', plan: planInfo.plan, userId };
  }

  if (eventType === 'subscription.updated') {
    const { userId } = await extractUserIdFromPolarEvent(event, db);
    if (!userId) {
      logWebhook('warn', `No verified user found on subscription.updated`, { subscriptionId: entityId });
      return { success: false, reason: 'unverified_user' };
    }

    const planInfo = mapPolarProductToPlan(data.product_id, data.product || data);
    const subStatus = String(data.status || 'active').toLowerCase();
    const nowIso = new Date().toISOString();
    const customerId = data.customer_id || data.customer?.id || null;

    let targetPlan = planInfo ? planInfo.plan : 'creator';
    let targetPlanName = planInfo ? planInfo.name : 'Creator';
    let isStillActive = subStatus === 'active';

    if (subStatus === 'revoked' || subStatus === 'canceled') {
      if (data.cancel_at_period_end && subStatus === 'active') {
        isStillActive = true;
      } else {
        targetPlan = 'free';
        targetPlanName = 'Free';
        isStillActive = false;
      }
    }

    const userUpdate = {
      plan: targetPlan,
      planName: targetPlanName,
      billingInterval: planInfo?.interval || 'monthly',
      subscriptionStatus: subStatus,
      polarSubscriptionId: entityId,
      polarCustomerId: customerId,
      currentPeriodStart: data.current_period_start || null,
      currentPeriodEnd: data.current_period_end || null,
      cancelAtPeriodEnd: Boolean(data.cancel_at_period_end),
      updatedAt: nowIso
    };

    if (db) {
      const batch = db.batch();
      batch.set(db.collection('users').doc(userId), userUpdate, { merge: true });
      batch.set(db.collection('subscriptions').doc(entityId), {
        id: entityId,
        userId,
        customerId,
        plan: targetPlan,
        status: subStatus,
        cancelAtPeriodEnd: Boolean(data.cancel_at_period_end),
        currentPeriodStart: data.current_period_start || null,
        currentPeriodEnd: data.current_period_end || null,
        updatedAt: nowIso
      }, { merge: true });
      await batch.commit();
    }

    await recordLocalSubscription(localDataDir, userId, userUpdate);
    logWebhook('info', `Subscription updated status: ${subStatus}`, { userId, subscriptionId: entityId, status: subStatus });
    return { success: true, action: 'subscription_updated', status: subStatus, userId };
  }

  if (eventType === 'subscription.canceled') {
    const { userId } = await extractUserIdFromPolarEvent(event, db);
    const nowIso = new Date().toISOString();
    const cancelAtPeriodEnd = Boolean(data.cancel_at_period_end);

    if (userId) {
      const userUpdate = {
        cancelAtPeriodEnd: true,
        cancelRequestedAt: nowIso,
        updatedAt: nowIso
      };

      // If immediate cancellation (not end of period), revoke paid plan immediately
      if (!cancelAtPeriodEnd) {
        userUpdate.plan = 'free';
        userUpdate.planName = 'Free';
        userUpdate.subscriptionStatus = 'canceled';
        userUpdate.endedAt = data.ended_at || nowIso;
      }

      if (db) {
        await db.collection('users').doc(userId).set(userUpdate, { merge: true });
        await db.collection('subscriptions').doc(entityId).set({
          status: cancelAtPeriodEnd ? 'active' : 'canceled',
          cancelAtPeriodEnd: true,
          cancelRequestedAt: nowIso,
          endedAt: data.ended_at || (!cancelAtPeriodEnd ? nowIso : null),
          updatedAt: nowIso
        }, { merge: true });
      }

      await recordLocalSubscription(localDataDir, userId, userUpdate);
    }

    logWebhook('info', `Subscription cancellation registered (cancelAtPeriodEnd: ${cancelAtPeriodEnd})`, { subscriptionId: entityId, userId });
    return { success: true, action: 'subscription_canceled', userId, cancelAtPeriodEnd };
  }

  if (eventType === 'subscription.uncanceled') {
    const { userId } = await extractUserIdFromPolarEvent(event, db);
    const nowIso = new Date().toISOString();

    if (userId) {
      const userUpdate = {
        cancelAtPeriodEnd: false,
        subscriptionStatus: 'active',
        updatedAt: nowIso
      };

      if (db) {
        await db.collection('users').doc(userId).set(userUpdate, { merge: true });
        await db.collection('subscriptions').doc(entityId).set({
          status: 'active',
          cancelAtPeriodEnd: false,
          updatedAt: nowIso
        }, { merge: true });
      }

      await recordLocalSubscription(localDataDir, userId, userUpdate);
    }

    logWebhook('info', `Subscription un-canceled (renewals restored)`, { subscriptionId: entityId, userId });
    return { success: true, action: 'subscription_uncanceled', userId };
  }

  if (eventType === 'subscription.past_due') {
    const { userId } = await extractUserIdFromPolarEvent(event, db);
    const nowIso = new Date().toISOString();

    if (userId) {
      const userUpdate = {
        subscriptionStatus: 'past_due',
        pastDueSince: nowIso,
        updatedAt: nowIso
      };

      if (db) {
        await db.collection('users').doc(userId).set(userUpdate, { merge: true });
        await db.collection('subscriptions').doc(entityId).set({
          status: 'past_due',
          pastDueSince: nowIso,
          updatedAt: nowIso
        }, { merge: true });
      }

      await recordLocalSubscription(localDataDir, userId, userUpdate);
    }

    logWebhook('warn', `Subscription payment failed — status past_due`, { subscriptionId: entityId, userId });
    return { success: true, action: 'subscription_past_due', userId };
  }

  if (eventType === 'subscription.revoked') {
    const { userId } = await extractUserIdFromPolarEvent(event, db);
    const nowIso = new Date().toISOString();

    if (userId) {
      const userUpdate = {
        plan: 'free',
        planName: 'Free',
        subscriptionStatus: 'revoked',
        revokedAt: nowIso,
        updatedAt: nowIso
      };

      if (db) {
        await db.collection('users').doc(userId).set(userUpdate, { merge: true });
        await db.collection('subscriptions').doc(entityId).set({
          status: 'revoked',
          endedAt: nowIso,
          updatedAt: nowIso
        }, { merge: true });
      }

      await recordLocalSubscription(localDataDir, userId, userUpdate);
    }

    logWebhook('info', `Subscription revoked. Reverted user access to free.`, { subscriptionId: entityId, userId });
    return { success: true, action: 'subscription_revoked', userId };
  }

  // ---------------------------------------------------------------------------
  // 3. NON-ENTITLEMENT PRELIMINARY EVENTS (checkout.created, etc.)
  // Never grant access merely because checkout.created or subscription.created was received.
  // ---------------------------------------------------------------------------
  logWebhook('info', `Acknowledged unhandled or preliminary event without entitlement change: ${eventType}`, { entityId });
  return { received: true, ignored: true, eventType };
}

/**
 * Main HTTP route dispatcher for POST /api/webhooks/polar
 */
export async function handlePolarWebhookRequest(req, res, { cloudDb, localDataDir, adminApp }) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ error: 'Method not allowed. Polar webhooks require POST.' }));
  }

  // 1. Read raw body with strict size safety (512 KB max)
  let rawBody = '';
  let byteLength = 0;
  const MAX_BYTES = 512 * 1024;

  try {
    for await (const chunk of req) {
      byteLength += chunk.length;
      if (byteLength > MAX_BYTES) {
        res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ error: 'Payload too large.' }));
      }
      rawBody += chunk.toString('utf8');
    }
  } catch (readErr) {
    res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ error: 'Failed to read request payload.' }));
  }

  // 2. Secret Configuration Check
  const secret = process.env.POLAR_WEBHOOK_SECRET?.trim();
  if (!secret) {
    logWebhook('error', 'POLAR_WEBHOOK_SECRET environment variable is missing on server');
    res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ error: 'Webhook secret is not configured on server.' }));
  }

  // 3. Signature & Standard Webhook Headers Verification
  const webhookId = req.headers['webhook-id'] || req.headers['x-polar-webhook-id'];
  const webhookTimestamp = req.headers['webhook-timestamp'] || req.headers['x-polar-webhook-timestamp'];
  const webhookSignature = req.headers['webhook-signature'] || req.headers['x-polar-webhook-signature'];

  try {
    verifyPolarWebhookSignature({
      webhookId,
      webhookTimestamp,
      webhookSignature,
      rawBody,
      secret
    });
  } catch (sigErr) {
    logWebhook('warn', `Signature verification rejected: ${sigErr.message}`);
    res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ error: sigErr.message || 'Invalid webhook signature.' }));
  }

  // 4. JSON Payload Parsing
  let event;
  try {
    event = JSON.parse(rawBody);
    if (!event || typeof event !== 'object' || !event.type) {
      throw new Error('Invalid Polar event structure: missing event type');
    }
  } catch (parseErr) {
    logWebhook('error', `Failed to parse webhook JSON payload: ${parseErr.message}`);
    res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ error: 'Invalid JSON payload.' }));
  }

  // 5. Idempotency Check
  const isDuplicate = await checkIdempotency(webhookId, cloudDb);
  if (isDuplicate) {
    logWebhook('info', `Idempotent replay detected for ${webhookId} (${event.type}). Returning 200 without reprocessing.`);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ received: true, duplicate: true }));
  }

  // 6. Event Processing
  try {
    const outcome = await processPolarWebhookEvent(event, { db: cloudDb, localDataDir });

    // Mark event processed for future duplicate attempts
    await recordEventProcessed(webhookId, event.type, event.data?.id, cloudDb, {
      action: outcome.action || null,
      userId: outcome.userId || null
    });

    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ received: true, success: true, outcome }));
  } catch (procErr) {
    logWebhook('error', `Temporary processing error on event ${event.type}: ${procErr.message}`);
    // Return 500 so Polar retries delivery later
    res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ error: 'Temporary webhook processing failure.' }));
  }
}
