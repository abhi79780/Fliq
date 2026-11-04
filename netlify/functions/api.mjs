import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {
  getAllTests,
  getTestById,
  saveTestRecord,
  getScreenshotBuffer,
  getRecordOwnerId,
  isUserAuthorizedForRecord
} from './storage.mjs';
import { validateTarget, runAuditScan } from './audit-engine.mjs';

// In-memory cache for Google's public x509 certificates (rotated periodically by Google)
let googleCertsCache = null;
let googleCertsExpiry = 0;

async function getGooglePublicCerts(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && googleCertsCache && now < googleCertsExpiry) {
    return googleCertsCache;
  }
  try {
    const res = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
    if (res.ok) {
      const certs = await res.json();
      googleCertsCache = certs;
      // Cache for 1 hour
      googleCertsExpiry = now + (3600 * 1000);
      return certs;
    }
  } catch (err) {
    console.warn('[Netlify Function] Notice: Could not refresh Google public certs:', err.message);
  }
  return googleCertsCache || {};
}

// In-memory cached database
let cachedTests = null;
let cachedTestsTimestamp = 0;
let hasLoggedMissingDataWarning = false;

function parseTestsPayload(raw) {
  if (!raw) return null;
  let text = '';
  if (Buffer.isBuffer(raw)) {
    // Check gzip magic bytes (0x1f 0x8b)
    if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
      try {
        text = zlib.gunzipSync(raw).toString('utf8');
      } catch {
        text = raw.toString('utf8');
      }
    } else {
      text = raw.toString('utf8');
    }
  } else if (typeof raw === 'string') {
    text = raw.trim();
  }
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {}
  return null;
}

function getLocalTests() {
  return getAllTests();
}

// Cryptographic Firebase ID Token Verifier
async function verifyUser(authHeader, projectId) {
  const token = authHeader?.match(/^Bearer (.+)$/i)?.[1]?.trim();

  if (!token) {
    return { ok: false, status: 401, error: 'Sign in to continue.' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, status: 401, error: 'Malformed authentication token.' };
  }

  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, status: 401, error: 'Invalid token structure.' };
  }

  // 1. Algorithm check: Firebase ID tokens MUST use RS256
  if (header.alg !== 'RS256') {
    return { ok: false, status: 401, error: 'Invalid token algorithm. Expected RS256.' };
  }

  // 2. Key ID check: Must contain kid corresponding to Google's public x509 certs
  if (!header.kid || typeof header.kid !== 'string') {
    return { ok: false, status: 401, error: 'Token missing key identifier (kid).' };
  }

  const now = Math.floor(Date.now() / 1000);

  // 3. Expiration check (with 60-second clock skew tolerance)
  if (!payload.exp || typeof payload.exp !== 'number' || payload.exp < (now - 60)) {
    return { ok: false, status: 401, error: 'Your session expired. Please sign in again.' };
  }

  // 4. Issued-at check (iat must be in the past, with 60-second clock skew tolerance)
  if (payload.iat && typeof payload.iat === 'number' && payload.iat > (now + 60)) {
    return { ok: false, status: 401, error: 'Token issued in the future.' };
  }

  // 5. Auth-time check (auth_time must be in the past, with 60-second clock skew tolerance)
  if (payload.auth_time && typeof payload.auth_time === 'number' && payload.auth_time > (now + 60)) {
    return { ok: false, status: 401, error: 'Authentication timestamp is in the future.' };
  }

  // 6. Audience & Issuer validation
  if (projectId) {
    if (payload.aud && payload.aud !== projectId) {
      return { ok: false, status: 401, error: 'Token audience does not match project.' };
    }
    const expectedIss = `https://securetoken.google.com/${projectId}`;
    if (payload.iss && payload.iss !== expectedIss) {
      return { ok: false, status: 401, error: 'Token issuer does not match project.' };
    }
  }

  // 7. Cryptographic signature check against Google public x509 certs
  let certs = await getGooglePublicCerts();
  let cert = certs[header.kid];
  if (!cert) {
    // If kid not found in cache, force refresh from Google in case keys rotated
    certs = await getGooglePublicCerts(true);
    cert = certs[header.kid];
  }

  // Allow injected certificate in test runner environment (for automated verification)
  if (!cert && process.env.NODE_ENV === 'test' && process.env.FLIQ_TEST_PUBLIC_CERT_KID === header.kid) {
    cert = process.env.FLIQ_TEST_PUBLIC_CERT;
  }

  if (!cert) {
    return { ok: false, status: 401, error: 'Token signed with unknown key.' };
  }

  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    const signatureValid = verifier.verify(cert, Buffer.from(parts[2], 'base64url'));
    if (!signatureValid) {
      return { ok: false, status: 401, error: 'Token signature verification failed.' };
    }
  } catch (sigErr) {
    return { ok: false, status: 401, error: `Token signature check error: ${sigErr.message}` };
  }

  // 8. Subject / UID extraction: UID is obtained EXCLUSIVELY from the verified token
  const uid = String(payload.user_id || payload.sub || '').trim();
  if (!uid) {
    return { ok: false, status: 401, error: 'No user ID present in verified token.' };
  }

  return {
    ok: true,
    user: {
      uid,
      email: payload.email || '',
      displayName: payload.name || payload.displayName || '',
      isAnonymous: Boolean(payload.firebase?.sign_in_provider === 'anonymous')
    }
  };
}

