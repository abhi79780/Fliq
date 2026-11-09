import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert, applicationDefault, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

let getFirestore = null;
let FieldValue = null;
let firestoreAvailable = false;
try {
  const fsMod = await import('firebase-admin/firestore');
  getFirestore = fsMod.getFirestore;
  FieldValue = fsMod.FieldValue;
  firestoreAvailable = true;
} catch (fsImportErr) {
  console.warn('[Firebase Admin] Notice: firebase-admin/firestore is unavailable:', fsImportErr.message);
}
import { evaluateAccessibility, auditNativeKeyboardNavigation, A11Y_CHECKS } from './lib/a11y-scanner.js';
import { evaluateSEO, SEO_CHECKS } from './lib/seo-scanner.js';
import { evaluateSecurityHeaders, evaluateDOMSecurity, SECURITY_CHECKS } from './lib/security-scanner.js';
import { extractPerformanceMetrics, PERF_CHECKS } from './lib/perf-scanner.js';
import { checkResponsiveLayout, checkDeadTriggers, inspectFormsPassive, FUNCTIONALITY_CHECKS } from './lib/functionality-scanner.js';
import { extractDiscoveredLinks, checkRobotsTxt, computeAuditCoverage } from './lib/page-discovery.js';
import { calculateCategoryScores } from './lib/audit-orchestrator.js';
import { executeAIOrFallbackReport, generateDeterministicSummary } from './lib/ai-fallback-engine.js';
import { runA11yRegressionSuite } from './lib/a11y-regression-runner.js';
import { runDemoWorkflowTests } from './lib/demo-workflow-tests.js';
import { runAuthWorkflowTests } from './lib/auth-workflow-tests.js';
import { runLogoNavigationTests } from './lib/logo-navigation-tests.js';
import { runAIResilienceTests } from './lib/ai-resilience-tests.js';
import { runLiveInspectionTests } from './lib/live-inspection-tests.js';
import { runReportConsistencyTests } from './lib/report-consistency-tests.js';
import { runPricingVerificationTests } from './lib/pricing-tests.js';
import { runPricingAuthTests } from './lib/pricing-auth-tests.js';
import { handlePolarWebhookRequest, handlePolarCheckoutRequest, createPolarCheckoutSession, resolvePolarProductId } from './lib/polar-webhook.js';

const root = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') console.error('[FLIQ] loadEnvFile warning:', error.message); }
try {
  const envContent = fsSync.readFileSync(path.join(root, '.env'), 'utf8');
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key] || process.env[key] === '') {
      process.env[key] = val;
    }
  }
} catch (e) {
  if (e.code !== 'ENOENT') console.error('[FLIQ] manual .env read warning:', e.message);
}
const dataDir = process.env.FLIQ_DATA_DIR ? path.resolve(process.env.FLIQ_DATA_DIR) : path.join(root, 'data');
await fs.mkdir(dataDir, { recursive: true });
const dbFile = path.join(dataDir, 'tests.json');
let adminApp=null;
let adminInitError=null;
const expectedProjectId = process.env.FIREBASE_PROJECT_ID?.trim();
if (!expectedProjectId) {
  adminInitError = 'FIREBASE_PROJECT_ID environment variable is missing. Configure FIREBASE_PROJECT_ID in your environment variables or .env file.';
  console.error('[Firebase Admin] Configuration Error:', adminInitError);
  console.error('[Firebase Admin] Scanning and report access will be unavailable until credentials are configured.');
} else {
  try {
    let serviceAccount=null;
    let useADC=false;

    if(process.env.FIREBASE_SERVICE_ACCOUNT_JSON){
      // Option 1: Inline JSON in environment variable
      serviceAccount=JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } else if(process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
      // Option 2: Path to a service account key file OR an ADC file
      const credentialPath=path.resolve(root,process.env.GOOGLE_APPLICATION_CREDENTIALS.trim());
      const publicRoots=[path.resolve(root,'public'),path.resolve(root,'static')];
      if(publicRoots.some(publicRoot=>credentialPath===publicRoot||credentialPath.startsWith(publicRoot+path.sep))) {
        throw new Error('Credential files must be kept outside public/static directories.');
      }
      const raw=JSON.parse(await fs.readFile(credentialPath,'utf8'));
      // service_account JSON → use cert(); authorized_user / external_account → let ADC handle it
      if(raw.type==='service_account') {
        serviceAccount=raw;
      } else {
        // ADC-compatible file (authorized_user from `gcloud auth application-default login`)
        useADC=true;
      }
    } else {
      // Option 3: No explicit credential configured – attempt Application Default Credentials.
      // This works when `gcloud auth application-default login` has been run, or when the
      // process is running on GCP (Compute Engine, Cloud Run, etc.) with an attached service account.
      useADC=true;
    }

    if(serviceAccount){
      if(serviceAccount.type!=='service_account'||!serviceAccount.project_id||!serviceAccount.client_email||!serviceAccount.private_key) throw new Error('Credential file is not a complete service-account credential.');
      if(serviceAccount.project_id!==expectedProjectId) throw new Error(`Service-account project ID (${serviceAccount.project_id}) does not match expected project ID (${expectedProjectId}).`);
      const existing=getApps().find(app=>app.name==='fliq-admin');
      if(existing&&existing.options.projectId!==expectedProjectId) throw new Error('Existing Firebase Admin app targets a different project.');
      adminApp=existing||initializeApp({projectId:expectedProjectId,credential:cert(serviceAccount)},'fliq-admin');
      console.log('Firebase Admin: initialized with service-account credential for project',expectedProjectId);
    } else if(useADC) {
      // Application Default Credentials – projectId must be explicit because ADC files do not embed it.
      const existing=getApps().find(app=>app.name==='fliq-admin');
      if(existing&&existing.options.projectId!==expectedProjectId) throw new Error('Existing Firebase Admin app targets a different project.');
      adminApp=existing||initializeApp({projectId:expectedProjectId,credential:applicationDefault()},'fliq-admin');
      // Eagerly verify the credential is usable by fetching a short-lived token.
      // This surfaces misconfigured ADC at startup rather than on the first scan request.
      try {
        await adminApp.options.credential.getAccessToken();
        console.log('Firebase Admin: initialized with Application Default Credentials for project',expectedProjectId);
      } catch(adcErr) {
        // ADC is present but not authorised – destroy the app so the server degrades gracefully.
        adminApp=null;
        const hint=`Run: gcloud auth application-default login --project=${expectedProjectId}\nThen ensure the account has the Firebase Admin SDK Service Agent role (or Owner) on the project.`;
        adminInitError=`Firebase Admin ADC failed: ${adcErr.message}\n${hint}`;
        throw new Error(adminInitError);
      }
    }
  } catch(e) {
    const msg=adminInitError||e.message||String(e);
    console.error('[Firebase Admin] Initialization failed:', msg);
    console.error('[Firebase Admin] Scanning and report access will be unavailable until credentials are configured.');
  }
}
const cloud = () => {
  if (adminApp && firestoreAvailable && getFirestore) {
    const db = getFirestore(adminApp);
    try { db.settings({ ignoreUndefinedProperties: true }); } catch {}
    return db;
  }
  return null;
};

export function sanitizeReportForPersistence(obj) {
  if (obj === undefined) return null;
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeReportForPersistence);
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      clean[k] = sanitizeReportForPersistence(v);
    }
  }
  return clean;
}

let cachedFirestoreConnected = false;
let cachedFirestoreError = null;
let lastFirestoreCheck = 0;

