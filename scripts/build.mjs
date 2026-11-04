import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Try loading local .env if present (e.g. for local test builds)
try {
  if (process.loadEnvFile) {
    process.loadEnvFile(path.join(root, '.env'));
  }
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('[build] loadEnvFile notice:', e.message);
}

// Fallback manual .env parser if loadEnvFile did not populate process.env
try {
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
} catch {}

const apiKey = process.env.FIREBASE_WEB_API_KEY?.trim() || process.env.FIREBASE_API_KEY?.trim() || '';
const projectId = process.env.FIREBASE_PROJECT_ID?.trim() || 'fliq-61989';
const authDomain = process.env.FIREBASE_AUTH_DOMAIN?.trim() || (projectId ? `${projectId}.firebaseapp.com` : '');
const messagingSenderId = process.env.FIREBASE_MESSAGING_SENDER_ID?.trim() || '';
const appId = process.env.FIREBASE_APP_ID?.trim() || '';

const apiUrl = process.env.FLIQ_BACKEND_URL?.trim() || process.env.FLIQ_API_URL?.trim() || '';

const config = {
  apiKey,
  authDomain,
  projectId,
  messagingSenderId,
  appId,
  apiUrl
};

console.log('[FLIQ Build] Preparing client configuration for Netlify deployment...');
console.log(`[FLIQ Build] Project ID: ${projectId}`);
console.log(`[FLIQ Build] Auth Domain: ${authDomain}`);
console.log(`[FLIQ Build] API Key present: ${Boolean(apiKey)} (${apiKey ? apiKey.slice(0, 6) + '...' : 'not set'})`);
console.log(`[FLIQ Build] App ID present: ${Boolean(appId)}`);
console.log(`[FLIQ Build] Sender ID present: ${Boolean(messagingSenderId)}`);

// 1. Generate firebase-config.js (loaded synchronously in index.html before app.js)
const jsContent = `// Auto-generated client Firebase Web configuration
window.__FLIQ_FIREBASE_CONFIG__ = ${JSON.stringify(config, null, 2)};
`;
fs.writeFileSync(path.join(root, 'firebase-config.js'), jsContent, 'utf8');
console.log('[FLIQ Build] Wrote firebase-config.js');

// 2. Generate firebase-config.json
fs.writeFileSync(path.join(root, 'firebase-config.json'), JSON.stringify(config, null, 2), 'utf8');
console.log('[FLIQ Build] Wrote firebase-config.json');

// 3. Ensure public/ directory has the json config too
const publicDir = path.join(root, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}
fs.writeFileSync(path.join(publicDir, 'firebase-config.json'), JSON.stringify(config, null, 2), 'utf8');

// 4. Ensure api/ directory has static fallback for /api/firebase-config and /api/health
const apiDir = path.join(root, 'api');
if (!fs.existsSync(apiDir)) {
  fs.mkdirSync(apiDir, { recursive: true });
}
fs.writeFileSync(path.join(apiDir, 'firebase-config'), JSON.stringify({
  configured: Boolean(apiKey && projectId),
  missing: [
    ...(apiKey ? [] : ['FIREBASE_WEB_API_KEY']),
    ...(projectId ? [] : ['FIREBASE_PROJECT_ID']),
    ...(authDomain ? [] : ['FIREBASE_AUTH_DOMAIN']),
    ...(appId ? [] : ['FIREBASE_APP_ID']),
    ...(messagingSenderId ? [] : ['FIREBASE_MESSAGING_SENDER_ID'])
  ],
  config
}, null, 2), 'utf8');

fs.writeFileSync(path.join(apiDir, 'health'), JSON.stringify({
  ok: true,
  playwrightConfigured: false,
  firebaseConfigured: Boolean(apiKey && projectId),
  firebaseWebConfigured: Boolean(apiKey && projectId),
  firebaseWebMissing: [],
  firebaseAdminConfigured: false,
  credentialType: 'none',
  firebaseMissing: ['Backend container required for server-side scan execution'],
  authMode: 'firebase-client'
}, null, 2), 'utf8');

// 5. Ensure fliq-logo.png is at both root and public/
const logoSrc = path.join(publicDir, 'fliq-logo.png');
const logoDest = path.join(root, 'fliq-logo.png');
if (fs.existsSync(logoSrc) && !fs.existsSync(logoDest)) {
  try {
    fs.copyFileSync(logoSrc, logoDest);
    console.log('[FLIQ Build] Copied fliq-logo.png to root directory.');
  } catch (copyErr) {
    console.warn('[FLIQ Build] Logo copy notice:', copyErr.message);
  }
}

// 6. Ensure data/tests.json and screenshots are co-located with Netlify Functions
const functionsDir = path.join(root, 'netlify', 'functions');
if (fs.existsSync(functionsDir)) {
  const localTestsSrc = path.join(root, 'data', 'tests.json');
  const localTestsDest = path.join(functionsDir, 'tests.json');
  if (fs.existsSync(localTestsSrc)) {
    try {
      fs.copyFileSync(localTestsSrc, localTestsDest);
      console.log('[FLIQ Build] Copied data/tests.json to netlify/functions/tests.json');
    } catch (e) {
      console.warn('[FLIQ Build] Notice copying tests.json:', e.message);
    }
  }

  const funcDataDir = path.join(functionsDir, 'data');
  if (!fs.existsSync(funcDataDir)) {
    try { fs.mkdirSync(funcDataDir, { recursive: true }); } catch {}
  }
  const rootDataDir = path.join(root, 'data');
  if (fs.existsSync(rootDataDir)) {
    try {
      const files = fs.readdirSync(rootDataDir);
      for (const f of files) {
        if (f.endsWith('.png')) {
          fs.copyFileSync(path.join(rootDataDir, f), path.join(funcDataDir, f));
        }
      }
      console.log('[FLIQ Build] Synced screenshot assets to netlify/functions/data/');
    } catch (e) {
      console.warn('[FLIQ Build] Notice syncing screenshot assets:', e.message);
    }
  }
}

console.log('[FLIQ Build] Complete. Frontend is ready for Netlify.');