// Core business logic handler for all API requests
async function processApiRequest({ method, pathname, headers, body }) {
  const defaultHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };

  if (method === 'OPTIONS') {
    return { status: 204, headers: defaultHeaders, body: '' };
  }

  const projectId = process.env.FIREBASE_PROJECT_ID?.trim() || process.env.GCLOUD_PROJECT?.trim() || '';
  const apiKey = process.env.FIREBASE_WEB_API_KEY?.trim() || process.env.FIREBASE_API_KEY?.trim() || '';
  const authDomain = process.env.FIREBASE_AUTH_DOMAIN?.trim() || (projectId ? `${projectId}.firebaseapp.com` : '');
  const messagingSenderId = process.env.FIREBASE_MESSAGING_SENDER_ID?.trim() || '';
  const appId = process.env.FIREBASE_APP_ID?.trim() || '';
  const authHeader = headers?.authorization || headers?.Authorization || '';

  console.log(`[Netlify Function] ${method} ${pathname}`);

  // 1. Health check
  if ((pathname === '/api/health' || pathname === '/health') && method === 'GET') {
    const allTests = getLocalTests();
    return {
      status: 200,
      headers: defaultHeaders,
      body: JSON.stringify({
        ok: true,
        serverless: true,
        playwrightConfigured: false,
        firebaseConfigured: Boolean(apiKey && projectId),
        firebaseWebConfigured: Boolean(apiKey && projectId),
        firebaseAdminConfigured: false,
        authMode: 'firebase-crypto',
        databaseLoaded: allTests.length > 0,
        databaseCount: allTests.length,
        databaseStatus: allTests.length > 0 ? 'ready' : 'unseeded',
        databaseDiagnostic: allTests.length === 0
          ? 'No test records found. Configure FLIQ_TESTS_URL in Netlify site settings to download reports during build.'
          : null,
        notice: 'FLIQ is active in Netlify serverless mode. Test history, reports, and analytics are available.'
      })
    };
  }

  // 2. Firebase client configuration
  if ((pathname === '/api/firebase-config' || pathname === '/firebase-config') && method === 'GET') {
    return {
      status: 200,
      headers: defaultHeaders,
      body: JSON.stringify({
        configured: Boolean(apiKey && projectId),
        missing: [
          ...(apiKey ? [] : ['FIREBASE_WEB_API_KEY']),
          ...(projectId ? [] : ['FIREBASE_PROJECT_ID'])
        ],
        config: {
          apiKey,
          authDomain,
          projectId,
          messagingSenderId,
          appId
        }
      })
    };
  }

  // 3. User profile
  if (pathname === '/api/profile' || pathname === '/profile') {
    const authResult = await verifyUser(authHeader, projectId);
    if (!authResult.ok) {
      return { status: authResult.status, headers: defaultHeaders, body: JSON.stringify({ error: authResult.error }) };
    }
    const user = authResult.user;
    if (method === 'POST') {
      try {
        const bodyObj = body ? JSON.parse(body) : {};
        return {
          status: 200,
          headers: defaultHeaders,
          body: JSON.stringify({
            uid: user.uid,
            email: user.email,
            displayName: bodyObj.displayName || user.displayName,
            preferences: bodyObj.preferences || {}
          })
        };
      } catch {
        return { status: 400, headers: defaultHeaders, body: JSON.stringify({ error: 'Invalid profile data.' }) };
      }
    }
    return {
      status: 200,
      headers: defaultHeaders,
      body: JSON.stringify({
        uid: user.uid,
        email: user.email,
        displayName: user.displayName
      })
    };
  }

  // 4. Test list: Returns tests owned by or explicitly shared with the authenticated user
  if ((pathname === '/api/tests' || pathname === '/tests') && method === 'GET') {
    const authResult = await verifyUser(authHeader, projectId);
    if (!authResult.ok) {
      return { status: authResult.status, headers: defaultHeaders, body: JSON.stringify({ error: authResult.error }) };
    }
    const user = authResult.user;
    const allTests = getLocalTests();

    if (allTests.length === 0) {
      console.warn('[Netlify Function Warning] /api/tests returned empty: local database contains 0 records.');
    }

    // Data isolation: user ONLY sees their own tests or tests shared with them
    const userTests = allTests.filter(t => isUserAuthorizedForRecord(t, user.uid));

    // Sort newest first
    userTests.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

    // Strip internal sensitive owner information
    const safeTests = userTests.map(({ owner, sharedWithUids, ...safe }) => safe);

    return {
      status: 200,
      headers: {
        ...defaultHeaders,
        'X-FLIQ-Database-Count': String(allTests.length)
      },
      body: JSON.stringify(safeTests)
    };
  }

  // 5. Test creation (Run Test)
  if ((pathname === '/api/tests' || pathname === '/tests') && method === 'POST') {
    const authResult = await verifyUser(authHeader, projectId);
    if (!authResult.ok) {
      return { status: authResult.status, headers: defaultHeaders, body: JSON.stringify({ error: authResult.error }) };
    }
    const user = authResult.user;

    const backendUrl = process.env.FLIQ_BACKEND_URL?.trim();
    if (backendUrl) {
      try {
        const targetApi = backendUrl.replace(/\/+$/, '') + '/api/tests';
        const proxyRes = await fetch(targetApi, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'authorization': authHeader
          },
          body: body
        });
        const proxyData = await proxyRes.text();
        return {
          status: proxyRes.status,
          headers: defaultHeaders,
          body: proxyData
        };
      } catch (proxyErr) {
        console.error('[Netlify Function Error] Backend proxy failure:', proxyErr.message);
        return {
          status: 502,
          headers: defaultHeaders,
          body: JSON.stringify({ error: `Backend proxy error: ${proxyErr.message}` })
        };
      }
    }

    let bodyObj = {};
    try {
      bodyObj = body ? JSON.parse(body) : {};
    } catch {
      return { status: 400, headers: defaultHeaders, body: JSON.stringify({ error: 'Invalid JSON request body.' }) };
    }

    const rawUrl = bodyObj.url?.trim();
    if (!rawUrl) {
      return { status: 400, headers: defaultHeaders, body: JSON.stringify({ error: 'Please enter a website URL.' }) };
    }

    let validated;
    try {
      validated = await validateTarget(rawUrl);
    } catch (valErr) {
      return { status: 400, headers: defaultHeaders, body: JSON.stringify({ error: valErr.message }) };
    }

    // Check active scan concurrency limit
    const allTests = getAllTests();
    const activeScans = allTests.filter(t => t.owner === user.uid && (t.status === 'running' || t.status === 'queued'));
    const maxActive = Number(process.env.FLIQ_MAX_ACTIVE_TESTS || 1);
    if (activeScans.length >= maxActive) {
      return {
        status: 429,
        headers: defaultHeaders,
        body: JSON.stringify({ error: 'You already have an active test running. Please wait for it to complete.' })
      };
    }

    // Create unique test job linked to authenticated UID
    const testId = crypto.randomUUID();
    const newJob = {
      id: testId,
      url: validated.url,
      hostname: validated.hostname,
      owner: user.uid,
      sharedWithUids: [],
      status: 'queued',
      stage: 'Queued',
      progress: 5,
      createdAt: new Date().toISOString()
    };

    saveTestRecord(newJob);

    // Trigger background execution:
    // Netlify Background Functions run asynchronously in an isolated 15-minute worker.
    const host = headers?.['x-forwarded-host'] || headers?.host || headers?.Host || '';
    const proto = headers?.['x-forwarded-proto'] || 'https';
    const siteUrl = host ? `${proto}://${host}` : (process.env.URL || '');

    let dispatchedToBackground = false;
    if (siteUrl && !siteUrl.includes('localhost') && !siteUrl.includes('127.0.0.1')) {
      try {
        const bgEndpoint = `${siteUrl}/.netlify/functions/scan-background`;
        const callbackUrl = `${siteUrl}/api/internal/test-update`;
        const bgRes = await fetch(bgEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            testId: newJob.id,
            url: newJob.url,
            owner: user.uid,
            callbackUrl
          }),
          signal: AbortSignal.timeout(4000)
        });
        if (bgRes.status === 202 || bgRes.ok) {
          dispatchedToBackground = true;
          console.log(`[api.mjs] Dispatched test ${newJob.id} to Netlify Background Function.`);
        }
      } catch (bgErr) {
        console.warn('[api.mjs] Background dispatch notice:', bgErr.message);
      }
    }

    // In local testing or environments where Netlify Background Functions are not present:
    if (!dispatchedToBackground && (process.env.NODE_ENV === 'test' || !siteUrl || siteUrl.includes('localhost'))) {
      await runAuditScan(newJob);
    }

    return {
      status: 202,
      headers: defaultHeaders,
      body: JSON.stringify(newJob)
    };
  }

  // 6. Internal update endpoint called by scan-background to sync progress & results
  if ((pathname === '/api/internal/test-update' || pathname === '/internal/test-update') && method === 'POST') {
    try {
      const secret = headers?.['x-fliq-internal-secret'] || headers?.['X-FLIQ-INTERNAL-SECRET'] || '';
      const expected = process.env.FLIQ_INTERNAL_SECRET || 'fliq-internal-secret-2026';
      if (secret !== expected) {
        return { status: 403, headers: defaultHeaders, body: JSON.stringify({ error: 'Unauthorized internal call.' }) };
      }
      const payload = typeof body === 'string' ? JSON.parse(body) : (body || {});
      const { testId, fields } = payload;
      if (testId && fields) {
        updateTestRecord(testId, fields);
        return { status: 200, headers: defaultHeaders, body: JSON.stringify({ ok: true }) };
      }
      return { status: 400, headers: defaultHeaders, body: JSON.stringify({ error: 'Missing testId or fields.' }) };
    } catch (e) {
      return { status: 500, headers: defaultHeaders, body: JSON.stringify({ error: e.message }) };
    }
  }

  // 7. Live screenshot endpoint for in-progress tests
  const liveScreenshotMatch = pathname.match(/^(?:\/api)?\/tests\/([\w-]+)\/live-screenshot$/);
  if (liveScreenshotMatch && method === 'GET') {
    return {
      status: 404,
      headers: defaultHeaders,
      body: JSON.stringify({ error: 'Live screenshot unavailable in serverless mode.' })
    };
  }

  // 6. Single test report
  const singleTestMatch = pathname.match(/^(?:\/api)?\/tests\/([\w-]+)$/);
  if (singleTestMatch && method === 'GET') {
    const authResult = await verifyUser(authHeader, projectId);
    if (!authResult.ok) {
      return { status: authResult.status, headers: defaultHeaders, body: JSON.stringify({ error: authResult.error }) };
    }
    const user = authResult.user;
    const testId = singleTestMatch[1];
    const test = getTestById(testId) || getAllTests().find(t => t.id === testId);

    if (!test) {
      const allTests = getAllTests();
      if (allTests.length === 0) {
        console.error(`[Netlify Function Diagnostic Error] Test ${testId} not found: serverless database is unseeded (0 records loaded).`);
        return {
          status: 404,
          headers: defaultHeaders,
          body: JSON.stringify({
            error: 'Test report not found. Database is unseeded in this serverless environment.',
            databaseUnseeded: true
          })
        };
      }
      return { status: 404, headers: defaultHeaders, body: JSON.stringify({ error: 'Test not found.' }) };
    }

    if (!isUserAuthorizedForRecord(test, user.uid)) {
      return {
        status: 403,
        headers: defaultHeaders,
        body: JSON.stringify({ error: 'Access denied. You do not have permission to view this report.' })
      };
    }

    const isOwner = getRecordOwnerId(test) === user.uid;
    const { owner, sharedWithUids, ...safe } = test;
    return {
      status: 200,
      headers: defaultHeaders,
      body: JSON.stringify({ ...safe, canManageSharing: isOwner })
    };
  }

  // 7. Screenshots
  const screenshotMatch = pathname.match(/^(?:\/api)?\/screenshots\/([\w-]+\.png)$/);
  if (screenshotMatch && method === 'GET') {
    const authResult = await verifyUser(authHeader, projectId);
    if (!authResult.ok) {
      return { status: authResult.status, headers: defaultHeaders, body: JSON.stringify({ error: authResult.error }) };
    }
    const user = authResult.user;
    const filename = screenshotMatch[1];
    const safeName = path.basename(filename);
    const testId = safeName.replace(/-(desktop|tablet|mobile|live)\.png$/i, '');
    const allTests = getLocalTests();
    const test = allTests.find(t => t.id === testId);

    if (!test) {
      return { status: 404, headers: defaultHeaders, body: JSON.stringify({ error: 'Screenshot not found.' }) };
    }

    if (!isUserAuthorizedForRecord(test, user.uid)) {
      return {
        status: 403,
        headers: defaultHeaders,
        body: JSON.stringify({ error: 'Access denied. You do not have permission to view this screenshot.' })
      };
    }

    const buffer = getScreenshotBuffer(safeName);
    if (!buffer) {
      return { status: 404, headers: defaultHeaders, body: JSON.stringify({ error: 'Screenshot image file not found.' }) };
    }

    return {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'private, no-cache, no-store, must-revalidate'
      },
      isBase64Encoded: true,
      body: buffer.toString('base64')
    };
  }

  // 8. Regenerate AI explanation
  const regenMatch = pathname.match(/^(?:\/api)?\/tests\/([\w-]+)\/regenerate-ai$/);
  if (regenMatch && method === 'POST') {
    const authResult = await verifyUser(authHeader, projectId);
    if (!authResult.ok) {
      return { status: authResult.status, headers: defaultHeaders, body: JSON.stringify({ error: authResult.error }) };
    }
    const user = authResult.user;
    const testId = regenMatch[1];
    const allTests = getLocalTests();
    const test = allTests.find(t => t.id === testId);

    if (!test) {
      return { status: 404, headers: defaultHeaders, body: JSON.stringify({ error: 'Test not found.' }) };
    }

    if (!isUserAuthorizedForRecord(test, user.uid)) {
      return {
        status: 403,
        headers: defaultHeaders,
        body: JSON.stringify({ error: 'Access denied. You do not have permission to regenerate AI analysis for this report.' })
      };
    }

    return {
      status: 200,
      headers: defaultHeaders,
      body: JSON.stringify({
        success: true,
        aiSummary: test.aiSummary || 'Quality audit analysis complete.',
        issues: test.issues || [],
        isAiGenerated: false
      })
    };
  }

  // Unknown route
  return {
    status: 404,
    headers: defaultHeaders,
    body: JSON.stringify({ error: `Endpoint not found: ${method} ${pathname}` })
  };
}

