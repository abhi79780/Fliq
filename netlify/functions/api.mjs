import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

function getLocalTests() {
  const now = Date.now();
  if (cachedTests && (now - cachedTestsTimestamp < 30000)) {
    return cachedTests;
  }

  // 1. Check environment variable if small seed data or test environment configured
  if (process.env.FLIQ_SEED_TESTS_JSON) {
    try {
      const parsed = JSON.parse(process.env.FLIQ_SEED_TESTS_JSON);
      if (Array.isArray(parsed) && parsed.length > 0) {
        cachedTests = parsed;
        cachedTestsTimestamp = now;
        return parsed;
      }
    } catch (e) {
      console.warn('[Netlify Function] Notice: Could not parse FLIQ_SEED_TESTS_JSON:', e.message);
    }
  }
  if (process.env.FLIQ_SEED_TESTS_BASE64) {
    try {
      const raw = Buffer.from(process.env.FLIQ_SEED_TESTS_BASE64, 'base64').toString('utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        cachedTests = parsed;
        cachedTestsTimestamp = now;
        return parsed;
      }
    } catch (e) {
      console.warn('[Netlify Function] Notice: Could not parse FLIQ_SEED_TESTS_BASE64:', e.message);
    }
  }

  // 2. Candidate filesystem locations (for local dev, tests, or builds that include data files)
  const candidatePaths = [
    path.join(__dirname, 'tests.json'),
    path.join(__dirname, 'data', 'tests.json'),
    path.join(__dirname, '..', '..', 'data', 'tests.json'),
    path.join(process.cwd(), 'data', 'tests.json'),
    path.join(process.cwd(), 'netlify', 'functions', 'tests.json'),
    path.join(process.cwd(), 'tests.json'),
    path.join(process.env.LAMBDA_TASK_ROOT || '/var/task', 'data', 'tests.json'),
    path.join(process.env.LAMBDA_TASK_ROOT || '/var/task', 'netlify', 'functions', 'tests.json')
  ];

  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          cachedTests = parsed;
          cachedTestsTimestamp = now;
          return parsed;
        }
      }
    } catch (e) {
      console.warn('[Netlify Function] Notice reading tests.json at', p, e.message);
    }
  }
  return cachedTests || [];
}

// Helper to locate screenshot files securely on disk
function getScreenshotBuffer(filename) {
  const safeName = path.basename(filename);

  // Check private base64 environment variable if provided
  const envKey = 'FLIQ_SCREENSHOT_' + safeName.replace(/[^a-zA-Z0-9]/g, '_');
  if (process.env[envKey]) {
    try {
      return Buffer.from(process.env[envKey], 'base64');
    } catch {}
  }

  const candidatePaths = [
    path.join(__dirname, 'data', safeName),
    path.join(__dirname, '..', '..', 'data', safeName),
    path.join(process.cwd(), 'data', safeName),
    path.join(process.env.LAMBDA_TASK_ROOT || '/var/task', 'data', safeName),
    path.join(process.env.LAMBDA_TASK_ROOT || '/var/task', 'netlify', 'functions', 'data', safeName)
  ];

  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        return fs.readFileSync(p);
      }
    } catch {}
  }
  return null;
}

// Extract canonical owner ID from test record
function getRecordOwnerId(record) {
  if (!record || typeof record !== 'object') return null;
  // Canonical schema uses 'owner' (e.g. '3nNFGpqjoIcrTSKib4proR5lU1g1')
  // Fallbacks support schema variations ('userId' or 'uid')
  const val = record.owner || record.userId || record.uid;
  return typeof val === 'string' && val.trim() ? val.trim() : null;
}

// Strict ownership & authorization verification
function isUserAuthorizedForRecord(record, userUid) {
  if (!record || !userUid) return false;
  const ownerId = getRecordOwnerId(record);
  if (ownerId && ownerId === userUid) {
    return true;
  }
  // Check shared access explicitly authorized in sharedWithUids array
  if (Array.isArray(record.sharedWithUids) && record.sharedWithUids.includes(userUid)) {
    return true;
  }
  return false;
}

