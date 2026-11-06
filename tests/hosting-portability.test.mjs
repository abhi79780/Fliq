import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOriginAllowed } from '../server.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe('FLIQ Multi-Platform Hosting Portability Test Suite', () => {

  describe('1. Static Hosting Configuration Files', () => {
    test('Root _redirects file exists for Cloudflare Pages and Netlify SPA routing', () => {
      const redirectsPath = path.join(root, '_redirects');
      assert.equal(fs.existsSync(redirectsPath), true, '_redirects must exist at repository root');
      const content = fs.readFileSync(redirectsPath, 'utf8');
      assert.match(content, /\/\*\s+\/index\.html\s+200/, '_redirects must route /* to /index.html with status 200');
    });

    test('Public _redirects file exists for static publish directories', () => {
      const redirectsPath = path.join(root, 'public', '_redirects');
      assert.equal(fs.existsSync(redirectsPath), true, 'public/_redirects must exist');
      const content = fs.readFileSync(redirectsPath, 'utf8');
      assert.match(content, /\/\*\s+\/index\.html\s+200/, 'public/_redirects must route /* to /index.html with status 200');
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
  });

  describe('3. Centralized API Configuration & Secret Isolation', () => {
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

  describe('4. Frontend App API Resolution (app.js)', () => {
    test('app.js defines centralized getApiBase() supporting FLIQ_BACKEND_URL and relative /api', () => {
      const appJsPath = path.join(root, 'app.js');
      const content = fs.readFileSync(appJsPath, 'utf8');
      assert.match(content, /function\s+getApiBase\s*\(\)/, 'app.js must define getApiBase() function');
      assert.match(content, /apiFetch\s*\(/, 'app.js must define centralized apiFetch() function');
      assert.match(content, /new\s+EventSource\s*\(\s*sseUrl\s*\)/, 'subscribeLiveScan must use resolved backend sseUrl');
    });
  });
});
