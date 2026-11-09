import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  verifyPolarWebhookSignature,
  generatePolarWebhookSignature,
  getSecretBuffer,
  getPolarProductConfig,
  mapPolarProductToPlan,
  extractUserIdFromPolarEvent,
  checkIdempotency,
  recordEventProcessed,
  processPolarWebhookEvent,
  handlePolarWebhookRequest
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

});
