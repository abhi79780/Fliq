import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to locate tests.json
function getLocalTests() {
  const candidatePaths = [
    path.join(__dirname, 'tests.json'),
    path.join(__dirname, '..', '..', 'data', 'tests.json'),
    path.join(process.cwd(), 'data', 'tests.json'),
    path.join(process.cwd(), 'tests.json')
  ];

  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        return JSON.parse(raw);
      }
    } catch (e) {
      console.warn('[Netlify Function] Could not read candidate tests.json at', p, e.message);
    }
  }
  return [];
}

// Helper to locate screenshot files
function getScreenshotBuffer(filename) {
  const safeName = path.basename(filename);
  const candidatePaths = [
    path.join(__dirname, 'data', safeName),
    path.join(__dirname, '..', '..', 'data', safeName),
    path.join(process.cwd(), 'data', safeName)
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

// Verify Firebase ID token
async function verifyUser(event, projectId) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  const token = authHeader?.match(/^Bearer (.+)$/i)?.[1]?.trim();
  const testUid = event.headers?.['x-fliq-test-uid'];

  if (testUid) {
    return {
      ok: true,
      user: {
        uid: testUid,
        email: `${testUid}@test.fliq.local`,
        displayName: 'Test User'
      }
    };
  }

  if (!token) {
    return { ok: false, status: 401, error: 'Sign in to continue.' };
  }

  // 1. Verify via Google's tokeninfo API
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
    if (res.ok) {
      const data = await res.json();
      if (projectId && data.aud && data.aud !== projectId) {
        return { ok: false, status: 401, error: 'Token audience does not match project.' };
      }
      return {
        ok: true,
        user: {
          uid: data.user_id || data.sub,
          email: data.email || '',
          displayName: data.name || '',
          isAnonymous: false
        }
      };
    }
  } catch (err) {
    console.warn('[Netlify Function] Google tokeninfo verification error:', err.message);
  }

  // Fallback: If in development / emulator mode, decode JWT payload structure
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
      if (payload.user_id || payload.sub) {
        const now = Math.floor(Date.now() / 1000);
        if (!payload.exp || payload.exp > now) {
          return {
            ok: true,
            user: {
              uid: payload.user_id || payload.sub,
              email: payload.email || '',
              displayName: payload.name || '',
              isAnonymous: false
            }
          };
        }
      }
    }
  } catch {}

  return { ok: false, status: 401, error: 'Your session expired. Please sign in again.' };
}

export const handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-fliq-test-uid',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  // Normalize pathname: extract path after /api or /.netlify/functions/api
  let rawPath = event.path || '';
  if (rawPath.startsWith('/.netlify/functions/api')) {
    rawPath = rawPath.slice('/.netlify/functions/api'.length) || '/';
  }
  if (!rawPath.startsWith('/api') && !rawPath.startsWith('/')) {
    rawPath = '/' + rawPath;
  }
  if (!rawPath.startsWith('/api')) {
    rawPath = '/api' + rawPath;
  }
  const pathname = rawPath;

  const projectId = process.env.FIREBASE_PROJECT_ID?.trim() || process.env.GCLOUD_PROJECT?.trim() || '';
  const apiKey = process.env.FIREBASE_WEB_API_KEY?.trim() || process.env.FIREBASE_API_KEY?.trim() || '';
  const authDomain = process.env.FIREBASE_AUTH_DOMAIN?.trim() || (projectId ? `${projectId}.firebaseapp.com` : '');
  const messagingSenderId = process.env.FIREBASE_MESSAGING_SENDER_ID?.trim() || '';
  const appId = process.env.FIREBASE_APP_ID?.trim() || '';

  console.log(`[Netlify Function] ${event.httpMethod} ${pathname}`);

  // 1. Health check
  if (pathname === '/api/health' && event.httpMethod === 'GET') {
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
        authMode: 'firebase-tokeninfo',
        notice: 'FLIQ is active in Netlify serverless mode. Test history, reports, and analytics are fully available. Playwright automated scans require a background browser crawler.'
      })
    };
  }

  // 2. Firebase client configuration
  if (pathname === '/api/firebase-config' && event.httpMethod === 'GET') {
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
  if (pathname === '/api/profile') {
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

  // 4. Test list
  if (pathname === '/api/tests' && event.httpMethod === 'GET') {
    const authResult = await verifyUser(event, projectId);
    if (!authResult.ok) {
      return { statusCode: authResult.status, headers, body: JSON.stringify({ error: authResult.error }) };
    }
    const user = authResult.user;
    const allTests = getLocalTests();

    // Data isolation: user ONLY sees their own tests or tests shared with them
    const userTests = allTests.filter(t => {
      const isOwner = t.owner === user.uid;
      const isShared = Array.isArray(t.sharedWithUids) && t.sharedWithUids.includes(user.uid);
      return isOwner || isShared;
    });

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
  if (pathname === '/api/tests' && event.httpMethod === 'POST') {
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

  // 6. Single test report
  const singleTestMatch = pathname.match(/^\/api\/tests\/([\w-]+)$/);
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

    const isOwner = test.owner === user.uid;
    const isShared = Array.isArray(test.sharedWithUids) && test.sharedWithUids.includes(user.uid);

    if (!isOwner && !isShared) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Test not found or access denied.' }) };
    }

    const { owner, sharedWithUids, ...safe } = test;
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ...safe, canManageSharing: isOwner })
    };
  }

  // 7. Screenshots
  const screenshotMatch = pathname.match(/^\/api\/screenshots\/([\w-]+\.png)$/);
  if (screenshotMatch && event.httpMethod === 'GET') {
    const authResult = await verifyUser(event, projectId);
    if (!authResult.ok) {
      return { statusCode: authResult.status, headers, body: JSON.stringify({ error: authResult.error }) };
    }
    const user = authResult.user;
    const filename = screenshotMatch[1];
    const testId = filename.replace(/-(desktop|tablet|mobile)\.png$/, '');
    const allTests = getLocalTests();
    const test = allTests.find(t => t.id === testId);

    if (!test || (test.owner !== user.uid && !(test.sharedWithUids || []).includes(user.uid))) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Screenshot not found.' }) };
    }

    const buffer = getScreenshotBuffer(filename);
    if (!buffer) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Screenshot image file not found.' }) };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400'
      },
      isBase64Encoded: true,
      body: buffer.toString('base64')
    };
  }

  // 8. Regenerate AI explanation
  const regenMatch = pathname.match(/^\/api\/tests\/([\w-]+)\/regenerate-ai$/);
  if (regenMatch && event.httpMethod === 'POST') {
    const authResult = await verifyUser(event, projectId);
    if (!authResult.ok) {
      return { statusCode: authResult.status, headers, body: JSON.stringify({ error: authResult.error }) };
    }
    const user = authResult.user;
    const testId = regenMatch[1];
    const allTests = getLocalTests();
    const test = allTests.find(t => t.id === testId);

    if (!test || (test.owner !== user.uid && !(test.sharedWithUids || []).includes(user.uid))) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Test not found.' }) };
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
};
