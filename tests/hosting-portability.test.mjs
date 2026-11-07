import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOriginAllowed, parseConcurrentScans } from '../server.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe('FLIQ Multi-Platform Hosting Portability Test Suite', () => {

  describe('1. Static Hosting Configuration Files', () => {
    test('Root and public _redirects files omit conflicting 200 rewrite rules to avoid Cloudflare code 100324', () => {
      const rootRedirectsPath = path.join(root, '_redirects');
      assert.equal(fs.existsSync(rootRedirectsPath), true, '_redirects must exist at repository root');
      const rootContent = fs.readFileSync(rootRedirectsPath, 'utf8');
      assert.equal(rootContent.includes(' 200') || rootContent.includes('\t200'), false, 'Root _redirects must not contain 200 rewrite rules that cause loop error 100324');

      const publicRedirectsPath = path.join(root, 'public', '_redirects');
      assert.equal(fs.existsSync(publicRedirectsPath), true, 'public/_redirects must exist');
      const publicContent = fs.readFileSync(publicRedirectsPath, 'utf8');
      assert.equal(publicContent.includes(' 200') || publicContent.includes('\t200'), false, 'public/_redirects must not contain 200 rewrite rules that cause loop error 100324');
    });

    test('200.html exists in root and public for native Cloudflare Pages SPA fallback', () => {
      const root200Path = path.join(root, '200.html');
      assert.equal(fs.existsSync(root200Path), true, '200.html must exist at repository root');
      const public200Path = path.join(root, 'public', '200.html');
      assert.equal(fs.existsSync(public200Path), true, 'public/200.html must exist');
    });

    test('wrangler.jsonc is configured exclusively for Cloudflare Pages without Workers assets', () => {
      const wranglerPath = path.join(root, 'wrangler.jsonc');
      assert.equal(fs.existsSync(wranglerPath), true, 'wrangler.jsonc must exist at repository root');
      const raw = fs.readFileSync(wranglerPath, 'utf8');
      const cfg = JSON.parse(raw);
      assert.equal(cfg.pages_build_output_dir, '.', 'wrangler.jsonc must set pages_build_output_dir to .');
      assert.equal('assets' in cfg, false, 'wrangler.jsonc must not contain Workers assets configuration');
    });

    test('vercel.json exists with valid SPA rewrite configuration', () => {
      const vercelPath = path.join(root, 'vercel.json');
      assert.equal(fs.existsSync(vercelPath), true, 'vercel.json must exist at repository root');
      const raw = fs.readFileSync(vercelPath, 'utf8');
      const config = JSON.parse(raw);
      assert.equal(config.version, 2, 'vercel.json must be version 2');
      assert.equal(Array.isArray(config.rewrites), true, 'vercel.json must contain rewrites array');
      const spaRewrite = config.rewrites.find(r => r.destination === '/index.html');
      assert.ok(spaRewrite, 'vercel.json must contain rewrite to /index.html');
    });
  });

  describe('2. CORS Origin Validation (server.js)', () => {
    test('Permits localhost and 127.0.0.1 origins for local development and tests', () => {
      assert.equal(isOriginAllowed('http://localhost:3000', ''), true);
      assert.equal(isOriginAllowed('http://127.0.0.1:3000', ''), true);
      assert.equal(isOriginAllowed('http://localhost:5173', ''), true);
      assert.equal(isOriginAllowed('http://localhost', ''), true);
    });

    test('Permits explicitly configured production origins', () => {
      const allowedEnv = 'https://fliq.example.com,https://dashboard.fliq.io';
      assert.equal(isOriginAllowed('https://fliq.example.com', allowedEnv), true);
      assert.equal(isOriginAllowed('https://dashboard.fliq.io', allowedEnv), true);
      assert.equal(isOriginAllowed('https://other.example.com', allowedEnv), false);
    });

    test('Permits wildcard preview domains (Cloudflare Pages, Vercel, Netlify)', () => {
      const allowedEnv = 'https://fliq.io,*.pages.dev,*.vercel.app,*.netlify.app';
      assert.equal(isOriginAllowed('https://fliq-preview-123.pages.dev', allowedEnv), true);
      assert.equal(isOriginAllowed('https://fliq-git-feature.vercel.app', allowedEnv), true);
      assert.equal(isOriginAllowed('https://deploy-preview-42.netlify.app', allowedEnv), true);
      assert.equal(isOriginAllowed('https://malicious-pages.dev.attacker.com', allowedEnv), false);
      assert.equal(isOriginAllowed('https://attacker.com', allowedEnv), false);
    });

    test('Rejects missing or null origins gracefully', () => {
      assert.equal(isOriginAllowed(null, 'https://fliq.io'), false);
      assert.equal(isOriginAllowed('', 'https://fliq.io'), false);
      assert.equal(isOriginAllowed(undefined, 'https://fliq.io'), false);
    });

    test('Case-insensitivity and whitespace trimming for origins', () => {
      const allowedEnv = ' https://FLIQ.io , https://App.Fliq.io ';
      assert.equal(isOriginAllowed('https://fliq.io', allowedEnv), true);
      assert.equal(isOriginAllowed('https://app.fliq.io', allowedEnv), true);
    });

    test('Permits exact FLIQ Cloudflare Pages stable production domain and deployment alias', () => {
      const prodEnv = 'https://fliq-app-ava.pages.dev,https://66ee22bf.fliq-app-ava.pages.dev';
      assert.equal(isOriginAllowed('https://fliq-app-ava.pages.dev', prodEnv), true);
      assert.equal(isOriginAllowed('https://66ee22bf.fliq-app-ava.pages.dev', prodEnv), true);
      assert.equal(isOriginAllowed('https://other.pages.dev', prodEnv), false);
      assert.equal(isOriginAllowed('https://attacker.com', prodEnv), false);

      // Preferred standalone stable production domain configuration
      const stableOnlyEnv = 'https://fliq-app-ava.pages.dev';
      assert.equal(isOriginAllowed('https://fliq-app-ava.pages.dev', stableOnlyEnv), true);
      assert.equal(isOriginAllowed('https://66ee22bf.fliq-app-ava.pages.dev', stableOnlyEnv), false);
    });

    test('Rejects localhost in production when not in FLIQ_ALLOWED_ORIGINS', () => {
      const prevEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        const prodEnv = 'https://fliq-app-ava.pages.dev,https://66ee22bf.fliq-app-ava.pages.dev';
        assert.equal(isOriginAllowed('http://localhost:3000', prodEnv), false);
        assert.equal(isOriginAllowed('http://127.0.0.1:3000', prodEnv), false);
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    });
  });

  describe('3. FLIQ_CONCURRENT_SCANS Validation (server.js)', () => {
    test('Defaults to 1 in production and 3 in development when undefined or empty', () => {
      assert.equal(parseConcurrentScans(undefined, 'production'), 1);
      assert.equal(parseConcurrentScans('', 'production'), 1);
      assert.equal(parseConcurrentScans(undefined, 'development'), 3);
      assert.equal(parseConcurrentScans('', 'development'), 3);
    });

    test('Accepts valid positive integers up to maximum of 3', () => {
      assert.equal(parseConcurrentScans('1', 'production'), 1);
      assert.equal(parseConcurrentScans('2', 'production'), 2);
      assert.equal(parseConcurrentScans('3', 'production'), 3);
      assert.equal(parseConcurrentScans('  2  ', 'development'), 2);
    });

    test('Enforces maximum concurrency of 3, falling back to environment default if exceeded', () => {
      assert.equal(parseConcurrentScans('4', 'production'), 1);
      assert.equal(parseConcurrentScans('5', 'development'), 3);
      assert.equal(parseConcurrentScans('100', 'production'), 1);
    });

    test('Rejects negative values, zero, and floats, falling back to environment default', () => {
      assert.equal(parseConcurrentScans('-1', 'production'), 1);
      assert.equal(parseConcurrentScans('-5', 'development'), 3);
      assert.equal(parseConcurrentScans('0', 'production'), 1);
      assert.equal(parseConcurrentScans('0', 'development'), 3);
      assert.equal(parseConcurrentScans('1.5', 'production'), 1);
      assert.equal(parseConcurrentScans('2.7', 'development'), 3);
    });

    test('Rejects non-numeric strings, NaN, and invalid inputs safely', () => {
      assert.equal(parseConcurrentScans('abc', 'production'), 1);
      assert.equal(parseConcurrentScans('invalid', 'development'), 3);
      assert.equal(parseConcurrentScans(null, 'production'), 1);
    });
  });

  describe('4. Centralized API Configuration & Secret Isolation', () => {
    test('Client firebase-config.json never leaks backend secrets', () => {
      const cfgPath = path.join(root, 'firebase-config.json');
      if (fs.existsSync(cfgPath)) {
        const raw = fs.readFileSync(cfgPath, 'utf8');
        const cfg = JSON.parse(raw);
        assert.equal('private_key' in cfg, false, 'Client config must never contain private_key');
        assert.equal('client_email' in cfg, false, 'Client config must never contain client_email');
        assert.equal('FLIQ_INTERNAL_SECRET' in cfg, false, 'Client config must never contain FLIQ_INTERNAL_SECRET');
        assert.equal('apiUrl' in cfg, true, 'Client config must have apiUrl field for centralized backend URL');
      }
    });

    test('Client firebase-config.js defines window.__FLIQ_FIREBASE_CONFIG__ with apiUrl', () => {
      const jsPath = path.join(root, 'firebase-config.js');
      if (fs.existsSync(jsPath)) {
        const js = fs.readFileSync(jsPath, 'utf8');
        assert.match(js, /window\.__FLIQ_FIREBASE_CONFIG__\s*=/, 'firebase-config.js must define window.__FLIQ_FIREBASE_CONFIG__');
        assert.match(js, /"apiUrl"/, 'firebase-config.js must include apiUrl property');
      }
    });
  });

  describe('5. Frontend App API Resolution (app.js)', () => {
    test('app.js defines centralized getApiBase() supporting FLIQ_BACKEND_URL and relative /api', () => {
      const appJsPath = path.join(root, 'app.js');
      const content = fs.readFileSync(appJsPath, 'utf8');
      assert.match(content, /function\s+getApiBase\s*\(\)/, 'app.js must define getApiBase() function');
      assert.match(content, /apiFetch\s*\(/, 'app.js must define centralized apiFetch() function');
      assert.match(content, /new\s+EventSource\s*\(\s*sseUrl\s*\)/, 'subscribeLiveScan must use resolved backend sseUrl');
    });
  });

  describe('6. Production Docker & Firestore Dependency Integrity', () => {
    test('package.json and package-lock.json are synchronized with @google-cloud/firestore', () => {
      const pkgPath = path.join(root, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      assert.ok(pkg.dependencies['@google-cloud/firestore'], '@google-cloud/firestore must be declared in dependencies');
      assert.ok(pkg.dependencies['firebase-admin'], 'firebase-admin must be declared in dependencies');

      const lockPath = path.join(root, 'package-lock.json');
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.ok(lock.packages[''].dependencies['@google-cloud/firestore'], 'package-lock.json root must declare @google-cloud/firestore');
      assert.ok(lock.packages['node_modules/@google-cloud/firestore'], 'package-lock.json must contain node_modules/@google-cloud/firestore');
      assert.equal(lock.packages['node_modules/@google-cloud/firestore'].optional, undefined, '@google-cloud/firestore must not be optional');
    });

    test('Firebase Admin can resolve and import firebase-admin/firestore', async () => {
      const { getFirestore } = await import('firebase-admin/firestore');
      assert.equal(typeof getFirestore, 'function', 'getFirestore must be an exported function from firebase-admin/firestore');
    });

    test('Dockerfile specifies node:22-bookworm-slim, npm ci --omit=dev, and installs all required Chromium libraries', () => {
      const dockerfilePath = path.join(root, 'Dockerfile');
      const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
      assert.match(dockerfile, /FROM\s+node:22-bookworm-slim/, 'Dockerfile must use node:22-bookworm-slim for Node 22 compatibility');
      assert.match(dockerfile, /npm\s+ci\s+--omit=dev/, 'Dockerfile must install production dependencies using npm ci --omit=dev');
      assert.match(dockerfile, /npx\s+playwright\s+install\s+chromium/, 'Dockerfile must download Chromium browser');

      const requiredAptLibs = [
        'ca-certificates', 'fonts-liberation', 'libasound2', 'libatk-bridge2.0-0',
        'libatk1.0-0', 'libcairo2', 'libcups2', 'libdbus-1-3', 'libdrm2',
        'libgbm1', 'libglib2.0-0', 'libgtk-3-0', 'libnspr4', 'libnss3',
        'libpango-1.0-0', 'libx11-6', 'libx11-xcb1', 'libxcb1', 'libxcomposite1',
        'libxcursor1', 'libxdamage1', 'libxext6', 'libxfixes3', 'libxi6',
        'libxrandr2', 'libxrender1', 'libxss1', 'libxtst6'
      ];
      for (const lib of requiredAptLibs) {
        assert.ok(dockerfile.includes(lib), `Dockerfile must install ${lib} for headless Chromium`);
      }

      assert.match(dockerfile, /CMD\s+\["node",\s*"server\.js"\]/, 'Dockerfile must have CMD ["node", "server.js"] to launch server');
    });

    test('Docker container default networking binds PORT=3000 and HOST=0.0.0.0', () => {
      const dockerfilePath = path.join(root, 'Dockerfile');
      const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
      assert.match(dockerfile, /ENV\s+PORT=3000/, 'Dockerfile must declare ENV PORT=3000');
      assert.match(dockerfile, /ENV\s+HOST=0\.0\.0\.0/, 'Dockerfile must declare ENV HOST=0.0.0.0');
      assert.match(dockerfile, /EXPOSE\s+3000/, 'Dockerfile must expose port 3000');
    });

    test('server.js exports PORT and HOST respecting container environment defaults', async () => {
      const { PORT, HOST } = await import('../server.js');
      assert.equal(typeof PORT, 'number', 'PORT must be exported as a number');
      assert.ok(PORT > 0 && PORT <= 65535, 'PORT must be a valid port number');
      assert.ok(HOST === '0.0.0.0' || HOST === '127.0.0.1' || HOST === 'localhost', 'HOST must be a valid host string');
    });
  });

  describe('7. Health Endpoint Telemetry & Firestore Connectivity Semantics', () => {
    test('checkFirestoreConnectivity safely handles unconfigured credentials without throwing', async () => {
      const { checkFirestoreConnectivity } = await import('../server.js');
      const result = await checkFirestoreConnectivity();
      assert.equal(typeof result, 'object', 'checkFirestoreConnectivity must return an object');
      assert.equal('connected' in result, true, 'result must have connected boolean field');
      assert.equal('error' in result, true, 'result must have error field');
    });
  });
});