export async function checkFirestoreConnectivity(force = false) {
  const db = cloud();
  if (!db) {
    return { connected: false, error: 'Firestore unconfigured or credentials missing' };
  }
  const now = Date.now();
  if (!force && (now - lastFirestoreCheck < 30000)) {
    return { connected: cachedFirestoreConnected, error: cachedFirestoreError };
  }
  lastFirestoreCheck = now;
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Firestore connectivity check timed out (3s)')), 3000)
    );
    const probePromise = db.collection('_health_probe').limit(1).get();
    await Promise.race([probePromise, timeoutPromise]);
    cachedFirestoreConnected = true;
    cachedFirestoreError = null;
    return { connected: true, error: null };
  } catch (err) {
    cachedFirestoreConnected = false;
    cachedFirestoreError = err.message || String(err);
    return { connected: false, error: cachedFirestoreError };
  }
}
const getWebApiKey = () => process.env.FIREBASE_WEB_API_KEY?.trim() || process.env.FIREBASE_API_KEY?.trim() || '';
const getFirebaseWebConfig = () => {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim() || '';
  return {
    apiKey: getWebApiKey(),
    authDomain: process.env.FIREBASE_AUTH_DOMAIN?.trim() || (projectId ? `${projectId}.firebaseapp.com` : ''),
    projectId,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID?.trim() || '',
    appId: process.env.FIREBASE_APP_ID?.trim() || ''
  };
};
const getMissingFirebaseWebFields = () => {
  const missing = [];
  if (!getWebApiKey()) missing.push('FIREBASE_WEB_API_KEY (or FIREBASE_API_KEY)');
  if (!process.env.FIREBASE_AUTH_DOMAIN?.trim() && !process.env.FIREBASE_PROJECT_ID?.trim()) missing.push('FIREBASE_AUTH_DOMAIN');
  if (!process.env.FIREBASE_PROJECT_ID?.trim()) missing.push('FIREBASE_PROJECT_ID');
  if (!process.env.FIREBASE_MESSAGING_SENDER_ID?.trim()) missing.push('FIREBASE_MESSAGING_SENDER_ID');
  if (!process.env.FIREBASE_APP_ID?.trim()) missing.push('FIREBASE_APP_ID');
  return missing;
};
async function verifiedUser(req, options = {}) {
  // Support loopback test suite headers for multi-tenant verification in isolated test/dev environments only
  const remoteIp = req.socket.remoteAddress;
  const isDirectLoopback = (
    remoteIp === '127.0.0.1' ||
    remoteIp === '::1' ||
    remoteIp === '::ffff:127.0.0.1'
  );
  // Ensure the request did NOT arrive through any external reverse proxy
  const hasProxyHeader = Boolean(
    req.headers['x-forwarded-for'] ||
    req.headers['x-real-ip'] ||
    req.headers['cf-connecting-ip'] ||
    req.headers['true-client-ip'] ||
    req.headers['forwarded']
  );
  const isTestAllowed = process.env.NODE_ENV !== 'production' || process.env.FLIQ_ALLOW_TEST_UID === 'true';

  if (isDirectLoopback && !hasProxyHeader && isTestAllowed && req.headers['x-fliq-test-uid']) {
    const testUid = String(req.headers['x-fliq-test-uid']).trim();
    if (testUid && /^[a-zA-Z0-9_-]{1,64}$/.test(testUid)) {
      return { uid: testUid, email: `${testUid}@test.fliq.local`, isAnonymous: false };
    }
  }

  const token = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (!adminApp) {
    if (token) {
      try {
        const tokenRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
        if (tokenRes.ok) {
          const tData = await tokenRes.json();
          if (!expectedProjectId || !tData.aud || tData.aud === expectedProjectId) {
            return {
              uid: tData.user_id || tData.sub,
              email: tData.email || '',
              displayName: tData.name || '',
              isAnonymous: false
            };
          }
        }
      } catch (tokenErr) {
        console.warn('[FLIQ] Tokeninfo verification warning:', tokenErr.message);
      }
      const projFlag = expectedProjectId ? ` --project=${expectedProjectId}` : '';
      throw Object.assign(new Error(`Firebase Admin credentials are not configured. Run: gcloud auth application-default login${projFlag} then restart the server, or add a service-account key to .env as GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json`), { status: 503 });
    }
    if (process.env.NODE_ENV === 'production') {
      throw Object.assign(new Error('Sign in to continue.'), { status: 401 });
    }
    return { uid: 'local', isAnonymous: false };
  }
  if (!token) {
    throw Object.assign(new Error('Sign in to continue.'), { status: 401 });
  }
  try {
    const decoded = await getAuth(adminApp).verifyIdToken(token);
    return { ...decoded, isAnonymous: false };
  } catch (verifyErr) {
    console.error('[FLIQ] verifyIdToken failed — code:', verifyErr?.code, 'message:', verifyErr?.message || String(verifyErr));
    throw Object.assign(new Error('Your session expired. Sign in again.'), { status: 401 });
  }
}
let playwrightAvailable = false;
try {
  const { chromium } = await import('playwright');
  const execPath = chromium.executablePath();
  await fs.access(execPath);
  playwrightAvailable = true;
} catch {
  playwrightAvailable = false;
}
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml', '.json':'application/json' };
const send = (res, status, data) => { res.writeHead(status, { 'content-type':'application/json', 'cache-control':'no-store' }); res.end(JSON.stringify(data)); };
const readDB = async () => { try { return JSON.parse(await fs.readFile(dbFile, 'utf8')); } catch { return []; } };
const saveDB = async (data) => fs.writeFile(dbFile, JSON.stringify(data, null, 2));
async function reconcileStaleJobs(maxAgeMs = 180000) {
  const now = Date.now();
  const db = await readDB();
  let changed = false;
  for (const job of db) {
    if (job.status === 'running' || job.status === 'queued') {
      const age = now - Date.parse(job.createdAt || 0);
      if (maxAgeMs === 0 || age > maxAgeMs) {
        job.status = 'failed';
        job.stage = 'Failed';
        job.progress = 0;
        job.error = job.error || (maxAgeMs === 0 ? 'Test was interrupted by a server restart.' : 'Test timed out before completion.');
        job.completedAt = job.completedAt || new Date().toISOString();
        changed = true;
        if (adminApp && cloud() && job.owner !== 'local' && !String(job.owner).startsWith('anon:')) {
          try {
            await cloud().collection('tests').doc(job.id).set({
              status: 'failed',
              stage: 'Failed',
              progress: 0,
              error: job.error,
              completedAt: job.completedAt
            }, { merge: true });
          } catch {}
        }
      }
    }
  }
  if (changed) {
    await saveDB(db);
  }
  return db;
}
await reconcileStaleJobs(0);
const badIP = (ip) => {
  if (net.isIPv4(ip)) {
    const [a, b, c, d] = ip.split('.').map(Number);
    // Block: 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16 (link-local & cloud metadata),
    // 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 192.0.0.0/24, 198.18.0.0/15, 224.0.0.0/4 (multicast/reserved)
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    // Block IPv6 loopback (::1), unspecified (::), unique local (fc00::/7), link-local (fe80::/10)
    if (x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') ||
      x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb')) {
      return true;
    }
    // Block IPv4-mapped IPv6 (::ffff:127.0.0.1 or ::ffff:7f00:1)
    if (x.startsWith('::ffff:')) {
      const v4 = x.slice(7);
      if (net.isIPv4(v4)) return badIP(v4);
      return true;
    }
    return false;
  }
  return true;
};

export async function validateTarget(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Enter a valid website URL.');
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) {
    throw new Error('Only public HTTP or HTTPS websites are supported.');
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal' ||
    host === '169.254.169.254'
  ) {
    throw new Error('This address is not publicly reachable.');
  }
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length) {
    throw new Error('Could not resolve domain name. Please check the website address.');
  }
  if (addresses.some(x => badIP(x.address))) {
    throw new Error('This website resolves to a restricted network address.');
  }
  return { url: u.toString(), hostname: host };
}

// SSE Subscriber Registry & Scan Concurrency Semaphore
const sseSubscribers = new Map(); // testId -> Set<ServerResponse>

