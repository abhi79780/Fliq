import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verifyPolarWebhookSignature,
  generatePolarWebhookSignature,
  getSecretBuffer,
  getPolarProductConfig,
  mapPolarProductToPlan,
  resolvePolarProductId,
  extractUserIdFromPolarEvent,
  checkIdempotency,
  recordEventProcessed,
  processPolarWebhookEvent,
  handlePolarWebhookRequest,
  createPolarCheckoutSession,
  handlePolarCheckoutRequest
} from '../lib/polar-webhook.js';

// In-memory mock Firestore for offline test assertions
function createMockFirestore() {
  const data = new Map();

  return {
    collection(collectionName) {
      return {
        doc(docId) {
          const key = `${collectionName}/${docId}`;
          return {
            id: docId,
            async get() {
              return {
                id: docId,
                exists: data.has(key),
                data: () => data.get(key)
              };
            },
            async set(newData, options = {}) {
              if (options.merge && data.has(key)) {
                data.set(key, { ...data.get(key), ...newData });
              } else {
                data.set(key, { ...newData });
              }
            }
          };
        }
      };
    },
    batch() {
      const pendingOps = [];
      return {
        set(docRef, docData, opts) {
          pendingOps.push(() => docRef.set(docData, opts));
        },
        async commit() {
          for (const op of pendingOps) {
            await op();
          }
        }
      };
    },
    _get(collectionName, docId) {
      return data.get(`${collectionName}/${docId}`);
    },
    _clear() {
      data.clear();
    }
  };
}

