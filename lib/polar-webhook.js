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
 * Detects whether the Polar environment is configured for sandbox testing.
 * Normalizes case, removes surrounding quotes, and trims whitespace.
 * Accepts POLAR_SERVER, POLAR_ENVIRONMENT, or POLAR_ENV ('sandbox').
 */
export function isPolarSandbox() {
  const raw = process.env.POLAR_SERVER || process.env.POLAR_ENVIRONMENT || process.env.POLAR_ENV || '';
  if (typeof raw !== 'string') return false;
  const normalized = raw.trim().replace(/^["']|["']$/g, '').trim().toLowerCase();
  return normalized === 'sandbox';
}

/**
 * Returns the canonical Polar server environment string: 'sandbox' or 'production'.
 */
export function getPolarServerEnvironment() {
  return isPolarSandbox() ? 'sandbox' : 'production';
}

/**
 * Returns the Polar API host according to the selected environment:
 * - Sandbox: https://sandbox-api.polar.sh
 * - Production: https://api.polar.sh
 * If POLAR_BASE_URL is explicitly configured, it is respected.
 */
export function getPolarApiHost() {
  if (process.env.POLAR_BASE_URL?.trim()) {
    const custom = process.env.POLAR_BASE_URL.trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
    return custom.replace(/\/v1$/, '');
  }
  return isPolarSandbox() ? 'https://sandbox-api.polar.sh' : 'https://api.polar.sh';
}

/**
 * Returns the full v1 base URL for Polar API:
 * - Sandbox: https://sandbox-api.polar.sh/v1
 * - Production: https://api.polar.sh/v1
 */
export function getPolarApiBaseUrl() {
  return `${getPolarApiHost()}/v1`;
}

/**
 * Resolves and sanitizes the Polar API access token.
 * In sandbox mode, prioritizes POLAR_SANDBOX_ACCESS_TOKEN, then POLAR_ACCESS_TOKEN.
 * In production mode, uses POLAR_ACCESS_TOKEN.
 * Safely strips:
 * - Surrounding quotes ("..." or '...')
 * - Leading/trailing whitespace
 * - Accidental duplicate "Bearer " prefix (e.g. if user pasted "Bearer polar_oat_...")
 */
export function getPolarAccessToken() {
  const isSandbox = isPolarSandbox();
  let raw = isSandbox
    ? (process.env.POLAR_SANDBOX_ACCESS_TOKEN || process.env.POLAR_ACCESS_TOKEN)
    : process.env.POLAR_ACCESS_TOKEN;

  if (!raw || typeof raw !== 'string') return '';

  let token = raw.trim().replace(/^["']|["']$/g, '').trim();
  if (/^Bearer\s+/i.test(token)) {
    token = token.replace(/^Bearer\s+/i, '').trim();
  }
  return token;
}

/**
 * Constructs the standard Authorization header string: 'Bearer <token>'.
 * Guarantees exactly one Bearer scheme and no whitespace/corruption.
 */
export function buildPolarAuthHeader(token = getPolarAccessToken()) {
  let clean = String(token || '').trim().replace(/^["']|["']$/g, '').trim();
  if (/^Bearer\s+/i.test(clean)) {
    clean = clean.replace(/^Bearer\s+/i, '').trim();
  }
  return clean ? `Bearer ${clean}` : '';
}

/**
 * Reads configured Polar Product IDs from process.env.
 * In sandbox mode, checks POLAR_SANDBOX_PRODUCT_* before POLAR_PRODUCT_*.
 * Strips surrounding whitespace and quotes.
 * Never hardcodes product IDs.
 */
export function getPolarProductConfig() {
  const isSandbox = isPolarSandbox();
  const clean = (val) => String(val || '').trim().replace(/^["']|["']$/g, '').trim();

  if (isSandbox) {
    return {
      creatorMonthlyId: clean(process.env.POLAR_SANDBOX_PRODUCT_CREATOR_MONTHLY || process.env.POLAR_PRODUCT_CREATOR_MONTHLY),
      creatorYearlyId: clean(process.env.POLAR_SANDBOX_PRODUCT_CREATOR_YEARLY || process.env.POLAR_PRODUCT_CREATOR_YEARLY),
      teamMonthlyId: clean(process.env.POLAR_SANDBOX_PRODUCT_TEAM_MONTHLY || process.env.POLAR_PRODUCT_TEAM_MONTHLY),
      teamYearlyId: clean(process.env.POLAR_SANDBOX_PRODUCT_TEAM_YEARLY || process.env.POLAR_PRODUCT_TEAM_YEARLY)
    };
  }

  return {
    creatorMonthlyId: clean(process.env.POLAR_PRODUCT_CREATOR_MONTHLY),
    creatorYearlyId: clean(process.env.POLAR_PRODUCT_CREATOR_YEARLY),
    teamMonthlyId: clean(process.env.POLAR_PRODUCT_TEAM_MONTHLY),
    teamYearlyId: clean(process.env.POLAR_PRODUCT_TEAM_YEARLY)
  };
}

/**
 * Maps a Polar product ID or product metadata to a FLIQ plan and billing interval.
 */
export function mapPolarProductToPlan(productId, productData = {}) {
  const cfg = getPolarProductConfig();
  const pid = String(productId || productData?.product_id || productData?.product?.id || '').trim();

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
  const name = String(productData?.name || productData?.product?.name || productData?.description || productData?.product?.description || '').toLowerCase();
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
  const metaPlan = String(productData?.metadata?.plan || productData?.product?.metadata?.plan || productData?.custom_field_data?.plan || '').toLowerCase();
  const metaInterval = String(productData?.metadata?.interval || productData?.product?.metadata?.interval || productData?.custom_field_data?.interval || '').toLowerCase();
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
 * Resolves the configured Polar Product ID for a given plan and billing interval.
 * Returns null if the plan is not a paid plan or if the product ID is not set in environment.
 */
export function resolvePolarProductId(plan, interval = 'monthly') {
  const p = String(plan || '').trim().toLowerCase();
  const i = String(interval || 'monthly').trim().toLowerCase();
  const isYearly = i === 'yearly' || i === 'annual';
  const cfg = getPolarProductConfig();

  if (p === 'creator') {
    return isYearly ? (cfg.creatorYearlyId || null) : (cfg.creatorMonthlyId || null);
  }
  if (p === 'team') {
    return isYearly ? (cfg.teamYearlyId || null) : (cfg.teamMonthlyId || null);
  }
  return null;
}

/**
 * Extracts a verified Firebase user ID from the Polar event.
 * NEVER identifies users via unverified email addresses.
 */
export async function extractUserIdFromPolarEvent(event, db = null) {
  const data = event?.data || {};

  // 1. Explicit metadata attached during checkout (data.metadata or data.checkout.metadata)
  const metadata = data.metadata || data.checkout?.metadata || {};
  const metaUid = metadata.userId || metadata.fliqUserId || metadata.user_id || metadata.uid;
  if (metaUid && typeof metaUid === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(metaUid.trim())) {
    return { userId: metaUid.trim(), source: 'checkout_metadata' };
  }

  // 2. Customer external_id (bound to Firebase UID at customer creation)
  const customer = data.customer || {};
  const externalId = customer.external_id || customer.externalId || data.external_customer_id || data.customer_external_id;
  if (externalId && typeof externalId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(externalId.trim())) {
    return { userId: externalId.trim(), source: 'customer_external_id' };
  }

  // 3. Customer metadata attached during checkout
  const custMeta = customer.metadata || data.customer_metadata || {};
  const custMetaUid = custMeta.userId || custMeta.fliqUserId || custMeta.uid;
  if (custMetaUid && typeof custMetaUid === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(custMetaUid.trim())) {
    return { userId: custMetaUid.trim(), source: 'customer_metadata' };
  }

  // 4. Firestore lookup by checkout session ID
  const checkoutId = data.checkout_id || (typeof data.id === 'string' && data.id.startsWith('ch_') ? data.id : null);
  if (db && checkoutId && typeof checkoutId === 'string') {
    try {
      const chkDoc = await db.collection('checkouts').doc(checkoutId).get();
      if (chkDoc.exists && chkDoc.data()?.userId) {
        return { userId: chkDoc.data().userId, source: 'checkout_session_link' };
      }
    } catch (err) {
      console.warn('[Polar Webhook] Notice: checkout lookup query warning:', err.message);
    }
  }

  // 5. Firestore lookup by previously verified Polar customer ID
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
  delete safe.accessToken;
  delete safe.POLAR_ACCESS_TOKEN;
  delete safe.POLAR_SANDBOX_ACCESS_TOKEN;
  delete safe.authorization;
  delete safe.Authorization;
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
    const outcome = await processPolarWebhookEvent(event, { db: cloudDb, localDataDir, adminApp });

    // Mark event processed for future duplicate attempts
    await recordEventProcessed(webhookId, event.type, event.data?.id, cloudDb, {
      action: outcome.action || null,
      userId: outcome.userId || null
    });

    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ received: true, success: Boolean(outcome?.success !== false), outcome }));
  } catch (procErr) {
    logWebhook('error', `Temporary processing error on event ${event.type}: ${procErr.message}`);
    // Return 500 so Polar retries delivery later
    res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ error: 'Temporary webhook processing failure.' }));
  }
}

/**
 * Creates a Polar checkout session for an authenticated user.
 * Communicates server-to-server with the Polar API (/v1/checkouts/).
 * Never exposes the POLAR_ACCESS_TOKEN to the client.
 */
export async function createPolarCheckoutSession({
  plan,
  interval = 'monthly',
  user,
  successUrl,
  fetchFn = fetch,
  cloudDb = null
}) {
  const p = String(plan || '').trim().toLowerCase();
  const i = String(interval || 'monthly').trim().toLowerCase();
  const isYearly = i === 'yearly' || i === 'annual';
  const canonicalInterval = isYearly ? 'yearly' : 'monthly';

  if (p !== 'creator' && p !== 'team') {
    const err = new Error(`Invalid plan "${plan}". Paid checkouts require plan "creator" or "team".`);
    err.status = 400;
    throw err;
  }

  const isSandbox = isPolarSandbox();
  const apiHost = getPolarApiHost();
  const baseUrl = `${apiHost}/v1`;
  const checkoutEndpoint = `${baseUrl}/checkouts/`;

  const productId = resolvePolarProductId(p, canonicalInterval);
  if (!productId) {
    const envKey = isSandbox
      ? `POLAR_PRODUCT_${p.toUpperCase()}_${canonicalInterval.toUpperCase()} (or POLAR_SANDBOX_PRODUCT_${p.toUpperCase()}_${canonicalInterval.toUpperCase()})`
      : `POLAR_PRODUCT_${p.toUpperCase()}_${canonicalInterval.toUpperCase()}`;
    const err = new Error(`Product ID for ${p} (${canonicalInterval}) is not configured on the server. Set ${envKey} in environment.`);
    err.status = 500;
    throw err;
  }

  const accessToken = getPolarAccessToken();
  if (!accessToken) {
    const envKey = isSandbox
      ? 'POLAR_ACCESS_TOKEN (or POLAR_SANDBOX_ACCESS_TOKEN)'
      : 'POLAR_ACCESS_TOKEN';
    const err = new Error(`Polar API access token is not configured on the server. Set ${envKey} in environment.`);
    err.status = 500;
    throw err;
  }

  if (!user || !user.uid) {
    const err = new Error('Authenticated user is required to create a checkout session.');
    err.status = 401;
    throw err;
  }

  const defaultSuccess = 'https://fliq-ezaz.onrender.com/dashboard?checkout=success&checkout_id={CHECKOUT_ID}';

  const payload = {
    products: [productId],
    success_url: successUrl || defaultSuccess,
    customer_email: user.email ? String(user.email).trim() : undefined,
    external_customer_id: user.uid,
    metadata: {
      userId: user.uid,
      plan: p,
      interval: canonicalInterval
    },
    customer_metadata: {
      userId: user.uid
    }
  };

  // Safe diagnostic log: records target API host, environment, and user ID without tokens or secrets
  logWebhook('info', `Creating Polar checkout session for ${p} (${canonicalInterval})`, {
    userId: user.uid,
    productId,
    isSandbox,
    apiHost,
    endpoint: checkoutEndpoint
  });

  const authHeader = buildPolarAuthHeader(accessToken);

  let response;
  try {
    response = await fetchFn(checkoutEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (netErr) {
    logWebhook('error', `Network error contacting Polar checkouts API at ${apiHost}: ${netErr.message}`, {
      apiHost,
      endpoint: checkoutEndpoint
    });
    const err = new Error(`Network failure connecting to Polar (${apiHost}): ${netErr.message}`);
    err.status = 502;
    throw err;
  }

  const rawText = await response.text();
  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = { error: rawText };
  }

  if (!response.ok) {
    const errorMsg = data?.detail || data?.message || data?.error || `Polar API returned status ${response.status}`;
    const errorCode = data?.error || data?.code || (typeof data?.detail === 'string' ? data.detail : null);

    // Safe diagnostic log: records HTTP status, error code, and target API host without leaking secrets
    logWebhook('error', `Polar checkout API rejected creation: ${errorMsg}`, {
      status: response.status,
      errorCode,
      apiHost,
      environment: getPolarServerEnvironment(),
      productId
    });

    const err = new Error(`Polar checkout creation failed: ${errorMsg}`);
    err.status = response.status >= 500 ? 502 : response.status;
    err.code = errorCode;
    throw err;
  }

  const checkoutUrl = data?.url || data?.checkout_url;
  if (!checkoutUrl) {
    logWebhook('error', 'Polar API response missing checkout URL', {
      checkoutId: data?.id || null,
      apiHost
    });
    const err = new Error('Polar API response did not include a valid checkout URL.');
    err.status = 502;
    throw err;
  }

  // Persist checkout session mapping in Firestore so webhooks can immediately link external orders
  if (cloudDb && data.id) {
    try {
      await cloudDb.collection('checkouts').doc(data.id).set({
        id: data.id,
        userId: user.uid,
        userEmail: user.email ? String(user.email).trim() : null,
        plan: p,
        interval: canonicalInterval,
        createdAt: new Date().toISOString()
      }, { merge: true });
    } catch (saveErr) {
      console.warn('[Polar Checkout] Notice: checkouts document save warning:', saveErr.message);
    }
  }

  logWebhook('info', 'Polar checkout session created successfully', {
    checkoutId: data.id,
    userId: user.uid,
    apiHost
  });

  return {
    checkoutUrl,
    checkoutId: data.id,
    plan: p,
    interval: canonicalInterval
  };
}

/**
 * Main HTTP route dispatcher for POST /api/checkout/polar
 */
export async function handlePolarCheckoutRequest(req, res, { cloudDb, adminApp, verifiedUserFn, fetchFn }) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ error: 'Method not allowed. Checkout requires POST.' }));
  }

  let user = null;
  try {
    user = await verifiedUserFn(req);
  } catch (authErr) {
    res.writeHead(authErr.status || 401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ error: authErr.message || 'Authentication required.' }));
  }

  if (!user || !user.uid || user.uid === 'local') {
    res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ error: 'Sign in to a verified account to subscribe.' }));
  }

  let body = '';
  try {
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 10000) {
        res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ error: 'Payload too large.' }));
      }
    }
  } catch {
    res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ error: 'Failed to read request body.' }));
  }

  let parsed = {};
  if (body) {
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: 'Invalid JSON payload.' }));
    }
  }

  const plan = parsed.plan || 'creator';
  const interval = parsed.interval || parsed.period || 'monthly';
  const origin = req.headers.origin || (req.headers.host ? `http://${req.headers.host}` : 'https://fliq-ezaz.onrender.com');
  const successUrl = parsed.successUrl || `${origin}/dashboard?checkout=success&checkout_id={CHECKOUT_ID}`;

  try {
    const session = await createPolarCheckoutSession({
      plan,
      interval,
      user,
      successUrl,
      fetchFn,
      cloudDb
    });

    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true,
      ...session
    }));
  } catch (err) {
    const status = err.status || 500;
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ error: err.message || 'Failed to create checkout session.' }));
  }
}