// Extract normalized route pathname from Netlify event
function extractPathname(event) {
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

// Cryptographic Firebase ID Token Verifier
async function verifyUser(event, projectId) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
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
    if (payload.aud !== projectId) {
      return { ok: false, status: 401, error: 'Token audience does not match project.' };
    }
    const expectedIss = `https://securetoken.google.com/${projectId}`;
    if (payload.iss !== expectedIss) {
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

export const handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    const pathname = extractPathname(event);
    const projectId = process.env.FIREBASE_PROJECT_ID?.trim() || process.env.GCLOUD_PROJECT?.trim() || '';
    const apiKey = process.env.FIREBASE_WEB_API_KEY?.trim() || process.env.FIREBASE_API_KEY?.trim() || '';
    const authDomain = process.env.FIREBASE_AUTH_DOMAIN?.trim() || (projectId ? `${projectId}.firebaseapp.com` : '');
    const messagingSenderId = process.env.FIREBASE_MESSAGING_SENDER_ID?.trim() || '';
    const appId = process.env.FIREBASE_APP_ID?.trim() || '';

    // Server-side audit log without token or credential leakage
    console.log(`[Netlify Function] ${event.httpMethod} ${pathname}`);

    // 1. Health check
    if ((pathname === '/api/health' || pathname === '/health') && event.httpMethod === 'GET') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          serverless: true,
          playwrightConfigured: false,
          firebaseConfigured: Boolean(apiKey && projectId),
          firebaseWebConfigured: Boolean(apiKey && projectId),
          firebaseAdminConfigured: false,
          authMode: 'firebase-crypto',
          notice: 'FLIQ is active in Netlify serverless mode. Test history, reports, and analytics are fully available. Playwright automated scans require a background browser crawler.'
        })
      };
    }

    // 2. Firebase client configuration
    if ((pathname === '/api/firebase-config' || pathname === '/firebase-config') && event.httpMethod === 'GET') {
      return {
        statusCode: 200,
        headers,
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
      const authResult = await verifyUser(event, projectId);
      if (!authResult.ok) {
        return { statusCode: authResult.status, headers, body: JSON.stringify({ error: authResult.error }) };
      }
      const user = authResult.user;
      if (event.httpMethod === 'POST') {
        try {
          const body = event.body ? JSON.parse(event.body) : {};
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              uid: user.uid,
              email: user.email,
              displayName: body.displayName || user.displayName,
              preferences: body.preferences || {}
            })
          };
        } catch {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid profile data.' }) };
        }
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          uid: user.uid,
          email: user.email,
          displayName: user.displayName
        })
      };
    }

    // 4. Test list: Returns tests owned by or explicitly shared with the authenticated user
    if ((pathname === '/api/tests' || pathname === '/tests') && event.httpMethod === 'GET') {
      const authResult = await verifyUser(event, projectId);
      if (!authResult.ok) {
        return { statusCode: authResult.status, headers, body: JSON.stringify({ error: authResult.error }) };
      }
      const user = authResult.user;
      const allTests = getLocalTests();

      // Data isolation: user ONLY sees their own tests or tests shared with them
      const userTests = allTests.filter(t => isUserAuthorizedForRecord(t, user.uid));

      // Sort newest first
      userTests.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

      // Strip internal sensitive owner information
      const safeTests = userTests.map(({ owner, sharedWithUids, ...safe }) => safe);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(safeTests)
      };
    }

    // 5. Test creation (Run Test)
    if ((pathname === '/api/tests' || pathname === '/tests') && event.httpMethod === 'POST') {
      const authResult = await verifyUser(event, projectId);
      if (!authResult.ok) {
        return { statusCode: authResult.status, headers, body: JSON.stringify({ error: authResult.error }) };
      }

      // Check if an external persistent backend URL is configured to proxy scans
      const backendUrl = process.env.FLIQ_BACKEND_URL?.trim();
      if (backendUrl) {
        try {
          const targetApi = backendUrl.replace(/\/+$/, '') + '/api/tests';
          const proxyRes = await fetch(targetApi, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'authorization': event.headers.authorization || event.headers.Authorization || ''
            },
            body: event.body
          });
          const proxyData = await proxyRes.text();
          return {
            statusCode: proxyRes.status,
            headers,
            body: proxyData
          };
        } catch (proxyErr) {
          console.error('[Netlify Function Error] Backend proxy failure:', proxyErr.message);
          return {
            statusCode: 502,
            headers,
            body: JSON.stringify({ error: `Backend proxy error: ${proxyErr.message}` })
          };
        }
      }

      // Serverless limitation: Playwright Chromium browser scans cannot run in Netlify Functions
      return {
        statusCode: 503,
        headers,
        body: JSON.stringify({
          error: 'Playwright browser crawlers require a background crawler runtime with headless Chromium and cannot execute within serverless Netlify Functions (10-26s timeout). All existing reports and test history are fully available.'
        })
      };
    }

    // 6. Single test report: Requires cryptographic authentication and strict ownership verification
    const singleTestMatch = pathname.match(/^(?:\/api)?\/tests\/([\w-]+)$/);
    if (singleTestMatch && event.httpMethod === 'GET') {
      const authResult = await verifyUser(event, projectId);
      if (!authResult.ok) {
        return { statusCode: authResult.status, headers, body: JSON.stringify({ error: authResult.error }) };
      }
      const user = authResult.user;
      const testId = singleTestMatch[1];
      const allTests = getLocalTests();
      const test = allTests.find(t => t.id === testId);

      if (!test) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Test not found.' }) };
      }

      // 403 Forbidden for unauthorized access
      if (!isUserAuthorizedForRecord(test, user.uid)) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Access denied. You do not have permission to view this report.' })
        };
      }

      const isOwner = getRecordOwnerId(test) === user.uid;
      const { owner, sharedWithUids, ...safe } = test;
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ...safe, canManageSharing: isOwner })
      };
    }

    // 7. Screenshots: Private, authenticated, and protected by test ownership verification
    const screenshotMatch = pathname.match(/^(?:\/api)?\/screenshots\/([\w-]+\.png)$/);
    if (screenshotMatch && event.httpMethod === 'GET') {
      const authResult = await verifyUser(event, projectId);
      if (!authResult.ok) {
        return { statusCode: authResult.status, headers, body: JSON.stringify({ error: authResult.error }) };
      }
      const user = authResult.user;
      const filename = screenshotMatch[1];
      const safeName = path.basename(filename);
      const testId = safeName.replace(/-(desktop|tablet|mobile|live)\.png$/i, '');
      const allTests = getLocalTests();
      const test = allTests.find(t => t.id === testId);

      if (!test) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Screenshot not found.' }) };
      }

      // 403 Forbidden for unauthorized screenshot access
      if (!isUserAuthorizedForRecord(test, user.uid)) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Access denied. You do not have permission to view this screenshot.' })
        };
      }

      const buffer = getScreenshotBuffer(safeName);
      if (!buffer) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Screenshot image file not found.' }) };
      }

      return {
        statusCode: 200,
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
    if (regenMatch && event.httpMethod === 'POST') {
      const authResult = await verifyUser(event, projectId);
      if (!authResult.ok) {
        return { statusCode: authResult.status, headers, body: JSON.stringify({ error: authResult.error }) };
      }
      const user = authResult.user;
      const testId = regenMatch[1];
      const allTests = getLocalTests();
      const test = allTests.find(t => t.id === testId);

      if (!test) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Test not found.' }) };
      }

      if (!isUserAuthorizedForRecord(test, user.uid)) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Access denied. You do not have permission to regenerate AI analysis for this report.' })
        };
      }

      return {
        statusCode: 200,
        headers,
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
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: `Endpoint not found: ${event.httpMethod} ${pathname}` })
    };
  } catch (handlerErr) {
    console.error('[Netlify Function Crash]:', { message: handlerErr.message });
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error in Netlify function.' })
    };
  }
};
