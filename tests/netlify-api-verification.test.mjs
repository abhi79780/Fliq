import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handler } from '../netlify/functions/api.mjs';

describe('Netlify Serverless Function (netlify/functions/api.mjs) Verification', async () => {
  const targetOwnerUid = '3nNFGpqjoIcrTSKib4proR5lU1g1';
  const targetTestId = '22d15911-0633-42f5-bc8d-7d28371cc5cc';
  const testProjectId = 'fliq-test-project';

  // Generate an authentic RSA keypair for real RS256 cryptographic verification
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const testKid = 'test-rsa-key-01';

  // Configure test environment variables for verification runner
  process.env.NODE_ENV = 'test';
  process.env.FIREBASE_PROJECT_ID = testProjectId;
  process.env.FLIQ_TEST_PUBLIC_CERT_KID = testKid;
  process.env.FLIQ_TEST_PUBLIC_CERT = publicKey;

  // Helper to generate a validly signed Firebase ID token with RS256
  function createSignedFirebaseToken({
    uid = targetOwnerUid,
    projectId = testProjectId,
    kid = testKid,
    alg = 'RS256',
    expiresIn = 3600,
    issuedAt = Math.floor(Date.now() / 1000) - 10,
    authTime = Math.floor(Date.now() / 1000) - 10,
    overridePayload = {}
  } = {}) {
    const header = {
      alg,
      kid,
      typ: 'JWT'
    };

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: `https://securetoken.google.com/${projectId}`,
      aud: projectId,
      auth_time: authTime,
      user_id: uid,
      sub: uid,
      iat: issuedAt,
      exp: now + expiresIn,
      email: `${uid}@fliq.local`,
      firebase: { sign_in_provider: 'password' },
      ...overridePayload
    };

    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signingInput = `${headerB64}.${payloadB64}`;

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    const signatureB64 = signer.sign(privateKey, 'base64url');

    return `${signingInput}.${signatureB64}`;
  }

  // 1. Unauthenticated requests
  test('GET /api/tests without auth returns HTTP 401', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: '/api/tests'
    });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.match(body.error, /sign in/i);
  });

  test('GET /api/tests/:id without auth returns HTTP 401', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: `/api/tests/${targetTestId}`
    });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.match(body.error, /sign in/i);
  });

  test('GET /api/screenshots/:filename without auth returns HTTP 401', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: `/api/screenshots/${targetTestId}-desktop.png`
    });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.match(body.error, /sign in/i);
  });

  // 2. Token verification edge cases
  test('Request with malformed token returns HTTP 401', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: '/api/tests',
      headers: { authorization: 'Bearer not-a-valid-jwt' }
    });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.match(body.error, /token/i);
  });

  test('Request with expired token returns HTTP 401', async () => {
    const expiredToken = createSignedFirebaseToken({ expiresIn: -300 }); // expired 5 mins ago
    const res = await handler({
      httpMethod: 'GET',
      path: '/api/tests',
      headers: { authorization: `Bearer ${expiredToken}` }
    });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.match(body.error, /expired/i);
  });

  test('Request with wrong audience returns HTTP 401', async () => {
    const wrongAudToken = createSignedFirebaseToken({ projectId: 'wrong-project-id' });
    const res = await handler({
      httpMethod: 'GET',
      path: '/api/tests',
      headers: { authorization: `Bearer ${wrongAudToken}` }
    });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.match(body.error, /audience|issuer/i);
  });

  test('Request with unknown signing key returns HTTP 401', async () => {
    const unknownKeyToken = createSignedFirebaseToken({ kid: 'unknown-key-999' });
    const res = await handler({
      httpMethod: 'GET',
      path: '/api/tests',
      headers: { authorization: `Bearer ${unknownKeyToken}` }
    });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.match(body.error, /unknown key/i);
  });

  // 3. Authenticated owner requests
  test('GET /api/tests for test owner returns HTTP 200 and includes target test', async () => {
    const validOwnerToken = createSignedFirebaseToken({ uid: targetOwnerUid });
    const res = await handler({
      httpMethod: 'GET',
      path: '/api/tests',
      headers: { authorization: `Bearer ${validOwnerToken}` }
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(Array.isArray(body), true);
    const found = body.find(t => t.id === targetTestId);
    assert.ok(found, `Expected test ${targetTestId} to be returned to owner ${targetOwnerUid}`);
    assert.equal(found.id, targetTestId);
    assert.equal(found.status, 'completed');
  });

  test('GET /api/tests/:id for test owner returns HTTP 200 with canManageSharing: true', async () => {
    const validOwnerToken = createSignedFirebaseToken({ uid: targetOwnerUid });
    const res = await handler({
      httpMethod: 'GET',
      path: `/api/tests/${targetTestId}`,
      headers: { authorization: `Bearer ${validOwnerToken}` }
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.id, targetTestId);
    assert.equal(body.canManageSharing, true);
  });

  // 4. Different user / unauthorized access enforcement
  test('GET /api/tests for different user excludes the target test', async () => {
    const differentUserToken = createSignedFirebaseToken({ uid: 'unauthorized-user-xyz' });
    const res = await handler({
      httpMethod: 'GET',
      path: '/api/tests',
      headers: { authorization: `Bearer ${differentUserToken}` }
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const found = body.find(t => t.id === targetTestId);
    assert.equal(found, undefined, 'Different user must NOT see another user\'s test');
  });

  test('GET /api/tests/:id for different user returns HTTP 403 Forbidden', async () => {
    const differentUserToken = createSignedFirebaseToken({ uid: 'unauthorized-user-xyz' });
    const res = await handler({
      httpMethod: 'GET',
      path: `/api/tests/${targetTestId}`,
      headers: { authorization: `Bearer ${differentUserToken}` }
    });
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.match(body.error, /permission|access denied/i);
  });

  test('GET /api/screenshots/:filename for different user returns HTTP 403 Forbidden', async () => {
    const differentUserToken = createSignedFirebaseToken({ uid: 'unauthorized-user-xyz' });
    const res = await handler({
      httpMethod: 'GET',
      path: `/api/screenshots/${targetTestId}-desktop.png`,
      headers: { authorization: `Bearer ${differentUserToken}` }
    });
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.match(body.error, /permission|access denied/i);
  });

  // 5. Screenshot access for owner
  test('GET /api/screenshots/:filename for owner returns HTTP 200 with base64 PNG', async () => {
    const validOwnerToken = createSignedFirebaseToken({ uid: targetOwnerUid });
    const res = await handler({
      httpMethod: 'GET',
      path: `/api/screenshots/${targetTestId}-desktop.png`,
      headers: { authorization: `Bearer ${validOwnerToken}` }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'image/png');
    assert.equal(res.isBase64Encoded, true);
    assert.ok(res.body && res.body.length > 100);
  });

  // 6. Non-existent test ID
  test('GET /api/tests/non-existent-id returns HTTP 404', async () => {
    const validOwnerToken = createSignedFirebaseToken({ uid: targetOwnerUid });
    const res = await handler({
      httpMethod: 'GET',
      path: '/api/tests/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${validOwnerToken}` }
    });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.match(body.error, /not found/i);
  });

  // 7. General routing
  test('GET /api/health returns HTTP 200', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: '/api/health'
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.serverless, true);
  });

  test('GET /api/firebase-config returns HTTP 200', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: '/api/firebase-config'
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(typeof body.configured, 'boolean');
  });

  // 8. Netlify Functions Web Request / Response Verification
  test('handler handles GET /api/health with standard Request returning Response', async () => {
    const req = new Request('http://localhost/api/health', { method: 'GET' });
    const res = await handler(req);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.serverless, true);
  });

  test('handler handles authenticated GET /api/tests with standard Request returning Response', async () => {
    const validOwnerToken = createSignedFirebaseToken({ uid: targetOwnerUid });
    const req = new Request('http://localhost/api/tests', {
      method: 'GET',
      headers: { authorization: `Bearer ${validOwnerToken}` }
    });
    const res = await handler(req);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(Array.isArray(body), true);
    const found = body.find(t => t.id === targetTestId);
    assert.ok(found, `Expected test ${targetTestId} in Response`);
  });

  test('handler returns 403 Forbidden for unauthorized single test access with standard Request', async () => {
    const differentUserToken = createSignedFirebaseToken({ uid: 'unauthorized-user-xyz' });
    const req = new Request(`http://localhost/api/tests/${targetTestId}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${differentUserToken}` }
    });
    const res = await handler(req);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /permission|access denied/i);
  });
});