function extractPathFromLambdaEvent(event) {
  let raw = event.path || '';
  if (raw === '/.netlify/functions/api' || raw === '/.netlify/functions/api/') {
    const originalHeader = event.headers?.['x-nf-original-path'] || event.headers?.['x-forwarded-uri'];
    if (originalHeader) {
      raw = originalHeader;
    } else if (event.rawUrl) {
      try {
        raw = new URL(event.rawUrl).pathname;
      } catch {}
    }
  }
  if (raw.startsWith('/.netlify/functions/api')) {
    raw = raw.slice('/.netlify/functions/api'.length) || '/';
  }
  if (!raw.startsWith('/api')) {
    raw = '/api' + (raw.startsWith('/') ? raw : '/' + raw);
  }
  return raw.split('?')[0].replace(/\/+$/, '') || '/api';
}

// Netlify Functions Handler (AWS Lambda format for seamless integration with netlify.toml redirects)
export const handler = async (event, context) => {
  // If invoked with a standard Request object (e.g. in test environments or hybrid runtimes)
  if (typeof Request !== 'undefined' && event instanceof Request) {
    try {
      const url = new URL(event.url);
      const pathname = url.pathname.replace(/\/+$/, '') || '/api';
      const method = event.method || 'GET';
      const headers = Object.fromEntries(event.headers.entries());
      const body = (method !== 'GET' && method !== 'HEAD') ? await event.text() : '';
      const res = await processApiRequest({ method, pathname, headers, body });
      if (res.isBase64Encoded) {
        return new Response(Buffer.from(res.body, 'base64'), { status: res.status, headers: res.headers });
      }
      return new Response(res.body, { status: res.status, headers: res.headers });
    } catch (err) {
      console.error('[Netlify Function Crash]:', err.message);
      return new Response(JSON.stringify({ error: 'Internal server error in Netlify function.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // Standard Netlify / AWS Lambda event
  try {
    const method = event.httpMethod || 'GET';
    const pathname = extractPathFromLambdaEvent(event);
    const headers = event.headers || {};
    const body = event.body || '';

    const res = await processApiRequest({ method, pathname, headers, body });

    return {
      statusCode: res.status,
      headers: res.headers,
      body: res.body,
      isBase64Encoded: Boolean(res.isBase64Encoded)
    };
  } catch (handlerErr) {
    console.error('[Netlify Function Crash]:', handlerErr.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error in Netlify function.' })
    };
  }
};
