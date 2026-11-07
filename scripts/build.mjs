import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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
const projectId = process.env.FIREBASE_PROJECT_ID?.trim() || process.env.GCLOUD_PROJECT?.trim() || '';
const authDomain = process.env.FIREBASE_AUTH_DOMAIN?.trim() || (projectId ? `${projectId}.firebaseapp.com` : '');
const messagingSenderId = process.env.FIREBASE_MESSAGING_SENDER_ID?.trim() || '';
const appId = process.env.FIREBASE_APP_ID?.trim() || '';

const apiUrl = process.env.FLIQ_BACKEND_URL?.trim() || process.env.FLIQ_API_URL?.trim() || (process.env.CF_PAGES ? 'https://fliq-ezaz.onrender.com' : '');

const config = {
  apiKey,
  authDomain,
  projectId,
  messagingSenderId,
  appId,
  apiUrl
};

console.log('[FLIQ Build] Preparing client configuration for multi-platform deployment (Cloudflare Pages / Vercel / Netlify / Custom)...');
console.log(`[FLIQ Build] Project ID: ${projectId}`);
console.log(`[FLIQ Build] Auth Domain: ${authDomain}`);
console.log(`[FLIQ Build] API Key present: ${Boolean(apiKey)} (${apiKey ? apiKey.slice(0, 6) + '...' : 'not set'})`);
console.log(`[FLIQ Build] App ID present: ${Boolean(appId)}`);
console.log(`[FLIQ Build] Sender ID present: ${Boolean(messagingSenderId)}`);
console.log(`[FLIQ Build] Backend API URL: ${apiUrl || '(relative /api same-origin)'}`);

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
  } else if (process.env.FLIQ_TESTS_URL) {
    try {
      console.log('[FLIQ Build] Fetching test seed data from secure FLIQ_TESTS_URL...');
      const res = await fetch(process.env.FLIQ_TESTS_URL);
      if (res.ok) {
        const text = await res.text();
        fs.writeFileSync(localTestsDest, text, 'utf8');
        console.log('[FLIQ Build] Successfully downloaded and packaged tests.json from secure URL.');
      }
    } catch (e) {
      console.warn('[FLIQ Build] Notice fetching FLIQ_TESTS_URL:', e.message);
    }
  } else if (process.env.FLIQ_SEED_TESTS_BASE64) {
    try {
      const buf = Buffer.from(process.env.FLIQ_SEED_TESTS_BASE64, 'base64');
      let text = '';
      if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        text = zlib.gunzipSync(buf).toString('utf8');
      } else {
        text = buf.toString('utf8');
      }
      fs.writeFileSync(localTestsDest, text, 'utf8');
      console.log('[FLIQ Build] Wrote tests.json from FLIQ_SEED_TESTS_BASE64 environment variable.');
    } catch (e) {
      console.warn('[FLIQ Build] Notice writing tests.json from base64:', e.message);
    }
  } else if (process.env.FLIQ_SEED_TESTS_JSON) {
    try {
      fs.writeFileSync(localTestsDest, process.env.FLIQ_SEED_TESTS_JSON, 'utf8');
      console.log('[FLIQ Build] Wrote tests.json from FLIQ_SEED_TESTS_JSON environment variable.');
    } catch (e) {
      console.warn('[FLIQ Build] Notice writing seeded tests.json:', e.message);
    }
  }

  if (!fs.existsSync(localTestsDest)) {
    console.warn('[FLIQ Build Warning] No test records packaged into netlify/functions/tests.json.');
    console.warn('[FLIQ Build Warning] In a clean Netlify Git checkout, set FLIQ_TESTS_URL in environment variables to automatically download test reports during build.');
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

// 7. Ensure clean _redirects file for static hosting without conflicting rewrite loops
const cleanRedirectsContent = `# FLIQ Static Routing Configuration
# Client-side SPA routing is handled natively by Cloudflare Pages, Netlify, and Vercel.
# Conflicting rewrite rules are omitted to prevent Cloudflare redirect loops [code: 100324].
`;
fs.writeFileSync(path.join(root, '_redirects'), cleanRedirectsContent, 'utf8');
fs.writeFileSync(path.join(publicDir, '_redirects'), cleanRedirectsContent, 'utf8');
console.log('[FLIQ Build] Wrote clean _redirects without 200 rewrite loops.');

// 8. Generate 200.html for native Cloudflare Pages SPA fallback handling
const indexHtmlPath = path.join(root, 'index.html');
if (fs.existsSync(indexHtmlPath)) {
  const indexContent = fs.readFileSync(indexHtmlPath, 'utf8');
  fs.writeFileSync(path.join(root, '200.html'), indexContent, 'utf8');
  fs.writeFileSync(path.join(publicDir, '200.html'), indexContent, 'utf8');
  console.log('[FLIQ Build] Generated 200.html for native Cloudflare Pages SPA fallback.');
}

// 9. Ensure Cloudflare Pages wrangler.jsonc configuration exists
const wranglerPath = path.join(root, 'wrangler.jsonc');
const pagesWranglerConfig = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: "fliq",
  compatibility_date: "2026-11-04",
  pages_build_output_dir: "."
};
fs.writeFileSync(wranglerPath, JSON.stringify(pagesWranglerConfig, null, 2), 'utf8');
console.log('[FLIQ Build] Wrote wrangler.jsonc for Cloudflare Pages (pages_build_output_dir: .).');

const vercelConfigPath = path.join(root, 'vercel.json');
if (!fs.existsSync(vercelConfigPath)) {
  const vercelConfig = {
    version: 2,
    rewrites: [
      {
        source: '/((?!api/.*|.*\\..*).*)',
        destination: '/index.html'
      }
    ]
  };
  fs.writeFileSync(vercelConfigPath, JSON.stringify(vercelConfig, null, 2), 'utf8');
  console.log('[FLIQ Build] Wrote vercel.json for Vercel SPA routing.');
}

console.log('[FLIQ Build] Complete. Frontend is ready for deployment on Cloudflare Pages, Vercel, Netlify, or custom hosting.');
