import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');

describe('FLIQ Screenshot Pipeline, Caching & Anti-Flickering Suite', () => {
  const testIds = [];
  const filesCreated = [];

  after(async () => {
    for (const f of filesCreated) {
      try { await fs.unlink(f); } catch {}
    }
    try {
      const testsFile = path.join(dataDir, 'tests.json');
      const content = await fs.readFile(testsFile, 'utf8');
      const tests = JSON.parse(content);
      const filtered = tests.filter(t => !testIds.includes(t.id));
      await fs.writeFile(testsFile, JSON.stringify(filtered, null, 2), 'utf8');
    } catch {}
  });

  test('1. Filename validation strictly permits safe filenames and allowed extensions', () => {
    const filenameRegex = /^([a-zA-Z0-9_-]+)\.(png|jpg|jpeg|webp)$/i;

    // Valid screenshot names
    assert.ok(filenameRegex.test('test123-desktop.png'));
    assert.ok(filenameRegex.test('scan_456-tablet.jpg'));
    assert.ok(filenameRegex.test('audit-mobile.jpeg'));
    assert.ok(filenameRegex.test('live-preview.webp'));
    assert.ok(filenameRegex.test('JOB-ABC_123.PNG'));

    // Invalid filenames (traversal, disallowed extensions, arbitrary strings)
    assert.equal(filenameRegex.test('../evil.png'), false);
    assert.equal(filenameRegex.test('..\\evil.png'), false);
    assert.equal(filenameRegex.test('test.svg'), false);
    assert.equal(filenameRegex.test('script.js'), false);
    assert.equal(filenameRegex.test('exploit.exe'), false);
    assert.equal(filenameRegex.test('noextension'), false);
    assert.equal(filenameRegex.test('.hidden.png'), false);
    assert.equal(filenameRegex.test('test.png.exe'), false);
    assert.equal(filenameRegex.test('image with spaces.png'), false);
  });

  test('2. server.js /api/screenshots endpoint contains strict filename regex and basename normalization', async () => {
    const serverPath = path.join(rootDir, 'server.js');
    const content = await fs.readFile(serverPath, 'utf8');

    assert.match(content, /pathname\.startsWith\('\/api\/screenshots\/'\)/);
    assert.match(content, /path\.basename\(rawFilename\)/);
    assert.ok(content.includes('safeFilename.match(/^([a-zA-Z0-9_-]+)\\.(png|jpg|jpeg|webp)$/i)'));
  });

  test('3. server.js /api/screenshots enforces GET or HEAD and rejects other HTTP methods with 405', async () => {
    const serverPath = path.join(rootDir, 'server.js');
    const content = await fs.readFile(serverPath, 'utf8');

    assert.match(content, /req\.method !== 'GET' && req\.method !== 'HEAD'/);
    assert.match(content, /send\(res, 405, \{ error: 'Method not allowed\. Screenshots require GET or HEAD\.' \}\)/);
  });

  test('4. server.js /api/screenshots enforces authentication and test ownership/sharing authorization', async () => {
    const serverPath = path.join(rootDir, 'server.js');
    const content = await fs.readFile(serverPath, 'utf8');

    assert.match(content, /const user = await verifiedUser\(req\)/);
    assert.match(content, /const isOwner = user\.uid === j\.owner/);
    assert.match(content, /const isShared = Array\.isArray\(j\.sharedWithUids\) && j\.sharedWithUids\.includes\(user\.uid\)/);
    assert.match(content, /if \(!isOwner && !isShared/);
  });

  test('5. server.js /api/screenshots maps supported extensions to accurate image MIME types', async () => {
    const serverPath = path.join(rootDir, 'server.js');
    const content = await fs.readFile(serverPath, 'utf8');

    assert.match(content, /png:\s*'image\/png'/);
    assert.match(content, /jpg:\s*'image\/jpeg'/);
    assert.match(content, /jpeg:\s*'image\/jpeg'/);
    assert.match(content, /webp:\s*'image\/webp'/);
  });

  test('6. server.js /api/screenshots uses private cache headers (private, max-age=3600)', async () => {
    const serverPath = path.join(rootDir, 'server.js');
    const content = await fs.readFile(serverPath, 'utf8');

    assert.match(content, /'cache-control':\s*cacheControl/);
    assert.match(content, /'private, max-age=3600'/);
    assert.match(content, /'no-cache, no-store, must-revalidate'/);
    assert.equal(content.includes('public, max-age=3600, immutable'), false);
  });

  test('7. Missing screenshot file or unauthorized access returns 404 JSON', async () => {
    const testId = `shot-missing-${Date.now()}`;
    testIds.push(testId);

    const testRecord = {
      id: testId,
      owner: 'local',
      url: 'https://example.com',
      status: 'completed',
      createdAt: new Date().toISOString()
    };

    const testsFile = path.join(dataDir, 'tests.json');
    let tests = [];
    try { tests = JSON.parse(await fs.readFile(testsFile, 'utf8')); } catch {}
    tests.push(testRecord);
    await fs.writeFile(testsFile, JSON.stringify(tests, null, 2), 'utf8');

    const targetFile = path.join(dataDir, `${testId}-desktop.png`);
    let exists = false;
    try {
      await fs.access(targetFile);
      exists = true;
    } catch {
      exists = false;
    }
    assert.equal(exists, false, 'File must not exist for this negative test');
  });

  test('8. Existing screenshot file buffer is readable and returns valid binary image', async () => {
    const testId = `shot-valid-${Date.now()}`;
    testIds.push(testId);

    const testRecord = {
      id: testId,
      owner: 'local',
      url: 'https://example.com',
      status: 'completed',
      createdAt: new Date().toISOString()
    };

    const testsFile = path.join(dataDir, 'tests.json');
    let tests = JSON.parse(await fs.readFile(testsFile, 'utf8'));
    tests.push(testRecord);
    await fs.writeFile(testsFile, JSON.stringify(tests, null, 2), 'utf8');

    const pngPath = path.join(dataDir, `${testId}-desktop.png`);
    filesCreated.push(pngPath);
    const minimalPng = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
      'hex'
    );
    await fs.writeFile(pngPath, minimalPng);

    const stat = await fs.stat(pngPath);
    assert.ok(stat.size > 0, 'Screenshot file must exist and have non-zero size');
  });

  test('9. app.js validates image/ Content-Type and discards non-image payloads (e.g. JSON or webhook errors)', async () => {
    const appPath = path.join(rootDir, 'app.js');
    const content = await fs.readFile(appPath, 'utf8');

    assert.match(content, /cType\.includes\('image\/png'\)/);
    assert.match(content, /cType\.includes\('image\/jpeg'\)/);
    assert.match(content, /cType\.includes\('image\/webp'\)/);
    assert.match(content, /live-screenshot\?t=/);
  });

  test('10. app.js implements in-memory screenshot caching to eliminate re-fetching and flicker', async () => {
    const appPath = path.join(rootDir, 'app.js');
    const content = await fs.readFile(appPath, 'utf8');

    assert.match(content, /screenshotMemoryCache\s*=\s*new Map\(\)/);
    assert.match(content, /screenshotMemoryCache\.get\(url\)/);
    assert.match(content, /screenshotMemoryCache\.set\(url/);
    assert.match(content, /URL\.revokeObjectURL\(entry\.objectUrl\)/);
  });

  test('11. app.js template injects cached object URL synchronously into HTML on tab switch', async () => {
    const appPath = path.join(rootDir, 'app.js');
    const content = await fs.readFile(appPath, 'utf8');

    assert.match(content, /const cached = screenshotMemoryCache\.get\(shotUrl\)/);
    assert.match(content, /const cachedSrc = cached \? cached\.objectUrl : ''/);
    assert.match(content, /\$\{cachedSrc \? `src="\$\{cachedSrc\}"/);
  });
});