function broadcastScanUpdate(testId, data) {
  const clients = sseSubscribers.get(testId);
  if (!clients || clients.size === 0) return;
  const raw = `event: scan-update\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of Array.from(clients)) {
    try {
      res.write(raw);
    } catch {
      clients.delete(res);
    }
  }
}

export function parseConcurrentScans(envVal = process.env.FLIQ_CONCURRENT_SCANS, nodeEnv = process.env.NODE_ENV) {
  const defaultVal = nodeEnv === 'production' ? 1 : 3;
  if (envVal === undefined || envVal === null || String(envVal).trim() === '') {
    return defaultVal;
  }
  const parsed = Number(String(envVal).trim());
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 3) {
    return defaultVal;
  }
  return parsed;
}

const MAX_CONCURRENT_SCANS = parseConcurrentScans();
let activeScanCount = 0;
const scanWaitQueue = [];

function acquireScanSlot() {
  if (activeScanCount < MAX_CONCURRENT_SCANS) {
    activeScanCount++;
    return Promise.resolve();
  }
  return new Promise(resolve => scanWaitQueue.push(resolve));
}

function releaseScanSlot() {
  activeScanCount = Math.max(0, activeScanCount - 1);
  if (scanWaitQueue.length > 0) {
    activeScanCount++;
    const next = scanWaitQueue.shift();
    next();
  }
}

async function generateAIReport(issues = [], targetUrl = '') {
  return await executeAIOrFallbackReport(issues, targetUrl);
}

async function executeTest(job) {
  const update = async (fields) => {
    try {
      const currentDb = await readDB();
      const at = currentDb.findIndex(x => x.id === job.id);
      let updatedRecord = null;
      if (at >= 0) {
        Object.assign(currentDb[at], fields);
        updatedRecord = { ...currentDb[at] };
        await saveDB(currentDb);
      } else {
        updatedRecord = { ...job, ...fields };
      }
      broadcastScanUpdate(job.id, updatedRecord);
      if (adminApp && cloud() && job.owner !== 'local' && !String(job.owner).startsWith('anon:')) {
        try {
          const sanitized = sanitizeReportForPersistence(fields);
          await cloud().collection('tests').doc(job.id).set(sanitized, { merge: true });
        } catch (fsErr) {
          console.error('[FLIQ] Firestore test update error:', fsErr.message);
        }
      }
    } catch (upErr) {
      console.error('[FLIQ] Update test error:', upErr.message);
    }
  };

  let browser = null;
  const timeoutId = setTimeout(async () => {
    try {
      if (browser) await browser.close().catch(() => {});
    } catch {}
    await update({
      status: 'failed',
      progress: 0,
      stage: 'Failed',
      error: 'Test execution exceeded timeout limit (90s).',
      completedAt: new Date().toISOString()
    });
  }, 90000);

  await acquireScanSlot();
  try {
    const { chromium } = await import('playwright');
    const { url } = await validateTarget(job.url);
    await update({ status: 'running', progress: 10, stage: 'Initializing browser', currentUrl: job.url, issues: [] });
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--no-zygote',
        '--no-first-run',
        '--renderer-process-limit=1',
        '--js-flags=--max-old-space-size=128',
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
        '--mute-audio',
        '--disable-default-apps',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
        '--memory-pressure-off'
      ]
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const liveScreenshotFile = `${job.id}-live.jpeg`;
    const liveScreenshotPath = path.join(dataDir, liveScreenshotFile);

    async function captureLivePreview(quality = 70) {
      try {
        if (!page || page.isClosed()) return false;
        await page.screenshot({
          path: liveScreenshotPath,
          type: 'jpeg',
          quality,
          fullPage: false,
          timeout: 2500
        });
        return true;
      } catch {
        return false;
      }
    }

    // Early visual preview as soon as DOM content is parsed
    page.on('domcontentloaded', async () => {
      try {
        const captured = await captureLivePreview(65);
        if (captured) {
          await update({
            progress: 24,
            stage: 'Opening website',
            currentUrl: page.url() || url,
            liveScreenshot: liveScreenshotFile,
            liveScreenshotTime: Date.now()
          });
        }
      } catch {}
    });

    const issues = [];
    const mainOrigin = new URL(url).origin;

    // Apply the same public-address policy to every navigation and subresource, including redirects.
    await page.route('**/*', async route => {
      const target = route.request().url();
      if (target.startsWith('data:') || target.startsWith('blob:')) return route.continue();
      try { await validateTarget(target); return route.continue(); } catch { return route.abort('blockedbyclient'); }
    });

    // Uncaught JavaScript runtime exceptions
    page.on('pageerror', e => {
      issues.push({
        id: randomUUID(),
        ruleId: 'func-uncaught-exception',
        title: 'Uncaught JavaScript runtime exception',
        category: 'Functionality',
        severity: 'high',
        classification: 'Confirmed Failure',
        checkType: 'automated',
        elementCount: 1,
        url: url,
        selector: 'window.onerror',
        htmlSnippet: '',
        evidence: e.message.slice(0, 500),
        expectedBehavior: 'Client-side scripts should execute without unhandled runtime exceptions.',
        actualBehavior: `JavaScript exception thrown: ${e.message.slice(0, 300)}`,
        description: 'An uncaught JavaScript runtime error occurred during page execution. Unhandled errors can halt subsequent scripts and prevent interactive components from functioning.',
        whyItMatters: 'JavaScript runtime errors can break user interactions, checkout flows, and dynamic UI updates.',
        wcagCriterion: 'ECMAScript Robustness Standards',
        reproductionSteps: '1. Open browser console.\n2. Navigate to page.\n3. Observe uncaught exception in console.',
        recommendedFix: 'Review error stack trace, verify object property existence before access, and wrap fragile code in try/catch blocks.',
        codeExample: {
          current: '// Uncaught runtime error on execution',
          corrected: 'try {\n  // safe execution\n} catch (err) {\n  console.error("Recovered from error:", err);\n}'
        },
        confidence: 'high'
      });
    });

    // Failed same-origin network responses
    page.on('response', r => {
      try {
        const rUrl = r.url();
        if (r.status() >= 400 && new URL(rUrl).origin === mainOrigin) {
          issues.push({
            id: randomUUID(),
            ruleId: 'func-failed-request',
            title: `Same-origin request returned HTTP ${r.status()}`,
            category: 'Functionality',
            severity: r.status() >= 500 ? 'high' : 'medium',
            classification: 'Confirmed Failure',
            checkType: 'automated',
            elementCount: 1,
            url: rUrl,
            selector: 'Network Request',
            htmlSnippet: '',
            evidence: `HTTP ${r.status()} response returned for ${rUrl}`,
            expectedBehavior: 'All internal assets and API endpoints should return HTTP 200 OK status codes.',
            actualBehavior: `Server returned HTTP ${r.status()} for ${rUrl}`,
            description: `An internal request to ${rUrl} returned an unsuccessful HTTP ${r.status()} status code.`,
            whyItMatters: 'Failed subresource or API requests can leave features broken, data missing, or UI unstyled.',
            wcagCriterion: 'HTTP/1.1 Specification (RFC 7231)',
            reproductionSteps: `1. Open DevTools -> Network.\n2. Request ${rUrl}.\n3. Observe HTTP ${r.status()} response.`,
            recommendedFix: 'Verify the endpoint URL, file permissions, and server routing to ensure the resource is available.',
            codeExample: {
              current: `GET ${rUrl} -> HTTP ${r.status()}`,
              corrected: `GET ${rUrl} -> HTTP 200 OK`
            },
            confidence: 'high'
          });
        }
      } catch {}
    });

    const started = Date.now();
    await update({ progress: 20, stage: 'Opening website', currentUrl: url });
    let response = null;
    let mainResponseHeaders = {};
    try {
      try {
        response = await page.goto(url, { waitUntil: 'load', timeout: 25000 });
      } catch (loadTimeoutErr) {
        response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      }
      if (response) {
        mainResponseHeaders = response.headers() || {};
      }
    } catch (e) {
      issues.push({
        id: randomUUID(),
        ruleId: 'func-load-timeout',
        title: 'Page did not finish loading within timeout limit',
        category: 'Functionality',
        severity: 'high',
        classification: 'Confirmed Failure',
        type: 'failure',
        checkType: 'automated',
        elementCount: 1,
        url: url,
        selector: 'document',
        htmlSnippet: '',
        evidence: e.message.slice(0, 500),
        expectedBehavior: 'Page should complete initial DOM navigation within 30 seconds.',
        actualBehavior: `Navigation failed: ${e.message.slice(0, 300)}`,
        description: 'The browser could not complete document loading within the 30-second navigation timeout.',
        whyItMatters: 'Unresponsive pages prevent users and search engines from accessing content.',
        wcagCriterion: 'Web Availability & Performance',
        reproductionSteps: '1. Navigate to URL in clean browser session.\n2. Measure connection timing.',
        recommendedFix: 'Optimize server response time and verify web server availability.',
        codeExample: { current: 'Navigation Timeout', corrected: 'Fast Server Response' },
        confidence: 'high'
      });
    }

    const title = await page.title().catch(() => '');
    const finalUrl = page.url();

    // Extract precise W3C Navigation Timing API measurements
    const navMetrics = await page.evaluate(() => {
      try {
        const nav = performance.getEntriesByType('navigation')?.[0];
        if (!nav) return null;
        return {
          domContentLoadedMs: nav.domContentLoadedEventEnd > 0 ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : null,
          windowLoadMs: nav.loadEventEnd > 0 ? Math.round(nav.loadEventEnd - nav.startTime) : null,
          ttfbMs: (nav.responseStart > 0 && nav.requestStart > 0) ? Math.round(nav.responseStart - nav.requestStart) : null
        };
      } catch {
        return null;
      }
    }).catch(() => null);

    const domContentLoadedTime = navMetrics?.domContentLoadedMs || (Date.now() - started);
    const loadTime = navMetrics?.windowLoadMs || Math.max(domContentLoadedTime, Date.now() - started);

    // Reset scroll to top before live preview capture
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.waitForTimeout(150);

    // Capture initial live preview screenshot
    await captureLivePreview(75);

    await update({
      progress: 28,
      stage: 'Opening website',
      currentUrl: finalUrl,
      liveScreenshot: liveScreenshotFile,
      liveScreenshotTime: Date.now(),
      httpStatus: response?.status() ?? null,
      issues: [...issues]
    });

    if (response && response.status() >= 400) {
      issues.push({
        id: randomUUID(),
        ruleId: 'func-http-error',
        title: `Main document returned HTTP ${response.status()}`,
        category: 'Functionality',
        severity: 'high',
        classification: 'Confirmed Failure',
        checkType: 'automated',
        elementCount: 1,
        url: finalUrl,
        selector: 'HTTP Response',
        htmlSnippet: '',
        evidence: `HTTP Status Code: ${response.status()}`,
        expectedBehavior: 'The primary page URL must return a successful HTTP 200 status code.',
        actualBehavior: `Received HTTP ${response.status()}`,
        description: `The web server responded with an error HTTP status (${response.status()}) for the main document.`,
        whyItMatters: 'Users and search engine crawlers encounter error screens instead of the requested page.',
        wcagCriterion: 'HTTP/1.1 (RFC 7231)',
        reproductionSteps: `1. Request ${finalUrl}.\n2. Inspect response status code.`,
        recommendedFix: 'Ensure the requested URL exists and returns HTTP 200 OK.',
        codeExample: { current: `Status: ${response.status()}`, corrected: 'Status: 200 OK' },
        confidence: 'high'
      });
    }

    // Canonical check status helper mapping checks to the 6 standard statuses
    function mapCheckStatus(chk, matchingFindings = []) {
      if (chk.type === 'manual' || chk.status === 'not_tested') return 'not_tested';
      if (chk.status === 'unavailable' || chk.type === 'field' || chk.measurement === 'field') return 'unavailable';
      if (!matchingFindings || matchingFindings.length === 0) return 'passed';
      if (matchingFindings.some(f => f.classification === 'Confirmed Failure' || f.type === 'failure')) return 'confirmed_failure';
      if (matchingFindings.some(f => f.classification === 'Potential Issue' || f.type === 'recommendation')) return 'potential_issue';
      if (matchingFindings.some(f => f.classification === 'Informational')) return 'informational';
      return 'passed';
    }

    // 3. Inspecting accessibility
    await update({ progress: 35, stage: 'Inspecting accessibility', currentUrl: finalUrl, liveScreenshot: liveScreenshotFile });
    let accessibilityCount = 0;
    let accessibilityReport = null;
    try {
      const a11yScan = await page.evaluate(evaluateAccessibility, finalUrl);
      for (const f of a11yScan.findings || []) {
        issues.push({ id: randomUUID(), ...f });
      }
      accessibilityCount = (a11yScan.findings || []).reduce((sum, f) => sum + (f.elementCount || 0), 0);
      const ruleMapping = {
        'img-alt': 'image-alt-missing',
        'button-name': 'button-name-missing',
        'input-label': 'form-label-missing',
        'link-name': 'link-name-missing',
        'interactive-aria-hidden': 'interactive-aria-hidden',
        'keyboard-nav': 'keyboard-unreachable',
        'focus-visible': 'focus-indicator-missing',
        'heading-hierarchy': 'heading-hierarchy-skipped',
        'duplicate-ids': 'duplicate-element-ids',
        'color-contrast': 'color-contrast-insufficient',
        'document-lang': 'html-lang-missing',
        'viewport-scale': 'viewport-zoom-disabled'
      };
      const checks = A11Y_CHECKS.map(chk => {
        if (chk.type === 'manual') return { ...chk, status: 'not_tested' };
        const targetRule = ruleMapping[chk.id];
        const matching = targetRule ? (a11yScan.findings || []).filter(f => f.ruleId === targetRule) : [];
        return { ...chk, status: mapCheckStatus(chk, matching) };
      });
      accessibilityReport = {
        testedUrl: finalUrl,
        scannedAt: new Date().toISOString(),
        disclaimer: `Automated scan of ${finalUrl}. Automated testing identifies common barrier patterns on the scanned document, but cannot determine full compliance or subjective usability without manual assistive technology testing.`,
        failuresCount: (a11yScan.findings || []).filter(x => x.classification === 'Confirmed Failure').length,
        recommendationsCount: (a11yScan.findings || []).filter(x => x.classification !== 'Confirmed Failure').length,
        totalElementsAffected: accessibilityCount,
        checks
      };

      // Native browser-level keyboard navigation audit (Playwright CDP)
      try {
        const kbAudit = await auditNativeKeyboardNavigation(page, finalUrl);
        for (const f of kbAudit.findings || []) {
          issues.push({ id: randomUUID(), ...f });
        }
      } catch (kbErr) {
        console.error('[FLIQ] Native keyboard navigation non-fatal error:', kbErr.message);
      }
    } catch (a11yErr) {
      console.error('[FLIQ] Accessibility scan error:', a11yErr.message);
    }
    await captureLivePreview(70);
    await update({ progress: 48, stage: 'Inspecting accessibility', currentUrl: finalUrl, issues: [...issues], liveScreenshot: liveScreenshotFile, liveScreenshotTime: Date.now() });

    // 4. Testing functionality
    await update({ progress: 50, stage: 'Testing functionality', currentUrl: finalUrl });
    let broken = 0;
    const brokenLinksList = [];
    const links = await page.locator('a[href]').evaluateAll(as => as.slice(0, 80).map(a => a.href).filter(h => h.startsWith(location.origin)));
    for (const href of [...new Set(links)].slice(0, 25)) {
      try {
        await validateTarget(href);
        const r = await page.request.get(href, { timeout: 4000, maxRedirects: 0 });
        if (r.status() >= 400) {
          broken++;
          brokenLinksList.push({
            url: href,
            status: r.status(),
            selector: `a[href="${href}"]`,
            htmlSnippet: `<a href="${href}">`,
            suggestedFix: `Update link destination or remove broken reference (returned HTTP ${r.status()})`
          });
        }
      } catch {}
    }

    if (brokenLinksList.length > 0) {
      const worstStatus = Math.max(...brokenLinksList.map(b => b.status));
      issues.push({
        id: randomUUID(),
        ruleId: 'func-broken-link',
        title: `${brokenLinksList.length} internal link(s) returned HTTP error status (${worstStatus})`,
        category: 'Functionality',
        severity: worstStatus >= 500 ? 'high' : 'medium',
        classification: 'Confirmed Failure',
        checkType: 'automated',
        elementCount: brokenLinksList.length,
        url: finalUrl,
        selector: brokenLinksList[0].selector,
        htmlSnippet: brokenLinksList[0].htmlSnippet,
        evidence: `${brokenLinksList.length} internal link(s) failed: ${brokenLinksList.map(b => `${b.url} [HTTP ${b.status}]`).slice(0, 3).join(', ')}.`,
        expectedBehavior: 'All internal hyperlinks must resolve with HTTP 200 OK.',
        actualBehavior: `Server returned HTTP client/server error codes for ${brokenLinksList.length} destination(s).`,
        description: `Found ${brokenLinksList.length} internal link(s) pointing to non-existent or failing destinations on the same origin.`,
        whyItMatters: 'Broken links frustrate visitors and waste search engine crawl budget.',
        wcagCriterion: 'HTTP/1.1 (RFC 7231)',
        reproductionSteps: `1. Click link pointing to ${brokenLinksList[0].url}.\n2. Browser navigates to HTTP ${brokenLinksList[0].status} error page.`,
        recommendedFix: 'Update the link href to point to an active URL or remove obsolete links.',
        codeExample: { current: brokenLinksList[0].htmlSnippet, corrected: '<a href="/valid-path">' },
        confidence: 'high',
        elements: brokenLinksList
      });
    }

    const missingImagesList = await page.locator('img').evaluateAll(imgs =>
      imgs.filter(i => !i.complete || i.naturalWidth === 0).slice(0, 12).map(i => ({
        url: i.currentSrc || i.src || '(no src)',
        selector: `img[src="${i.currentSrc || i.src || ''}"]`,
        htmlSnippet: `<img src="${i.currentSrc || i.src || ''}">`,
        suggestedFix: 'Verify image asset path and upload the asset to the web server'
      }))
    );

    if (missingImagesList.length > 0) {
      issues.push({
        id: randomUUID(),
        ruleId: 'func-broken-image',
        title: `${missingImagesList.length} image asset(s) failed to render (naturalWidth = 0)`,
        category: 'Functionality',
        severity: 'medium',
        classification: 'Confirmed Failure',
        checkType: 'automated',
        elementCount: missingImagesList.length,
        url: finalUrl,
        selector: missingImagesList[0].selector,
        htmlSnippet: missingImagesList[0].htmlSnippet,
        evidence: `Observed naturalWidth === 0 or incomplete loading for ${missingImagesList.length} image(s): ${missingImagesList.map(m => m.url).slice(0, 3).join(', ')}.`,
        expectedBehavior: 'All <img> elements must successfully load image data with non-zero dimensions.',
        actualBehavior: `${missingImagesList.length} image asset(s) failed to render in the browser.`,
        description: `The browser could not load the image files at the specified paths.`,
        whyItMatters: 'Broken images degrade user experience and leave unsightly placeholder gaps.',
        wcagCriterion: 'HTML Living Standard §4.8.3',
        reproductionSteps: `1. Inspect the <img> tag in DOM.\n2. In console, confirm naturalWidth === 0.`,
        recommendedFix: 'Check that image files exist at the specified relative or absolute paths on the hosting server.',
        codeExample: { current: missingImagesList[0].htmlSnippet, corrected: '<img src="/assets/valid-image.png">' },
        confidence: 'high',
        elements: missingImagesList
      });
    }

    let formsData = { formsCount: 0, forms: [], tested: false };
    try {
      formsData = await page.evaluate(inspectFormsPassive, finalUrl);
    } catch {}

    try {
      const deadTriggers = await page.evaluate(checkDeadTriggers, finalUrl);
      for (const f of deadTriggers.findings || []) {
        issues.push({ id: randomUUID(), ...f });
      }
    } catch {}

    await captureLivePreview(70);
    await update({ progress: 62, stage: 'Testing functionality', currentUrl: finalUrl, issues: [...issues], liveScreenshot: liveScreenshotFile, liveScreenshotTime: Date.now() });

    // 5. Measuring performance
    await update({ progress: 65, stage: 'Measuring performance', currentUrl: finalUrl });
    let performanceReport = null;
    try {
      const perfScan = await page.evaluate(extractPerformanceMetrics, finalUrl);
      for (const f of perfScan.findings || []) {
        issues.push({ id: randomUUID(), ...f });
      }
      const perfFindings = perfScan.findings || [];
      const m = perfScan.metrics || {};
      performanceReport = {
        metrics: m,
        checks: PERF_CHECKS.map(chk => {
          if (chk.type === 'field' || chk.measurement === 'field') {
            return { ...chk, status: 'unavailable', summary: chk.summary + ' (Field Metric unavailable in lab scan)' };
          }
          if (chk.id === 'perf-fcp' && m.fcpMs === null) return { ...chk, status: 'unavailable' };
          if (chk.id === 'perf-lcp' && m.lcpMs === null) return { ...chk, status: 'unavailable' };
          if (chk.id === 'perf-cls' && m.clsValue === null) return { ...chk, status: 'unavailable' };
          if (chk.id === 'perf-ttfb' && m.ttfbMs === null) return { ...chk, status: 'unavailable' };
          const ruleSuffix = chk.id.replace('perf-', '');
          const matching = perfFindings.filter(f => f.ruleId.includes(ruleSuffix));
          return { ...chk, status: mapCheckStatus(chk, matching) };
        })
      };
    } catch (perfErr) {
      console.error('[FLIQ] Performance scan error:', perfErr.message);
    }
    await update({ progress: 72, stage: 'Measuring performance', currentUrl: finalUrl, issues: [...issues], liveScreenshot: liveScreenshotFile, liveScreenshotTime: Date.now() });

    // 6. Checking SEO
    await update({ progress: 75, stage: 'Checking SEO', currentUrl: finalUrl });
    let seoReport = null;
    try {
      const seoScan = await page.evaluate(evaluateSEO, finalUrl);
      for (const f of seoScan.findings || []) {
        issues.push({ id: randomUUID(), ...f });
      }
      const SEO_RULE_MAPPING = {
        'page-title': ['seo-title-missing', 'seo-title-length'],
        'meta-description': ['seo-meta-description-missing'],
        'heading-h1': ['seo-h1-missing'],
        'canonical-url': ['seo-canonical-missing'],
        'open-graph': ['seo-open-graph-incomplete'],
        'robots-directives': ['seo-robots-disallow'],
        'mobile-viewport': ['seo-viewport-missing'],
        'image-alt-coverage': ['seo-image-alt-missing']
      };
      seoReport = {
        summary: seoScan.summary || {},
        checks: SEO_CHECKS.map(chk => {
          const targetRules = SEO_RULE_MAPPING[chk.id] || [chk.id];
          const matching = (seoScan.findings || []).filter(f => targetRules.some(r => f.ruleId === r || f.ruleId.includes(r)));
          const status = mapCheckStatus(chk, matching);
          let evidence = chk.summary;
          if (chk.id === 'canonical-url') {
            evidence = seoScan.summary?.canonical
              ? `Declared canonical URL: <link rel="canonical" href="${seoScan.summary.canonical}">`
              : 'No <link rel="canonical"> tag found (Informational observation).';
          } else if (chk.id === 'heading-h1') {
            evidence = (seoScan.summary?.h1Count === 1)
              ? 'Primary <h1> topic heading is present.'
              : (seoScan.summary?.h1Count === 0)
                ? 'Missing primary <h1> topic heading (Potential Issue).'
                : `${seoScan.summary?.h1Count} <h1> headings found (Recommended: exactly 1).`;
          } else if (chk.id === 'page-title') {
            evidence = (seoScan.summary?.titleLength > 0)
              ? `Document title present: "${seoScan.summary.title}" (${seoScan.summary.titleLength} chars).`
              : 'Document title (<title>) tag is missing or empty.';
          } else if (matching.length > 0 && matching[0].evidence) {
            evidence = matching[0].evidence;
          }
          return { ...chk, status, evidence };
        })
      };
    } catch (seoErr) {
      console.error('[FLIQ] SEO scan error:', seoErr.message);
    }
    await update({ progress: 82, stage: 'Checking SEO', currentUrl: finalUrl, issues: [...issues], liveScreenshot: liveScreenshotFile });

    // 7. Auditing security
    await update({ progress: 85, stage: 'Auditing security', currentUrl: finalUrl });
    let securityReport = null;
    try {
      const headerSec = evaluateSecurityHeaders(finalUrl, mainResponseHeaders);
      for (const f of headerSec.findings || []) {
        issues.push({ id: randomUUID(), ...f });
      }
      const domSec = await page.evaluate(evaluateDOMSecurity, finalUrl);
      for (const f of domSec.findings || []) {
        issues.push({ id: randomUUID(), ...f });
      }
      const allSecFindings = [...headerSec.findings, ...domSec.findings];
      const SEC_RULE_MAPPING = {
        'sec-https': ['sec-https-missing'],
        'sec-hsts': ['sec-hsts-missing'],
        'sec-csp': ['sec-csp-missing'],
        'sec-x-frame-options': ['sec-x-frame-options-missing'],
        'sec-x-content-type': ['sec-x-content-type-options-missing'],
        'sec-referrer-policy': ['sec-referrer-policy-missing'],
        'sec-mixed-content': ['sec-mixed-content-detected'],
        'sec-tab-nabbing': ['sec-unsafe-external-link']
      };
      securityReport = {
        headerStatus: headerSec.headerStatus || {},
        checks: SECURITY_CHECKS.map(chk => {
          const targetRules = SEC_RULE_MAPPING[chk.id] || [chk.id.replace('sec-', '')];
          const matching = allSecFindings.filter(f => targetRules.some(r => f.ruleId === r || f.ruleId.includes(r)));
          const status = mapCheckStatus(chk, matching);
          let evidence = chk.summary;
          if (chk.id === 'sec-x-content-type') {
            evidence = headerSec.headerStatus?.xContentTypeOptions
              ? 'X-Content-Type-Options: nosniff header is present.'
              : 'X-Content-Type-Options: nosniff header is missing (Potential Issue).';
          } else if (chk.id === 'sec-hsts') {
            evidence = headerSec.headerStatus?.hsts
              ? 'Strict-Transport-Security header is present.'
              : 'Strict-Transport-Security header is missing (Potential Issue).';
          } else if (chk.id === 'sec-csp') {
            evidence = headerSec.headerStatus?.csp
              ? 'Content-Security-Policy header is enforced.'
              : 'Content-Security-Policy header is missing (Potential Issue).';
          } else if (chk.id === 'sec-x-frame-options') {
            evidence = headerSec.headerStatus?.xFrameOptions
              ? 'Framing protection header (X-Frame-Options or frame-ancestors) is present.'
              : 'Framing protection header is missing (Potential Issue).';
          } else if (chk.id === 'sec-https') {
            evidence = headerSec.headerStatus?.https
              ? 'Website is served over encrypted HTTPS.'
              : 'Website is served over unencrypted HTTP (Confirmed Failure).';
          } else if (matching.length > 0 && matching[0].evidence) {
            evidence = matching[0].evidence;
          }
          return { ...chk, status, evidence };
        })
      };
    } catch (secErr) {
      console.error('[FLIQ] Security scan error:', secErr.message);
    }
    await update({ progress: 90, stage: 'Auditing security', currentUrl: finalUrl, issues: [...issues], liveScreenshot: liveScreenshotFile, liveScreenshotTime: Date.now() });

    // 8. Generating report
    await update({ progress: 95, stage: 'Generating report', currentUrl: finalUrl });
    let discoveredLinks = [];
    try {
      const targetOrigin = new URL(finalUrl).origin;
      discoveredLinks = await page.evaluate(extractDiscoveredLinks, targetOrigin);
    } catch (linkErr) {
      console.warn('[FLIQ] Link discovery non-fatal warning:', linkErr.message);
    }

    let robotsInfo = { exists: false, status: 0, disallowedPaths: [] };
    try {
      robotsInfo = await checkRobotsTxt(new URL(finalUrl).origin);
    } catch {}

    // Resilient Viewport Capture (Desktop, Tablet, Mobile)
    const desktop = path.join(dataDir, `${job.id}-desktop.png`);
    const tablet = path.join(dataDir, `${job.id}-tablet.png`);
    const mobile = path.join(dataDir, `${job.id}-mobile.png`);

    try {
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await page.waitForTimeout(150);
      await page.screenshot({ path: desktop, fullPage: false, timeout: 6000 });
      await captureLivePreview(80);
      await fs.copyFile(desktop, liveScreenshotPath).catch(() => {});
    } catch (dErr) {
      console.warn('[FLIQ] Desktop screenshot non-fatal warning:', dErr.message);
    }

    try {
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await page.waitForTimeout(100);
      await page.screenshot({ path: tablet, fullPage: false, timeout: 5000 });
      const tabletOverflow = await page.evaluate(checkResponsiveLayout, finalUrl).catch(() => null);
      for (const f of tabletOverflow?.findings || []) {
        f.title = `[Tablet] ${f.title}`;
        issues.push({ id: randomUUID(), ...f });
      }
    } catch (tErr) {
      console.warn('[FLIQ] Tablet capture non-fatal warning:', tErr.message);
      try { await fs.copyFile(desktop, tablet); } catch {}
    }

    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await page.waitForTimeout(100);
      await page.screenshot({ path: mobile, fullPage: false, timeout: 5000 });
      const mobileOverflow = await page.evaluate(checkResponsiveLayout, finalUrl).catch(() => null);
      for (const f of mobileOverflow?.findings || []) {
        f.title = `[Mobile] ${f.title}`;
        issues.push({ id: randomUUID(), ...f });
      }
    } catch (mErr) {
      console.warn('[FLIQ] Mobile capture non-fatal warning:', mErr.message);
      try { await fs.copyFile(desktop, mobile); } catch {}
    }

    // Immediately close Chromium browser to release ~300MB RAM before report aggregation & scoring
    try {
      if (browser) {
        await browser.close();
        browser = null;
      }
    } catch (bCloseErr) {
      console.warn('[FLIQ] Browser close warning:', bCloseErr.message);
    }

    // Quality Analysis & Explanations (Deterministic quality engine)
    await update({ progress: 96, stage: 'Generating report' });
    let aiSummary = 'Quality audit analysis complete.';
    let finalIssues = issues;
    let isAiGenerated = false;
    try {
      const aiResult = await generateAIReport(issues, finalUrl || job.url);
      aiSummary = aiResult.aiSummary || aiSummary;
      finalIssues = aiResult.issues || issues;
      isAiGenerated = Boolean(aiResult.isAiGenerated);
    } catch (aiErr) {
      console.error('[FLIQ] generateAIReport non-fatal error:', aiErr.message);
      const fallback = generateDeterministicSummary(issues, finalUrl || job.url);
      aiSummary = fallback.aiSummary;
      finalIssues = fallback.issues;
      isAiGenerated = false;
    }

    // 8. Evidence-Based Scoring Calculation
    const scoreData = calculateCategoryScores(finalIssues);
    const score = scoreData.overallScore;
    const categoryScores = scoreData.categoryScores;
    const scoreExplanation = scoreData.scoreExplanation;
    const groupedIssues = scoreData.groupedIssues || finalIssues;

    const functionalityReport = {
      checks: FUNCTIONALITY_CHECKS.map(chk => {
        if (chk.id === 'func-forms') {
          return { ...chk, status: 'not_tested', summary: `Discovered ${formsData.formsCount} form(s). Forms were not submitted (passive non-destructive scan policy).` };
        }
        const ruleSuffix = chk.id.replace('func-', '');
        const matching = finalIssues.filter(i => i.category === 'Functionality' && i.ruleId.includes(ruleSuffix));
        return { ...chk, status: mapCheckStatus(chk, matching) };
      }),
      forms: formsData,
      internalLinksTested: links.length,
      internalLinksBroken: brokenLinksList.length,
      missingImagesCount: missingImagesList.length
    };

    const allAuditChecks = [
      ...(accessibilityReport?.checks || []),
      ...(seoReport?.checks || []),
      ...(securityReport?.checks || []),
      ...(performanceReport?.checks || []),
      ...(functionalityReport?.checks || [])
    ];

    const auditCoverage = computeAuditCoverage({
      finalUrl,
      discoveredUrls: discoveredLinks,
      inspectedUrls: [finalUrl],
      issues: finalIssues,
      allChecks: allAuditChecks,
      viewports: { desktop: true, tablet: true, mobile: true }
    });

    await update({
      status: 'completed',
      progress: 100,
      stage: 'Complete',
      completedAt: new Date().toISOString(),
      finalUrl,
      title,
      httpStatus: response?.status() ?? null,
      loadTime,
      issues: groupedIssues,
      rawIssues: finalIssues,
      score,
      categoryScores,
      scoreExplanation,
      brokenLinks: brokenLinksList.length,
      missingImages: missingImagesList.length,
      accessibilityCount,
      accessibilityReport,
      seoReport,
      securityReport,
      performanceReport,
      functionalityReport,
      auditCoverage,
      robotsInfo,
      aiSummary,
      isAiGenerated,
      durationMs: loadTime,
      pagesDiscovered: discoveredLinks.length,
      pagesInspected: 1,
      pagesSkipped: Math.max(0, discoveredLinks.length - 1),
      screenshots: [`${job.id}-desktop.png`, `${job.id}-tablet.png`, `${job.id}-mobile.png`],
      liveScreenshot: liveScreenshotFile,
      liveScreenshotTime: Date.now()
    });
  } catch (e) {
    let message = e.message;
    if (e.code === 'ERR_MODULE_NOT_FOUND') {
      message = 'Playwright is not installed. Run: npm install && npx playwright install chromium';
    } else if (e.message && (e.message.includes("Executable doesn't exist") || e.message.includes("npx playwright install"))) {
      message = 'Playwright Chromium browser is not installed. Run: npx playwright install chromium';
    } else if (e.message && (e.message.includes('Target page, context or browser has been closed') || e.message.includes('Crash') || e.message.includes('OOM') || e.message.includes('SIGKILL') || e.message.includes('Out of memory') || e.message.includes('browser has disconnected'))) {
      message = 'Scan memory limit exceeded or browser process crashed. Please retry with a lighter target page or restart the worker.';
    }
    await update({ status: 'failed', progress: 0, stage: 'Failed', error: message, completedAt: new Date().toISOString() });
  } finally {
    clearTimeout(timeoutId);
    if (browser) {
      await browser.close().catch(() => {});
    }
    releaseScanSlot();
  }
}

export function isOriginAllowed(origin, allowedOriginsEnv = process.env.FLIQ_ALLOWED_ORIGINS) {
  if (!origin) return false;
  const o = origin.toLowerCase().trim();

  // Allow localhost & loopback ONLY in non-production for local development and tests
  if (process.env.NODE_ENV !== 'production') {
    if (o.startsWith('http://localhost:') || o.startsWith('http://127.0.0.1:') || o === 'http://localhost' || o === 'http://127.0.0.1') {
      return true;
    }
  }

  // If no allowed origins specified in non-production, permit all for local development
  if (!allowedOriginsEnv || !allowedOriginsEnv.trim()) {
    return process.env.NODE_ENV !== 'production';
  }

  const allowedList = allowedOriginsEnv.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const pattern of allowedList) {
    if (pattern === o) return true;
    // Wildcard domain match (e.g. *.pages.dev, *.vercel.app, *.netlify.app)
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      try {
        const u = new URL(o);
        if (u.hostname.endsWith(suffix) || ('.' + u.hostname) === suffix) return true;
      } catch {}
    }
  }
  return false;
}

const server=http.createServer(async(req,res)=>{
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('vary', 'Origin');
  }
  res.setHeader('access-control-allow-headers', 'content-type, authorization, x-fliq-test-uid');
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    if (origin && !isOriginAllowed(origin)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('CORS origin forbidden');
    }
    res.writeHead(204);
    return res.end();
  }
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/firebase-config.js'&&req.method==='GET'){
    const cfg = getFirebaseWebConfig();
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(`window.__FLIQ_FIREBASE_CONFIG__ = ${JSON.stringify(cfg, null, 2)};\n`);
  }
  if(pathname==='/firebase-config.json'&&req.method==='GET'){
    return send(res, 200, getFirebaseWebConfig());
  }
  if(pathname.startsWith('/api/')){
    if(pathname==='/api/webhooks/polar'){
      if(req.method==='POST'){
        return handlePolarWebhookRequest(req, res, { cloudDb: cloud(), localDataDir: dataDir, adminApp });
      }
      return send(res, 405, { error: 'Method not allowed. Polar webhooks require POST.' });
    }
    if(pathname==='/api/checkout/polar' || pathname==='/api/checkout'){
      if(req.method==='POST'){
        return handlePolarCheckoutRequest(req, res, { cloudDb: cloud(), adminApp, verifiedUserFn: verifiedUser });
      }
      return send(res, 405, { error: 'Method not allowed. Checkout requires POST.' });
    }
    if(pathname==='/api/firebase-config'&&req.method==='GET'){const missing=getMissingFirebaseWebFields();return send(res,200,{configured:missing.length===0,missing,config:missing.length===0?getFirebaseWebConfig():null});}
    if(pathname==='/api/health'){
      const firebaseWebMissing = getMissingFirebaseWebFields();
      const firebaseAdminConfigured = Boolean(adminApp);
      const credentialType = adminApp ? (process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? 'service-account-env' : process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ? 'service-account-file' : 'application-default-credentials') : 'none';
      const firestoreModuleAvailable = Boolean(getFirestore);
      const firestoreConfigured = Boolean(adminApp && firestoreModuleAvailable);
      let firestoreConnected = false;
      let firestoreConnectionError = null;
      if (firestoreConfigured) {
        const conn = await checkFirestoreConnectivity();
        firestoreConnected = conn.connected;
        firestoreConnectionError = conn.error;
      }
      return send(res, 200, {
        ok: true,
        playwrightConfigured: playwrightAvailable,
        firestoreModuleAvailable,
        firestoreConfigured,
        firestoreConnected,
        firestoreConnectionError,
        firebaseConfigured: Boolean(firebaseAdminConfigured && firebaseWebMissing.length === 0),
        firebaseWebConfigured: firebaseWebMissing.length === 0,
        firebaseWebMissing,
        firebaseAdminConfigured,
        polarWebhookConfigured: Boolean(process.env.POLAR_WEBHOOK_SECRET),
        credentialType,
        firebaseMissing: [...firebaseWebMissing, ...(firebaseAdminConfigured ? [] : [expectedProjectId ? `Valid ${expectedProjectId} server credential (Firebase Admin) — run: gcloud auth application-default login --project=${expectedProjectId}` : 'Valid Firebase Admin server credential required — set FIREBASE_PROJECT_ID and run: gcloud auth application-default login'])],
        authMode: firebaseAdminConfigured ? 'firebase' : 'local-preview'
      });
    }

    // Security Gate: Test routes are strictly restricted to direct loopback requests in non-production environments
    const isTestRoute = [
      '/api/regression-tests',
      '/api/demo-workflow-tests',
      '/api/auth-workflow-tests',
      '/api/logo-navigation-tests',
      '/api/ai-resilience-tests',
      '/api/live-inspection-tests',
      '/api/report-consistency-tests',
      '/api/pricing-tests',
      '/api/pricing-auth-tests'
    ].includes(pathname);

    if (isTestRoute) {
      const remoteIp = req.socket.remoteAddress;
      const isDirectLoopback = (
        remoteIp === '127.0.0.1' ||
        remoteIp === '::1' ||
        remoteIp === '::ffff:127.0.0.1'
      );
      const hasProxy = Boolean(
        req.headers['x-forwarded-for'] ||
        req.headers['x-real-ip'] ||
        req.headers['cf-connecting-ip'] ||
        req.headers['true-client-ip'] ||
        req.headers['forwarded']
      );
      const isProduction = process.env.NODE_ENV === 'production' && process.env.FLIQ_ALLOW_TEST_ROUTES !== 'true';
      if (!isDirectLoopback || hasProxy || isProduction) {
        return send(res, 404, { error: 'Not found.' });
      }
    }
    if(pathname==='/api/regression-tests'){
      if(req.method==='POST'){
        try {
          const report = await runA11yRegressionSuite();
          return send(res, 200, report);
        } catch(err) {
          return send(res, 500, { error: err.message });
        }
      }
      try {
        const raw = await fs.readFile(path.join(dataDir, 'regression-test-results.json'), 'utf8');
        return send(res, 200, JSON.parse(raw));
      } catch {
        return send(res, 404, { error: 'No regression test results recorded yet. Send POST to run.' });
      }
    }
    if(pathname==='/api/demo-workflow-tests'){
      if(req.method==='POST'){
        try {
          const report = await runDemoWorkflowTests();
          return send(res, 200, report);
        } catch(err) {
          return send(res, 500, { error: err.message });
        }
      }
      try {
        const raw = await fs.readFile(path.join(dataDir, 'demo-workflow-test-results.json'), 'utf8');
        return send(res, 200, JSON.parse(raw));
      } catch {
        return send(res, 404, { error: 'No demo workflow test results recorded yet. Send POST to run.' });
      }
    }
    if(pathname==='/api/auth-workflow-tests'){
      if(req.method==='POST'){
        try {
          const report = await runAuthWorkflowTests();
          return send(res, 200, report);
        } catch(err) {
          return send(res, 500, { error: err.message });
        }
      }
      try {
        const raw = await fs.readFile(path.join(dataDir, 'auth-workflow-test-results.json'), 'utf8');
        return send(res, 200, JSON.parse(raw));
      } catch {
        return send(res, 404, { error: 'No auth workflow test results recorded yet. Send POST to run.' });
      }
    }
    if(pathname==='/api/logo-navigation-tests'){
      if(req.method==='POST'){
        try {
          const report = await runLogoNavigationTests();
          return send(res, 200, report);
        } catch(err) {
          return send(res, 500, { error: err.message });
        }
      }
      try {
        const raw = await fs.readFile(path.join(dataDir, 'logo-navigation-test-results.json'), 'utf8');
        return send(res, 200, JSON.parse(raw));
      } catch {
        return send(res, 404, { error: 'No logo navigation test results recorded yet. Send POST to run.' });
      }
    }
    if(pathname==='/api/ai-resilience-tests'){
      if(req.method==='POST'){
        try {
          const report = await runAIResilienceTests();
          return send(res, 200, report);
        } catch(err) {
          return send(res, 500, { error: err.message });
        }
      }
      try {
        const raw = await fs.readFile(path.join(dataDir, 'ai-resilience-test-results.json'), 'utf8');
        return send(res, 200, JSON.parse(raw));
      } catch {
        return send(res, 404, { error: 'No AI resilience test results recorded yet. Send POST to run.' });
      }
    }
    if(pathname==='/api/live-inspection-tests'){
      if(req.method==='POST'){
        try {
          const report = await runLiveInspectionTests();
          return send(res, 200, report);
        } catch(err) {
          return send(res, 500, { error: err.message });
        }
      }
      try {
        const raw = await fs.readFile(path.join(dataDir, 'live-inspection-test-results.json'), 'utf8');
        return send(res, 200, JSON.parse(raw));
      } catch {
        return send(res, 404, { error: 'No live inspection test results recorded yet. Send POST to run.' });
      }
    }
    if(pathname==='/api/report-consistency-tests'){
      if(req.method==='POST'){
        try {
          const report = await runReportConsistencyTests();
          return send(res, 200, report);
        } catch(err) {
          return send(res, 500, { error: err.message });
        }
      }
      try {
        const raw = await fs.readFile(path.join(dataDir, 'report-consistency-test-results.json'), 'utf8');
        return send(res, 200, JSON.parse(raw));
      } catch {
        return send(res, 404, { error: 'No report consistency test results recorded yet. Send POST to run.' });
      }
    }
    if(pathname==='/api/pricing-tests'){
      if(req.method==='POST'){
        try {
          const report = await runPricingVerificationTests();
          return send(res, 200, report);
        } catch(err) {
          return send(res, 500, { error: err.message });
        }
      }
      try {
        const raw = await fs.readFile(path.join(dataDir, 'pricing-test-results.json'), 'utf8');
        return send(res, 200, JSON.parse(raw));
      } catch {
        try {
          const report = await runPricingVerificationTests();
          return send(res, 200, report);
        } catch(e) {
          return send(res, 500, { error: e.message });
        }
      }
    }
    if(pathname==='/api/pricing-auth-tests'){
      if(req.method==='POST'){
        try {
          const report = await runPricingAuthTests();
          return send(res, 200, report);
        } catch(err) {
          return send(res, 500, { error: err.message });
        }
      }
      try {
        const raw = await fs.readFile(path.join(dataDir, 'pricing-auth-test-results.json'), 'utf8');
        return send(res, 200, JSON.parse(raw));
      } catch {
        try {
          const report = await runPricingAuthTests();
          return send(res, 200, report);
        } catch(e) {
          return send(res, 500, { error: e.message });
        }
      }
    }
    if(pathname==='/api/profile'&&(req.method==='GET'||req.method==='POST')){
      try{const user=await verifiedUser(req);let body='';if(req.method==='POST')for await(const c of req)body+=c;const values=body?JSON.parse(body):{};
        if(adminApp && cloud() && user.uid!=='local'){const ref=cloud().collection('users').doc(user.uid);if(req.method==='POST'){const allowed=['displayName','websiteType','onboardingComplete','preferences'];const safe=Object.fromEntries(allowed.filter(k=>Object.hasOwn(values,k)).map(k=>[k,values[k]]));if(typeof safe.displayName==='string')safe.displayName=safe.displayName.slice(0,100);if(typeof safe.websiteType==='string')safe.websiteType=safe.websiteType.slice(0,80);await ref.set({...safe,uid:user.uid,updatedAt:FieldValue.serverTimestamp()},{merge:true});}const snap=await ref.get();return send(res,200,snap.exists?snap.data():{uid:user.uid});}
        return send(res,200,{uid:user.uid,...values});
      }catch(e){return send(res,e.status||400,{error:e.message});}
    }
    if(pathname==='/api/tests'&&req.method==='GET'){
      try{
        const user=await verifiedUser(req);
        const docs=new Map();
        if(adminApp && cloud() && user.uid!=='local'){
          try {
            const col=cloud().collection('tests');
            const [owned,shared]=await Promise.all([
              col.where('owner','==',user.uid).limit(100).get(),
              col.where('sharedWithUids','array-contains',user.uid).limit(100).get()
            ]);
            for(const d of [...owned.docs, ...shared.docs]) {
              docs.set(d.id, d.data());
            }
          } catch(fsErr) {
            console.warn('[FLIQ] Firestore test query warning:', fsErr.message);
          }
        }
        // Always merge existing records from data/tests.json belonging to the user
        const localTests = await readDB();
        for(const t of localTests){
          const isOwner = t.owner === user.uid || (user.uid === 'local' && t.owner === 'local');
          const isShared = Array.isArray(t.sharedWithUids) && t.sharedWithUids.includes(user.uid);
          if((isOwner || isShared) && !docs.has(t.id)){
            docs.set(t.id, t);
          }
        }
        const userTests = [...docs.values()].sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
        return send(res,200,userTests.map(({owner,sharedWithUids,...safe})=>safe));
      }catch(e){return send(res,e.status||401,{error:e.message});}
    }
    if(pathname==='/api/tests'&&req.method==='POST'){
      let body='';for await(const c of req){body+=c;if(body.length>2000){res.destroy();return;}}
      try { 
        const user=await verifiedUser(req);
        const {url}=JSON.parse(body); 
        const valid=await validateTarget(url); 
        const jobs=await reconcileStaleJobs(180000);
        const ownerId = user.uid;
        const active=jobs.filter(j=>j.owner===ownerId&&(j.status==='running'||j.status==='queued')).length;
        if(active>=Number(process.env.FLIQ_MAX_ACTIVE_TESTS||1))return send(res,429,{error:'You already have an active test. Wait for it to finish before starting another.'});
        const since=Date.now()-86400000;
        const daily=jobs.filter(j=>j.owner===ownerId&&Date.parse(j.createdAt)>since).length;
        if(daily>=Number(process.env.FLIQ_DAILY_TEST_LIMIT||5))return send(res,429,{error:'Your daily test limit has been reached. Try again tomorrow.'});
        const job={id:randomUUID(),url:valid.url,hostname:valid.hostname,status:'queued',progress:0,stage:'Queued',createdAt:new Date().toISOString(),owner:ownerId,isDemo:false}; 
        jobs.unshift(job); 
        await saveDB(jobs); 
        if(adminApp && cloud() && user.uid!=='local'){
          try { await cloud().collection('tests').doc(job.id).set(job); }
          catch(fsErr) { console.error('[FLIQ] Initial Firestore test save warning:', fsErr.message); }
        }
        send(res,202,job); 
        executeTest(job).catch(err => console.error('[FLIQ] Background test execution error:', err));
      }
      catch(e){send(res,e.status||400,{error:e.message||'Invalid request.'});} return;
    }
    const sseMatch = pathname.match(/^\/api\/tests\/([\w-]+)\/events$/);
    if (sseMatch && req.method === 'GET') {
      const testId = sseMatch[1];
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write(': connected\n\n');

      if (!sseSubscribers.has(testId)) {
        sseSubscribers.set(testId, new Set());
      }
      const set = sseSubscribers.get(testId);
      set.add(res);

      const heartbeat = setInterval(() => {
        try { res.write(': keep-alive\n\n'); } catch { clearInterval(heartbeat); }
      }, 15000);

      try {
        const localDb = await readDB();
        const current = localDb.find(x => x.id === testId);
        if (current) {
          res.write(`event: scan-update\ndata: ${JSON.stringify(current)}\n\n`);
        }
      } catch {}

      req.on('close', () => {
        clearInterval(heartbeat);
        set.delete(res);
        if (set.size === 0) sseSubscribers.delete(testId);
      });
      return;
    }
    const liveShotMatch = pathname.match(/^\/api\/tests\/([\w-]+)\/live-screenshot$/);
    if (liveShotMatch && req.method === 'GET') {
      const testId = liveShotMatch[1];
      try {
        const user = await verifiedUser(req);
        let j = (await readDB()).find(x => x.id === testId);
        if (!j && adminApp && user.uid !== 'local') {
          const d = await cloud().collection('tests').doc(testId).get();
          if (d.exists) j = d.data();
        }
        if (!j) return send(res, 404, { error: 'Test not found.' });

        const isOwner = user.uid === j.owner;
        const isShared = Array.isArray(j.sharedWithUids) && j.sharedWithUids.includes(user.uid);
        if (!isOwner && !isShared && (adminApp || user.uid !== 'local' || j.owner !== 'local')) {
          return send(res, 403, { error: 'Access denied.' });
        }
      } catch (authErr) {
        return send(res, authErr.status || 401, { error: authErr.message });
      }

      const jpegFile = path.join(dataDir, `${testId}-live.jpeg`);
      const pngFile = path.join(dataDir, `${testId}-live.png`);
      const desktopFile = path.join(dataDir, `${testId}-desktop.png`);

      try {
        const b = await fs.readFile(jpegFile);
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          'cache-control': 'no-cache, no-store, must-revalidate',
          'access-control-allow-origin': origin && isOriginAllowed(origin) ? origin : '*'
        });
        return res.end(b);
      } catch {
        try {
          const b = await fs.readFile(pngFile);
          res.writeHead(200, {
            'content-type': 'image/png',
            'cache-control': 'no-cache, no-store, must-revalidate',
            'access-control-allow-origin': origin && isOriginAllowed(origin) ? origin : '*'
          });
          return res.end(b);
        } catch {
          try {
            const b = await fs.readFile(desktopFile);
            res.writeHead(200, {
              'content-type': 'image/png',
              'cache-control': 'no-cache, no-store, must-revalidate',
              'access-control-allow-origin': origin && isOriginAllowed(origin) ? origin : '*'
            });
            return res.end(b);
          } catch {
            return send(res, 404, { error: 'Live screenshot not ready.' });
          }
        }
      }
    }
    const shares=pathname.match(/^\/api\/tests\/([\w-]+)\/shares(?:\/([\w-]+))?$/);if(shares){
      try{const user=await verifiedUser(req);if(!adminApp||user.uid==='local')return send(res,503,{error:'Signed-in sharing requires Firebase Authentication and Firestore.'});const ref=cloud().collection('tests').doc(shares[1]),snap=await ref.get(),report=snap.exists?snap.data():null;if(!report||report.owner!==user.uid)return send(res,404,{error:'Test not found.'});const uids=Array.isArray(report.sharedWithUids)?report.sharedWithUids:[];
        if(req.method==='GET'){const recipients=await Promise.all(uids.map(async uid=>{try{const u=await getAuth(adminApp).getUser(uid);return {uid,email:u.email||''};}catch{return {uid,email:'Account unavailable'};}}));return send(res,200,{recipients});}
        if(req.method==='POST'){let body='';for await(const c of req){body+=c;if(body.length>2000){res.destroy();return;}}const email=String(JSON.parse(body).email||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return send(res,400,{error:'Enter a valid account email.'});let recipient;try{recipient=await getAuth(adminApp).getUserByEmail(email);}catch{return send(res,404,{error:'The recipient must create a FLIQ account before you can share this report.'});}if(recipient.uid===user.uid)return send(res,400,{error:'This report already belongs to your account.'});if(!uids.includes(recipient.uid)){uids.push(recipient.uid);await ref.set({sharedWithUids:uids},{merge:true});const local=await readDB(),idx=local.findIndex(x=>x.id===shares[1]);if(idx>=0){local[idx].sharedWithUids=uids;await saveDB(local);}}return send(res,200,{uid:recipient.uid,email:recipient.email||email,shared:true});}
        if(req.method==='DELETE'&&shares[2]){const next=uids.filter(uid=>uid!==shares[2]);await ref.set({sharedWithUids:next},{merge:true});const local=await readDB(),idx=local.findIndex(x=>x.id===shares[1]);if(idx>=0){local[idx].sharedWithUids=next;await saveDB(local);}return send(res,200,{revoked:true});}
        return send(res,405,{error:'Method not allowed.'});
      }catch(e){return send(res,e.status||400,{error:e.message});}
    }
    const regen=pathname.match(/^\/api\/tests\/([\w-]+)\/regenerate-ai$/);
    if(regen&&req.method==='POST'){
      try{
        const user=await verifiedUser(req);
        const testId=regen[1];
        let testDoc=null;
        const localDb=await readDB();
        const localIdx=localDb.findIndex(x=>x.id===testId);
        if(adminApp && cloud() && user.uid!=='local'){
          const snap=await cloud().collection('tests').doc(testId).get();
          if(snap.exists)testDoc=snap.data();
        }
        if(!testDoc&&localIdx>=0)testDoc=localDb[localIdx];
        if(!testDoc||(testDoc.owner!==user.uid&&!(testDoc.sharedWithUids||[]).includes(user.uid)))return send(res,404,{error:'Test not found or access denied.'});
        if(testDoc.status!=='completed')return send(res,400,{error:'Explanations can only be generated for completed scans.'});
        const aiResult=await generateAIReport(Array.isArray(testDoc.issues)?testDoc.issues:[], testDoc.finalUrl || testDoc.url || '');
        testDoc.aiSummary=aiResult.aiSummary;
        testDoc.issues=aiResult.issues;
        testDoc.isAiGenerated=Boolean(aiResult.isAiGenerated);
        testDoc.aiGeneratedAt=new Date().toISOString();
        if(adminApp && cloud() && user.uid!=='local'){
          try{await cloud().collection('tests').doc(testId).set({aiSummary:testDoc.aiSummary,issues:testDoc.issues,isAiGenerated:testDoc.isAiGenerated,aiGeneratedAt:testDoc.aiGeneratedAt},{merge:true});}catch(fsErr){console.error('[FLIQ] Firestore update warning in regenerate-ai:',fsErr.message);}
        }
        if(localIdx>=0){
          localDb[localIdx].aiSummary=testDoc.aiSummary;
          localDb[localIdx].issues=testDoc.issues;
          localDb[localIdx].isAiGenerated=testDoc.isAiGenerated;
          localDb[localIdx].aiGeneratedAt=testDoc.aiGeneratedAt;
          await saveDB(localDb);
        }
        return send(res,200,{success:true,aiSummary:testDoc.aiSummary,issues:testDoc.issues,isAiGenerated:testDoc.isAiGenerated,aiGeneratedAt:testDoc.aiGeneratedAt});
      }catch(e){return send(res,e.status||500,{error:e.message});}
    }
    const m=pathname.match(/^\/api\/tests\/([\w-]+)$/); 
    if(m&&req.method==='GET'){
      try{
        const user=await verifiedUser(req);
        let j;
        if(adminApp && cloud() && user.uid!=='local'){
          try {
            const d=await cloud().collection('tests').doc(m[1]).get();
            j=d.exists?d.data():null;
          } catch(fsErr) {
            console.warn('[FLIQ] Firestore test doc fetch warning:', fsErr.message);
          }
        }
        if(!j) j=(await readDB()).find(x=>x.id===m[1]);
        if(!j) return send(res,404,{error:'Test not found.'});

        const isOwner = user.uid === j.owner;
        const isShared = (j.sharedWithUids||[]).includes(user.uid);

        if(!isOwner && !isShared && (adminApp || user.uid !== 'local' || j.owner !== 'local')) {
          return send(res,404,{error:'Test not found or access denied.'});
        }
        const {owner,sharedWithUids,...safe}=j;
        return send(res,200,{...safe,canManageSharing:isOwner});
      }catch(e){return send(res,e.status||401,{error:e.message});}
    }
    const sm=pathname.match(/^\/api\/screenshots\/([\w-]+\.png)$/); 
    if(sm){
      try{
        const user=await verifiedUser(req);
        const id=sm[1].replace(/-(desktop|tablet|mobile)\.png$/,'');
        let j=(await readDB()).find(x=>x.id===id);
        if(!j&&adminApp&&user.uid!=='local'){
          const d=await cloud().collection('tests').doc(id).get();
          if(d.exists) j=d.data();
        }
        if(!j) return send(res,404,{error:'Screenshot not found.'});

        const isOwner = user.uid === j.owner;
        const isShared = (j.sharedWithUids||[]).includes(user.uid);

        if(!isOwner && !isShared && (adminApp || user.uid !== 'local' || j.owner !== 'local')) {
          return send(res,404,{error:'Screenshot not found.'});
        }
        const b=await fs.readFile(path.join(dataDir,path.basename(sm[1])));
        res.writeHead(200,{'content-type':'image/png','cache-control':'no-store'});
        return res.end(b);
      }catch(e){return send(res,e.status||404,{error:'Screenshot not found.'});}
    }
    return send(res,404,{error:'Not found.'});
  }
  let file=pathname==='/'?path.join(root,'index.html'):path.resolve(root,decodeURIComponent(pathname.slice(1))); if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
  if(pathname!=='/'&&!file.startsWith(path.resolve(root,'public')+path.sep)){const publicFile=path.resolve(root,'public',decodeURIComponent(pathname.slice(1)));try{await fs.access(publicFile);file=publicFile;}catch{}}
  try{const b=await fs.readFile(file);res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream'});res.end(b);}catch{const b=await fs.readFile(path.join(root,'index.html'));res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(b);}
});
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

export async function runAllSuitesSequentially() {
  try {
    const a11y = await runA11yRegressionSuite();
    console.log(`[FLIQ] Accessibility Regression Suite executed: ${a11y.passedTests}/${a11y.totalTests} passed in ${a11y.durationMs}ms`);
  } catch (err) {
    console.error('[FLIQ] Accessibility Regression Suite error:', err.message);
  }
  try {
    const demo = await runDemoWorkflowTests();
    console.log(`[FLIQ] Demo Workflow Test Suite executed: ${demo.passedTests}/${demo.totalTests} passed`);
  } catch (err) {
    console.error('[FLIQ] Demo Workflow Test Suite error:', err.message);
  }
  try {
    const auth = await runAuthWorkflowTests();
    console.log(`[FLIQ] Auth-First Workflow Test Suite executed: ${auth.passedTests}/${auth.totalTests} passed in ${auth.durationMs}ms`);
  } catch (err) {
    console.error('[FLIQ] Auth-First Workflow Test Suite error:', err.message);
  }
  try {
    const logo = await runLogoNavigationTests();
    console.log(`[FLIQ] Logo Navigation Test Suite executed: ${logo.passedTests}/${logo.totalTests} passed in ${logo.durationMs}ms`);
  } catch (err) {
    console.error('[FLIQ] Logo Navigation Test Suite error:', err.message);
  }
  try {
    const ai = await runAIResilienceTests();
    console.log(`[FLIQ] AI Resilience Test Suite executed: ${ai.passedTests}/${ai.totalTests} passed in ${ai.durationMs}ms`);
  } catch (err) {
    console.error('[FLIQ] AI Resilience Test Suite error:', err.message);
  }
  try {
    const live = await runLiveInspectionTests();
    console.log(`[FLIQ] Live Inspection Test Suite executed: ${live.passedTests}/${live.totalTests} passed in ${live.durationMs}ms`);
  } catch (err) {
    console.error('[FLIQ] Live Inspection Test Suite error:', err.message);
  }
  try {
    const rep = await runReportConsistencyTests();
    console.log(`[FLIQ] Report Consistency Test Suite executed: ${rep.passedTests}/${rep.totalTests} passed in ${rep.durationMs}ms`);
  } catch (err) {
    console.error('[FLIQ] Report Consistency Test Suite error:', err.message);
  }
  try {
    const pricing = await runPricingVerificationTests();
    console.log(`[FLIQ] Pricing Verification Test Suite executed: ${pricing.passedTests}/${pricing.totalTests} passed in ${pricing.durationMs}ms`);
  } catch (err) {
    console.error('[FLIQ] Pricing Verification Test Suite error:', err.message);
  }
  try {
    const pAuth = await runPricingAuthTests();
    console.log(`[FLIQ] Pricing & Auth Integration Test Suite executed: ${pAuth.passedTests}/${pAuth.totalTests} passed in ${pAuth.durationMs}ms`);
  } catch (err) {
    console.error('[FLIQ] Pricing & Auth Integration Test Suite error:', err.message);
  }
}

export function startServer(port = PORT, host = HOST) {
  return new Promise((resolve, reject) => {
    server.listen(port, host, (err) => {
      if (err) return reject(err);
      console.log(`FLIQ ready on http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
      resolve(server);
    });
  });
}

export function closeServer() {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

export { server, PORT, HOST, handlePolarCheckoutRequest, createPolarCheckoutSession, resolvePolarProductId };

const isMain = process.argv[1] && (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
  startServer().then(() => {
    if (playwrightAvailable && process.env.NODE_ENV !== 'production' && process.env.FLIQ_RUN_SUITES_ON_START !== 'false') {
      runAllSuitesSequentially().catch(err => console.error('[FLIQ] Test runner sequence error:', err));
    }
  }).catch(err => {
    console.error('[FLIQ] Failed to start server:', err.message);
  });

  const handleShutdown = (signal) => {
    console.log(`[FLIQ] Received ${signal}. Closing server gracefully...`);
    closeServer().then(() => {
      console.log('[FLIQ] HTTP server closed cleanly. Exiting.');
      process.exit(0);
    }).catch(() => {
      process.exit(1);
    });
    setTimeout(() => {
      console.error('[FLIQ] Forceful shutdown timeout exceeded.');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    console.error('[FLIQ] Unhandled Promise Rejection (safely caught):', reason instanceof Error ? reason.stack : reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[FLIQ] Uncaught Exception (safely caught):', err?.stack || err?.message || String(err));
  });
}