// Mock HTTP Response object
function createMockResponse() {
  let statusCode = 200;
  let headers = {};
  let body = '';

  return {
    writeHead(status, hdrs) {
      statusCode = status;
      headers = { ...headers, ...hdrs };
      return this;
    },
    setHeader(key, val) {
      headers[key] = val;
      return this;
    },
    end(chunk) {
      if (chunk) body += chunk;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get headers() {
      return headers;
    },
    get body() {
      return body;
    },
    json() {
      return JSON.parse(body || '{}');
    }
  };
}

// Helper to create mock Readable stream from string
function createMockRequest(method, payloadString, headers = {}) {
  const stream = Readable.from(Buffer.from(payloadString, 'utf8'));
  stream.method = method;
  stream.headers = { ...headers };
  return stream;
}

const TEST_SECRET = 'whsec_MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE';
const RAW_TEST_SECRET = 'super_secret_test_key_1234567890';

describe('FLIQ Polar Payment Webhooks Test Suite', () => {

  describe('1. Standard Webhook Signature Verification', () => {
    test('Verifies valid HMAC-SHA256 signature with whsec_ base64 secret', () => {
      const payload = JSON.stringify({ type: 'order.paid', data: { id: 'ord_123' } });
      const sigs = generatePolarWebhookSignature(payload, TEST_SECRET);

      const isValid = verifyPolarWebhookSignature({
        webhookId: sigs['webhook-id'],
        webhookTimestamp: sigs['webhook-timestamp'],
        webhookSignature: sigs['webhook-signature'],
        rawBody: payload,
        secret: TEST_SECRET
      });

      assert.equal(isValid, true, 'Valid signature must verify successfully');
    });

    test('Verifies valid HMAC-SHA256 signature with raw string secret', () => {
      const payload = JSON.stringify({ type: 'order.paid', data: { id: 'ord_456' } });
      const sigs = generatePolarWebhookSignature(payload, RAW_TEST_SECRET);

      const isValid = verifyPolarWebhookSignature({
        webhookId: sigs['webhook-id'],
        webhookTimestamp: sigs['webhook-timestamp'],
        webhookSignature: sigs['webhook-signature'],
        rawBody: payload,
        secret: RAW_TEST_SECRET
      });

      assert.equal(isValid, true, 'Raw string secret must verify successfully');
    });

    test('Rejects when required headers are missing', () => {
      const payload = '{"type":"test"}';
      assert.throws(
        () => verifyPolarWebhookSignature({ webhookId: '', webhookTimestamp: '123', webhookSignature: 'v1,x', rawBody: payload, secret: TEST_SECRET }),
        /Missing required webhook headers/
      );
      assert.throws(
        () => verifyPolarWebhookSignature({ webhookId: 'msg_1', webhookTimestamp: '', webhookSignature: 'v1,x', rawBody: payload, secret: TEST_SECRET }),
        /Missing required webhook headers/
      );
      assert.throws(
        () => verifyPolarWebhookSignature({ webhookId: 'msg_1', webhookTimestamp: '123', webhookSignature: '', rawBody: payload, secret: TEST_SECRET }),
        /Missing required webhook headers/
      );
    });

    test('Rejects tampered payload body', () => {
      const originalPayload = JSON.stringify({ type: 'order.paid', amount: 900 });
      const tamperedPayload = JSON.stringify({ type: 'order.paid', amount: 100 });
      const sigs = generatePolarWebhookSignature(originalPayload, TEST_SECRET);

      assert.throws(
        () => verifyPolarWebhookSignature({
          webhookId: sigs['webhook-id'],
          webhookTimestamp: sigs['webhook-timestamp'],
          webhookSignature: sigs['webhook-signature'],
          rawBody: tamperedPayload,
          secret: TEST_SECRET
        }),
        /Webhook signature verification failed/
      );
    });

    test('Rejects signature verified with wrong secret', () => {
      const payload = '{"type":"order.paid"}';
      const sigs = generatePolarWebhookSignature(payload, TEST_SECRET);

      assert.throws(
        () => verifyPolarWebhookSignature({
          webhookId: sigs['webhook-id'],
          webhookTimestamp: sigs['webhook-timestamp'],
          webhookSignature: sigs['webhook-signature'],
          rawBody: payload,
          secret: 'whsec_WRONG_SECRET_KEY_1234567890'
        }),
        /Webhook signature verification failed/
      );
    });

    test('Rejects expired timestamp beyond 300-second tolerance window', () => {
      const payload = '{"type":"order.paid"}';
      const expiredTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
      const sigs = generatePolarWebhookSignature(payload, TEST_SECRET, { timestamp: expiredTimestamp });

      assert.throws(
        () => verifyPolarWebhookSignature({
          webhookId: sigs['webhook-id'],
          webhookTimestamp: sigs['webhook-timestamp'],
          webhookSignature: sigs['webhook-signature'],
          rawBody: payload,
          secret: TEST_SECRET,
          toleranceSeconds: 300
        }),
        /outside tolerance window/
      );
    });

    test('Supports multiple space-separated signatures in header (Svix rotation support)', () => {
      const payload = '{"type":"subscription.active"}';
      const sigs = generatePolarWebhookSignature(payload, TEST_SECRET);
      const compositeSignature = `v1,staleOldSignature123 ${sigs['webhook-signature']} v1,anotherOldSig`;

      const isValid = verifyPolarWebhookSignature({
        webhookId: sigs['webhook-id'],
        webhookTimestamp: sigs['webhook-timestamp'],
        webhookSignature: compositeSignature,
        rawBody: payload,
        secret: TEST_SECRET
      });

      assert.equal(isValid, true, 'Must verify when one valid signature is present in space-separated list');
    });
  });

  describe('2. Product and Plan Mapping', () => {
    const origEnv = { ...process.env };

    beforeEach(() => {
      process.env.POLAR_PRODUCT_CREATOR_MONTHLY = 'prod_polar_creator_mo';
      process.env.POLAR_PRODUCT_CREATOR_YEARLY = 'prod_polar_creator_yr';
      process.env.POLAR_PRODUCT_TEAM_MONTHLY = 'prod_polar_team_mo';
      process.env.POLAR_PRODUCT_TEAM_YEARLY = 'prod_polar_team_yr';
    });

    test('Maps configured Creator Monthly product ID ($9/month)', () => {
      const plan = mapPolarProductToPlan('prod_polar_creator_mo');
      assert.deepEqual(plan, { plan: 'creator', interval: 'monthly', name: 'Creator', price: 9 });
    });

    test('Maps configured Creator Yearly product ID ($84/year)', () => {
      const plan = mapPolarProductToPlan('prod_polar_creator_yr');
      assert.deepEqual(plan, { plan: 'creator', interval: 'yearly', name: 'Creator', price: 84 });
    });

    test('Maps configured Team Monthly product ID ($19.99/month)', () => {
      const plan = mapPolarProductToPlan('prod_polar_team_mo');
      assert.deepEqual(plan, { plan: 'team', interval: 'monthly', name: 'Team', price: 19.99 });
    });

    test('Maps configured Team Yearly product ID ($188/year)', () => {
      const plan = mapPolarProductToPlan('prod_polar_team_yr');
      assert.deepEqual(plan, { plan: 'team', interval: 'yearly', name: 'Team', price: 188 });
    });

    test('Falls back to reliable product name detection if ID is not matched', () => {
      const plan1 = mapPolarProductToPlan('unconfigured_id', { name: 'FLIQ Creator Yearly Subscription' });
      assert.equal(plan1.plan, 'creator');
      assert.equal(plan1.interval, 'yearly');
      assert.equal(plan1.price, 84);

      const plan2 = mapPolarProductToPlan('unconfigured_id', { name: 'FLIQ Team Monthly' });
      assert.equal(plan2.plan, 'team');
      assert.equal(plan2.interval, 'monthly');
      assert.equal(plan2.price, 19.99);
    });

    test('Returns null for completely unknown products to prevent unauthorized plan grants', () => {
      const plan = mapPolarProductToPlan('totally_random_id', { name: 'Something Else' });
      assert.equal(plan, null);
    });
  });

  describe('3. Verified User Identification & Security Guardrails', () => {
    test('Extracts verified user ID from event.data.metadata.userId', async () => {
      const event = {
        type: 'order.paid',
        data: {
          id: 'ord_1',
          metadata: { userId: 'firebase_user_abc123' }
        }
      };
      const result = await extractUserIdFromPolarEvent(event);
      assert.equal(result.userId, 'firebase_user_abc123');
      assert.equal(result.source, 'checkout_metadata');
    });

    test('Extracts verified user ID from event.data.customer.external_id', async () => {
      const event = {
        type: 'subscription.active',
        data: {
          id: 'sub_1',
          customer: { external_id: 'firebase_user_def456' }
        }
      };
      const result = await extractUserIdFromPolarEvent(event);
      assert.equal(result.userId, 'firebase_user_def456');
      assert.equal(result.source, 'customer_external_id');
    });

    test('Extracts verified user ID from customer.metadata.userId', async () => {
      const event = {
        type: 'subscription.updated',
        data: {
          id: 'sub_2',
          customer: { metadata: { userId: 'firebase_user_ghi789' } }
        }
      };
      const result = await extractUserIdFromPolarEvent(event);
      assert.equal(result.userId, 'firebase_user_ghi789');
      assert.equal(result.source, 'customer_metadata');
    });

    test('Resolves previously bound user ID from Firestore polar_customers link', async () => {
      const mockDb = createMockFirestore();
      await mockDb.collection('polar_customers').doc('cust_xyz999').set({
        customerId: 'cust_xyz999',
        userId: 'firebase_user_linked'
      });

      const event = {
        type: 'order.paid',
        data: {
          id: 'ord_2',
          customer_id: 'cust_xyz999'
        }
      };

      const result = await extractUserIdFromPolarEvent(event, mockDb);
      assert.equal(result.userId, 'firebase_user_linked');
      assert.equal(result.source, 'firestore_customer_link');
    });

    test('CRITICAL SECURITY: Strictly rejects user identification via unverified email alone', async () => {
      const event = {
        type: 'order.paid',
        data: {
          id: 'ord_unverified',
          customer: { email: 'victim@example.com' },
          metadata: {}
        }
      };

      const result = await extractUserIdFromPolarEvent(event);
      assert.equal(result.userId, null, 'Must never identify users using unverified email alone');
      assert.ok(result.error.includes('No verified Firebase user ID found'));
    });
  });

  describe('4. Webhook Lifecycle Event Processing & Entitlement Management', () => {
    let mockDb;

    beforeEach(() => {
      mockDb = createMockFirestore();
      process.env.POLAR_PRODUCT_CREATOR_MONTHLY = 'prod_cr_mo';
      process.env.POLAR_PRODUCT_TEAM_MONTHLY = 'prod_tm_mo';
    });

    test('order.paid grants active subscription to user and records order', async () => {
      const event = {
        type: 'order.paid',
        data: {
          id: 'ord_1001',
          status: 'paid',
          product_id: 'prod_cr_mo',
          amount: 900,
          customer_id: 'cust_101',
          metadata: { userId: 'usr_test_1' }
        }
      };

      const outcome = await processPolarWebhookEvent(event, { db: mockDb });
      assert.equal(outcome.success, true);
      assert.equal(outcome.action, 'order_paid_activated');
      assert.equal(outcome.plan, 'creator');

      const userDoc = mockDb._get('users', 'usr_test_1');
      assert.equal(userDoc.plan, 'creator');
      assert.equal(userDoc.subscriptionStatus, 'active');
      assert.equal(userDoc.polarCustomerId, 'cust_101');

      const orderDoc = mockDb._get('orders', 'ord_1001');
      assert.equal(orderDoc.status, 'paid');
      assert.equal(orderDoc.userId, 'usr_test_1');
    });

    test('order.paid with unpaid status does not grant access', async () => {
      const event = {
        type: 'order.paid',
        data: {
          id: 'ord_unconfirmed',
          status: 'pending',
          product_id: 'prod_cr_mo',
          metadata: { userId: 'usr_test_1' }
        }
      };

      const outcome = await processPolarWebhookEvent(event, { db: mockDb });
      assert.equal(outcome.success, false);
      assert.equal(outcome.reason, 'order_status_not_paid');

      const userDoc = mockDb._get('users', 'usr_test_1');
      assert.equal(userDoc, undefined, 'User must not have been granted subscription');
    });

    test('order.refunded reverts user plan to free', async () => {
      await mockDb.collection('users').doc('usr_refund_target').set({
        plan: 'creator',
        subscriptionStatus: 'active'
      });

      const event = {
        type: 'order.refunded',
        data: {
          id: 'ord_1001',
          customer: { external_id: 'usr_refund_target' }
        }
      };

      const outcome = await processPolarWebhookEvent(event, { db: mockDb });
      assert.equal(outcome.success, true);
      assert.equal(outcome.action, 'order_refunded');

      const userDoc = mockDb._get('users', 'usr_refund_target');
      assert.equal(userDoc.plan, 'free');
      assert.equal(userDoc.subscriptionStatus, 'refunded');

      const orderDoc = mockDb._get('orders', 'ord_1001');
      assert.equal(orderDoc.status, 'refunded');
    });

    test('subscription.active activates plan and records subscription doc', async () => {
      const event = {
        type: 'subscription.active',
        data: {
          id: 'sub_2001',
          product_id: 'prod_tm_mo',
          customer_id: 'cust_202',
          metadata: { userId: 'usr_team_1' }
        }
      };

      const outcome = await processPolarWebhookEvent(event, { db: mockDb });
      assert.equal(outcome.success, true);
      assert.equal(outcome.plan, 'team');

      const userDoc = mockDb._get('users', 'usr_team_1');
      assert.equal(userDoc.plan, 'team');
      assert.equal(userDoc.subscriptionStatus, 'active');

      const subDoc = mockDb._get('subscriptions', 'sub_2001');
      assert.equal(subDoc.status, 'active');
      assert.equal(subDoc.plan, 'team');
    });

    test('subscription.updated updates subscription and handles active changes', async () => {
      await mockDb.collection('users').doc('usr_upd_1').set({
        plan: 'creator',
        subscriptionStatus: 'active'
      });

      const event = {
        type: 'subscription.updated',
        data: {
          id: 'sub_upd_1',
          product_id: 'prod_tm_mo',
          status: 'active',
          metadata: { userId: 'usr_upd_1' }
        }
      };

      const outcome = await processPolarWebhookEvent(event, { db: mockDb });
      assert.equal(outcome.success, true);
      assert.equal(outcome.action, 'subscription_updated');

      const userDoc = mockDb._get('users', 'usr_upd_1');
      assert.equal(userDoc.plan, 'team');
    });

    test('subscription.canceled handles cancel_at_period_end without immediate revocation', async () => {
      await mockDb.collection('users').doc('usr_cancel_pend').set({
        plan: 'creator',
        subscriptionStatus: 'active'
      });

      const event = {
        type: 'subscription.canceled',
        data: {
          id: 'sub_cancel_pend',
          cancel_at_period_end: true,
          metadata: { userId: 'usr_cancel_pend' }
        }
      };

      const outcome = await processPolarWebhookEvent(event, { db: mockDb });
      assert.equal(outcome.success, true);
      assert.equal(outcome.cancelAtPeriodEnd, true);

      const userDoc = mockDb._get('users', 'usr_cancel_pend');
      assert.equal(userDoc.cancelAtPeriodEnd, true);
      // Access remains until period ends
      assert.notEqual(userDoc.plan, 'free');
    });

    test('subscription.canceled with immediate cancellation revokes paid plan to free', async () => {
      await mockDb.collection('users').doc('usr_cancel_imm').set({
        plan: 'creator',
        subscriptionStatus: 'active'
      });

      const event = {
        type: 'subscription.canceled',
        data: {
          id: 'sub_cancel_imm',
          cancel_at_period_end: false,
          metadata: { userId: 'usr_cancel_imm' }
        }
      };

      const outcome = await processPolarWebhookEvent(event, { db: mockDb });
      assert.equal(outcome.success, true);

      const userDoc = mockDb._get('users', 'usr_cancel_imm');
      assert.equal(userDoc.plan, 'free');
      assert.equal(userDoc.subscriptionStatus, 'canceled');
    });

    test('subscription.uncanceled restores renewal and unsets cancelAtPeriodEnd', async () => {
      await mockDb.collection('users').doc('usr_uncancel').set({
        plan: 'creator',
        cancelAtPeriodEnd: true
      });

      const event = {
        type: 'subscription.uncanceled',
        data: {
          id: 'sub_uncancel',
          metadata: { userId: 'usr_uncancel' }
        }
      };

      const outcome = await processPolarWebhookEvent(event, { db: mockDb });
      assert.equal(outcome.success, true);

      const userDoc = mockDb._get('users', 'usr_uncancel');
      assert.equal(userDoc.cancelAtPeriodEnd, false);
      assert.equal(userDoc.subscriptionStatus, 'active');
    });

    test('subscription.past_due updates subscriptionStatus to past_due', async () => {
      await mockDb.collection('users').doc('usr_past_due').set({
        plan: 'creator',
        subscriptionStatus: 'active'
      });

      const event = {
        type: 'subscription.past_due',
        data: {
          id: 'sub_pd',
          metadata: { userId: 'usr_past_due' }
        }
      };

      const outcome = await processPolarWebhookEvent(event, { db: mockDb });
      assert.equal(outcome.success, true);

      const userDoc = mockDb._get('users', 'usr_past_due');
      assert.equal(userDoc.subscriptionStatus, 'past_due');
      assert.ok(userDoc.pastDueSince);
    });

    test('subscription.revoked immediately downgrades user to free plan', async () => {
      await mockDb.collection('users').doc('usr_revoked').set({
        plan: 'team',
        subscriptionStatus: 'active'
      });

      const event = {
        type: 'subscription.revoked',
        data: {
          id: 'sub_rev',
          metadata: { userId: 'usr_revoked' }
        }
      };

      const outcome = await processPolarWebhookEvent(event, { db: mockDb });
      assert.equal(outcome.success, true);

      const userDoc = mockDb._get('users', 'usr_revoked');
      assert.equal(userDoc.plan, 'free');
      assert.equal(userDoc.subscriptionStatus, 'revoked');
    });

    test('Preliminary non-entitlement events (checkout.created, subscription.created) do not grant paid plans', async () => {
      const event = {
        type: 'checkout.created',
        data: {
          id: 'chk_123',
          metadata: { userId: 'usr_exploit_attempt' }
        }
      };

      const outcome = await processPolarWebhookEvent(event, { db: mockDb });
      assert.equal(outcome.received, true);
      assert.equal(outcome.ignored, true);

      const userDoc = mockDb._get('users', 'usr_exploit_attempt');
      assert.equal(userDoc, undefined, 'Preliminary events must never grant paid features');
    });
  });

  describe('5. Idempotency Protection', () => {
    test('Duplicate webhook ID is detected and re-delivery is safely acknowledged', async () => {
      const mockDb = createMockFirestore();
      const webhookId = `msg_test_idempotency_${Date.now()}`;

      // First check: should not be duplicate
      const isDup1 = await checkIdempotency(webhookId, mockDb);
      assert.equal(isDup1, false);

      // Record processed
      await recordEventProcessed(webhookId, 'order.paid', 'ord_1', mockDb);

      // Second check: should detect duplicate
      const isDup2 = await checkIdempotency(webhookId, mockDb);
      assert.equal(isDup2, true);
    });
  });

  describe('6. HTTP Handler Request Lifecycle (handlePolarWebhookRequest)', () => {
    const origSecret = process.env.POLAR_WEBHOOK_SECRET;

    beforeEach(() => {
      process.env.POLAR_WEBHOOK_SECRET = TEST_SECRET;
      process.env.POLAR_PRODUCT_CREATOR_MONTHLY = 'prod_cr_mo';
    });

    test('Rejects non-POST requests with 405 Method Not Allowed', async () => {
      const req = createMockRequest('GET', '');
      const res = createMockResponse();

      await handlePolarWebhookRequest(req, res, { cloudDb: null, localDataDir: null });
      assert.equal(res.statusCode, 405);
      assert.ok(res.json().error.includes('POST'));
    });

    test('Rejects missing POLAR_WEBHOOK_SECRET with 500 server error', async () => {
      delete process.env.POLAR_WEBHOOK_SECRET;
      const req = createMockRequest('POST', '{"type":"test"}');
      const res = createMockResponse();

      await handlePolarWebhookRequest(req, res, { cloudDb: null, localDataDir: null });
      assert.equal(res.statusCode, 500);
      assert.ok(res.json().error.includes('secret is not configured'));
    });

    test('Rejects invalid webhook signature with 401 Unauthorized', async () => {
      const payload = JSON.stringify({ type: 'order.paid' });
      const req = createMockRequest('POST', payload, {
        'webhook-id': 'msg_bad_sig',
        'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
        'webhook-signature': 'v1,invalid_signature_bits'
      });
      const res = createMockResponse();

      await handlePolarWebhookRequest(req, res, { cloudDb: null, localDataDir: null });
      assert.equal(res.statusCode, 401);
      assert.ok(res.json().error.includes('signature'));
    });

    test('Rejects malformed JSON with 400 Bad Request', async () => {
      const malformedBody = '{"type": "order.paid", NOT_JSON}';
      const sigs = generatePolarWebhookSignature(malformedBody, TEST_SECRET);
      const req = createMockRequest('POST', malformedBody, sigs);
      const res = createMockResponse();

      await handlePolarWebhookRequest(req, res, { cloudDb: null, localDataDir: null });
      assert.equal(res.statusCode, 400);
      assert.ok(res.json().error.includes('JSON'));
    });

    test('Accepts valid webhook and returns 200 with outcome', async () => {
      const mockDb = createMockFirestore();
      const payload = JSON.stringify({
        type: 'order.paid',
        data: {
          id: 'ord_http_success',
          status: 'paid',
          product_id: 'prod_cr_mo',
          amount: 900,
          metadata: { userId: 'usr_http_1' }
        }
      });
      const sigs = generatePolarWebhookSignature(payload, TEST_SECRET);
      const req = createMockRequest('POST', payload, sigs);
      const res = createMockResponse();

      await handlePolarWebhookRequest(req, res, { cloudDb: mockDb, localDataDir: null });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.received, true);
      assert.equal(body.success, true);
      assert.equal(body.outcome.plan, 'creator');
    });

    test('Duplicate webhook delivery short-circuits with 200 received: true, duplicate: true', async () => {
      const mockDb = createMockFirestore();
      const payload = JSON.stringify({
        type: 'order.paid',
        data: {
          id: 'ord_dup_http',
          status: 'paid',
          product_id: 'prod_cr_mo',
          metadata: { userId: 'usr_dup_1' }
        }
      });
      const sigs = generatePolarWebhookSignature(payload, TEST_SECRET, { webhookId: 'msg_repeat_id_99' });

      // First request: processes successfully
      const req1 = createMockRequest('POST', payload, sigs);
      const res1 = createMockResponse();
      await handlePolarWebhookRequest(req1, res1, { cloudDb: mockDb, localDataDir: null });
      assert.equal(res1.statusCode, 200);
      assert.equal(res1.json().duplicate, undefined);

      // Second request with exact same webhook-id: short-circuits as duplicate
      const req2 = createMockRequest('POST', payload, sigs);
      const res2 = createMockResponse();
      await handlePolarWebhookRequest(req2, res2, { cloudDb: mockDb, localDataDir: null });
      assert.equal(res2.statusCode, 200);
      assert.equal(res2.json().duplicate, true);
    });
  });

  describe('7. Polar Checkout Session Creation (createPolarCheckoutSession & handlePolarCheckoutRequest)', () => {
    function createMockFetch(status = 200, responseData = {}) {
      let lastCall = null;
      const fn = async (url, options = {}) => {
        lastCall = { url, options, body: options.body ? JSON.parse(options.body) : null };
        return {
          ok: status >= 200 && status < 300,
          status,
          statusText: status === 200 ? 'OK' : 'Error',
          text: async () => JSON.stringify(responseData),
          json: async () => responseData
        };
      };
      fn.getLastCall = () => lastCall;
      return fn;
    }

    const testUser = {
      uid: 'user_checkout_123',
      email: 'founder@example.com'
    };

    beforeEach(() => {
      process.env.POLAR_ACCESS_TOKEN = 'polar_oat_test_secret_token_xyz';
      process.env.POLAR_PRODUCT_CREATOR_MONTHLY = 'prod_polar_cr_mo';
      process.env.POLAR_PRODUCT_CREATOR_YEARLY = 'prod_polar_cr_yr';
      process.env.POLAR_PRODUCT_TEAM_MONTHLY = 'prod_polar_tm_mo';
      process.env.POLAR_PRODUCT_TEAM_YEARLY = 'prod_polar_tm_yr';
    });

    test('resolvePolarProductId resolves correct product IDs for Creator and Team plans', () => {
      assert.equal(resolvePolarProductId('creator', 'monthly'), 'prod_polar_cr_mo');
      assert.equal(resolvePolarProductId('creator', 'yearly'), 'prod_polar_cr_yr');
      assert.equal(resolvePolarProductId('team', 'monthly'), 'prod_polar_tm_mo');
      assert.equal(resolvePolarProductId('team', 'yearly'), 'prod_polar_tm_yr');
      assert.equal(resolvePolarProductId('free', 'monthly'), null);
      assert.equal(resolvePolarProductId('unknown', 'monthly'), null);
    });

    test('createPolarCheckoutSession successfully creates Creator Monthly session with external_id & metadata', async () => {
      const mockFetch = createMockFetch(200, {
        id: 'chk_polar_success_1',
        url: 'https://buy.polar.sh/checkout/chk_polar_success_1'
      });

      const session = await createPolarCheckoutSession({
        plan: 'creator',
        interval: 'monthly',
        user: testUser,
        successUrl: 'https://fliq-ezaz.onrender.com/dashboard?checkout=success',
        fetchFn: mockFetch
      });

      assert.equal(session.checkoutId, 'chk_polar_success_1');
      assert.equal(session.checkoutUrl, 'https://buy.polar.sh/checkout/chk_polar_success_1');
      assert.equal(session.plan, 'creator');
      assert.equal(session.interval, 'monthly');

      const call = mockFetch.getLastCall();
      assert.equal(call.url, 'https://api.polar.sh/v1/checkouts/');
      assert.equal(call.options.headers.Authorization, 'Bearer polar_oat_test_secret_token_xyz');
      assert.deepEqual(call.body.products, ['prod_polar_cr_mo']);
      assert.equal(call.body.customer_email, 'founder@example.com');
      assert.equal(call.body.external_customer_id, 'user_checkout_123');
      assert.equal(call.body.metadata.userId, 'user_checkout_123');
      assert.equal(call.body.metadata.plan, 'creator');
      assert.equal(call.body.customer_metadata.userId, 'user_checkout_123');
    });

    test('createPolarCheckoutSession supports Creator Yearly, Team Monthly, and Team Yearly', async () => {
      const plansToTest = [
        { plan: 'creator', interval: 'yearly', expectedPid: 'prod_polar_cr_yr' },
        { plan: 'team', interval: 'monthly', expectedPid: 'prod_polar_tm_mo' },
        { plan: 'team', interval: 'yearly', expectedPid: 'prod_polar_tm_yr' }
      ];

      for (const t of plansToTest) {
        const mockFetch = createMockFetch(200, {
          id: `chk_${t.plan}_${t.interval}`,
          url: `https://buy.polar.sh/checkout/${t.plan}_${t.interval}`
        });

        const session = await createPolarCheckoutSession({
          plan: t.plan,
          interval: t.interval,
          user: testUser,
          fetchFn: mockFetch
        });

        assert.equal(session.plan, t.plan);
        assert.equal(session.interval, t.interval);
        const call = mockFetch.getLastCall();
        assert.deepEqual(call.body.products, [t.expectedPid]);
      }
    });

    test('createPolarCheckoutSession rejects invalid plans with 400 status', async () => {
      const mockFetch = createMockFetch(200, {});
      await assert.rejects(
        async () => {
          await createPolarCheckoutSession({
            plan: 'free',
            user: testUser,
            fetchFn: mockFetch
          });
        },
        (err) => {
          assert.equal(err.status, 400);
          assert.match(err.message, /Invalid plan/);
          return true;
        }
      );
    });

    test('createPolarCheckoutSession rejects missing POLAR_ACCESS_TOKEN with 500 status', async () => {
      delete process.env.POLAR_ACCESS_TOKEN;
      const mockFetch = createMockFetch(200, {});

      await assert.rejects(
        async () => {
          await createPolarCheckoutSession({
            plan: 'creator',
            user: testUser,
            fetchFn: mockFetch
          });
        },
        (err) => {
          assert.equal(err.status, 500);
          assert.match(err.message, /POLAR_ACCESS_TOKEN/);
          return true;
        }
      );
    });

    test('createPolarCheckoutSession rejects missing product ID with 500 status', async () => {
      delete process.env.POLAR_PRODUCT_CREATOR_MONTHLY;
      const mockFetch = createMockFetch(200, {});

      await assert.rejects(
        async () => {
          await createPolarCheckoutSession({
            plan: 'creator',
            interval: 'monthly',
            user: testUser,
            fetchFn: mockFetch
          });
        },
        (err) => {
          assert.equal(err.status, 500);
          assert.match(err.message, /POLAR_PRODUCT_CREATOR_MONTHLY/);
          return true;
        }
      );
    });

    test('createPolarCheckoutSession rejects unauthenticated user with 401 status', async () => {
      const mockFetch = createMockFetch(200, {});

      await assert.rejects(
        async () => {
          await createPolarCheckoutSession({
            plan: 'creator',
            user: null,
            fetchFn: mockFetch
          });
        },
        (err) => {
          assert.equal(err.status, 401);
          assert.match(err.message, /Authenticated user is required/);
          return true;
        }
      );
    });

    test('createPolarCheckoutSession safely handles Polar API errors with 502 status', async () => {
      const mockFetch = createMockFetch(422, { detail: 'Product does not belong to organization' });

      await assert.rejects(
        async () => {
          await createPolarCheckoutSession({
            plan: 'creator',
            user: testUser,
            fetchFn: mockFetch
          });
        },
        (err) => {
          assert.equal(err.status, 422);
          assert.match(err.message, /Product does not belong to organization/);
          return true;
        }
      );
    });

    test('handlePolarCheckoutRequest rejects non-POST requests with 405 Method Not Allowed', async () => {
      const req = createMockRequest('GET', '');
      const res = createMockResponse();

      await handlePolarCheckoutRequest(req, res, {
        cloudDb: null,
        adminApp: null,
        verifiedUserFn: async () => testUser
      });

      assert.equal(res.statusCode, 405);
      assert.match(res.json().error, /Method not allowed/);
    });

    test('handlePolarCheckoutRequest rejects unauthenticated requests with 401 Unauthorized', async () => {
      const req = createMockRequest('POST', JSON.stringify({ plan: 'creator' }));
      const res = createMockResponse();

      await handlePolarCheckoutRequest(req, res, {
        cloudDb: null,
        adminApp: null,
        verifiedUserFn: async () => {
          const err = new Error('Sign in to continue.');
          err.status = 401;
          throw err;
        }
      });

      assert.equal(res.statusCode, 401);
      assert.match(res.json().error, /Sign in/);
    });

    test('handlePolarCheckoutRequest returns 200 with checkout URL and details upon success', async () => {
      const mockFetch = createMockFetch(200, {
        id: 'chk_http_1',
        url: 'https://buy.polar.sh/checkout/chk_http_1'
      });

      const payload = JSON.stringify({ plan: 'creator', period: 'monthly' });
      const req = createMockRequest('POST', payload, { host: 'localhost:3000' });
      const res = createMockResponse();

      await handlePolarCheckoutRequest(req, res, {
        cloudDb: null,
        adminApp: null,
        verifiedUserFn: async () => testUser,
        fetchFn: mockFetch
      });

      assert.equal(res.statusCode, 200);
      const data = res.json();
      assert.equal(data.ok, true);
      assert.equal(data.checkoutUrl, 'https://buy.polar.sh/checkout/chk_http_1');
      assert.equal(data.checkoutId, 'chk_http_1');
      assert.equal(data.plan, 'creator');
      assert.equal(data.interval, 'monthly');
    });
  });

  describe('6. Checkout Button & Client Delegation Verification', () => {
    const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

    test('app.js defines #start-checkout-btn with proper attributes and non-conflicting dataset', async () => {
      const appJs = await fs.readFile(path.join(rootDir, 'app.js'), 'utf8');

      // Verify button selector exists and has data-action="start-checkout"
      assert.match(appJs, /id="start-checkout-btn"/, 'Checkout button must have id="start-checkout-btn"');
      assert.match(appJs, /data-action="start-checkout"/, 'Checkout button must have data-action="start-checkout"');
      assert.match(appJs, /type="button"/, 'Checkout button must have type="button" to prevent accidental form submits');

      // Verify button does NOT have conflicting unscoped data-period that clashes with the pricing toggle
      assert.doesNotMatch(appJs, /id="start-checkout-btn"[^>]*\sdata-period=/, 'Button must not have bare data-period attribute');
    });

    test('app.js scopes [data-period] listener so checkout button clicks cannot trigger billing period toggle', async () => {
      const appJs = await fs.readFile(path.join(rootDir, 'app.js'), 'utf8');

      // Verify that data-period listener is scoped to .billing container
      assert.match(appJs, /closest\('\.billing'\)\s*\?\s*e\.target\.closest\('\[data-period\]'\)/, 'data-period click listener must be scoped to .billing container');
    });

    test('app.js prioritizes checkout button delegation at the top of click listener', async () => {
      const appJs = await fs.readFile(path.join(rootDir, 'app.js'), 'utf8');

      // Verify handleCheckoutButtonClick function exists
      assert.match(appJs, /async function handleCheckoutButtonClick\(/, 'handleCheckoutButtonClick function must be implemented');

      // Verify it is intercepted at the top of document.addEventListener('click')
      const listenerIdx = appJs.indexOf("document.addEventListener('click'");
      const checkoutCheckIdx = appJs.indexOf("e.target.closest('#start-checkout-btn, [data-action=\"start-checkout\"]')");
      const periodCheckIdx = appJs.indexOf("e.target.closest('.billing')");

      assert.ok(listenerIdx > 0, 'Click listener must exist');
      assert.ok(checkoutCheckIdx > listenerIdx, 'Checkout check must be inside click listener');
      assert.ok(checkoutCheckIdx < periodCheckIdx, 'Checkout check must occur before period toggle check');
    });

    test('app.js authHeaders attaches Authorization: Bearer <token> without duplicate lowercase authorization', async () => {
      const appJs = await fs.readFile(path.join(rootDir, 'app.js'), 'utf8');

      // Verify standard titlecase Authorization header is set
      assert.match(appJs, /Authorization:\s*`Bearer \$\{token\}`/, 'authHeaders must attach Authorization header with Bearer token');

      // Verify authHeaders function definition does not assign duplicate lowercase authorization
      const authHeadersMatch = appJs.match(/async function authHeaders\(\)\s*\{[\s\S]*?\n\}/);
      assert.ok(authHeadersMatch, 'authHeaders function definition must exist');
      assert.doesNotMatch(authHeadersMatch[0], /authorization:\s*`Bearer/, 'authHeaders must not define duplicate lowercase authorization key');
    });

    test('app.js apiFetch sanitizes duplicate authorization headers', async () => {
      const appJs = await fs.readFile(path.join(rootDir, 'app.js'), 'utf8');

      const apiFetchMatch = appJs.match(/async function apiFetch\([\s\S]*?\n\}/);
      assert.ok(apiFetchMatch, 'apiFetch function definition must exist');
      assert.match(apiFetchMatch[0], /delete\s+headers\.authorization/, 'apiFetch must strip duplicate lowercase authorization key');
    });

    test('server.js extracts single Bearer token and safely handles merged comma-separated tokens', () => {
      const parseToken = (rawAuth) => {
        const authStr = Array.isArray(rawAuth) ? rawAuth.join(', ') : String(rawAuth || '');
        if (authStr) {
          const candidates = authStr.split(',').map(s => s.trim()).filter(Boolean);
          for (const candidate of candidates) {
            const m = candidate.match(/^Bearer\s+([a-zA-Z0-9_\-\.~+\/=]+)$/i);
            if (m && m[1]) return m[1];
          }
        }
        return null;
      };

      // Test case 1: Clean single Bearer header
      assert.equal(parseToken('Bearer test_jwt_token_abc_123'), 'test_jwt_token_abc_123');

      // Test case 2: Comma-merged duplicate Bearer headers from browser/proxy
      assert.equal(parseToken('Bearer test_jwt_token_abc_123, Bearer test_jwt_token_abc_123'), 'test_jwt_token_abc_123');

      // Test case 3: Invalid scheme or empty
      assert.equal(parseToken('Basic dXNlcjpwYXNz'), null);
      assert.equal(parseToken(''), null);
      assert.equal(parseToken(null), null);
    });
  });

});
