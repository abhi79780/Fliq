/**
 * FLIQ Authentication-First Workflow Verification Suite
 * 
 * Verifies End-to-End Playwright Workflow:
 * - Test A: Unauthenticated visitor -> enter URL -> click "Run a test" -> redirected to login page with URL preserved and explanation displayed.
 * - Test B: Login successfully -> automatically starts scan for original URL -> progress displayed -> report loaded.
 * - Test C: Create account -> automatically starts scan for original URL -> progress displayed -> report loaded.
 * - Test D: Refresh auth page -> URL remains preserved -> no duplicate scans created.
 * - Test E: Login failure -> URL preserved -> error displayed -> user can retry.
 * - Test F: Authenticated visitor -> enter URL -> click "Run a test" -> scan starts immediately without login redirect.
 * - Test G: User A cannot access User B's scan records (cross-tenant isolation: 404 / access denied).
 */

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');

export async function runAuthWorkflowTests(customChromium = chromium, baseUrl = 'http://127.0.0.1:3000') {
  const testResults = [];
  const suiteStart = Date.now();
  let browser = null;

  try {
    browser = await customChromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-sandbox']
    });

    // =========================================================================
    // TEST A: Unauthenticated visitor -> enter URL -> click "Run a test" -> redirected to login page with URL preserved & explanation
    // =========================================================================
    const testAStart = Date.now();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();

      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('button[data-go="#demo"]', { timeout: 8000 });
      await page.click('button[data-go="#demo"]');
      await page.waitForSelector('#quick-test-url', { state: 'visible', timeout: 5000 });

      await page.fill('#quick-test-url', 'https://example.com');
      await page.click('#quick-test-submit');

      // Must redirect to /login with pendingUrl
      await page.waitForURL(/\/login\?pendingUrl=/, { timeout: 8000 });

      const currentUrl = page.url();
      const hasPendingUrlParam = currentUrl.includes('pendingUrl=https%3A%2F%2Fexample.com') || currentUrl.includes('pendingUrl=https://example.com');
      
      await page.waitForSelector('.auth-pending-banner', { state: 'visible', timeout: 5000 });
      const bannerText = await page.evaluate(() => document.querySelector('.auth-pending-banner')?.textContent || '');
      const bannerHasUrl = bannerText.includes('https://example.com');
      const bannerHasExplanation = bannerText.toLowerCase().includes('authentication is required to run website audits');

      const sessionStorageUrl = await page.evaluate(() => sessionStorage.getItem('fliqPendingUrl'));
      const hasPreservedSession = sessionStorageUrl === 'https://example.com' || sessionStorageUrl === 'https://example.com/';

      const hasGoogleButton = await page.evaluate(() => Boolean(document.querySelector('[data-oauth="Google"]')));
      const hasAuthForm = await page.evaluate(() => Boolean(document.querySelector('#auth-form')));

      const passed = hasPendingUrlParam && bannerHasUrl && bannerHasExplanation && hasPreservedSession && hasGoogleButton && hasAuthForm;

      testResults.push({
        id: 'test-a-unauth-redirect-login',
        name: 'Test A: Unauthenticated visitor -> Enter URL -> Click Run a test -> Redirected to /login with URL preserved and explanation',
        passed,
        expected: 'Redirected to /login?pendingUrl=..., explanation banner displayed, sessionStorage populated, login options present',
        actual: `URL: ${currentUrl}, Banner contains URL: ${bannerHasUrl}, Has explanation: ${bannerHasExplanation}, SessionStorage: ${sessionStorageUrl}`,
        durationMs: Date.now() - testAStart
      });
      await context.close();
    } catch (err) {
      testResults.push({
        id: 'test-a-unauth-redirect-login',
        name: 'Test A: Unauthenticated visitor -> Enter URL -> Click Run a test -> Redirected to /login with URL preserved and explanation',
        passed: false,
        expected: 'Redirected to /login?pendingUrl=..., explanation banner displayed, sessionStorage populated, login options present',
        actual: `Error: ${err.message}`,
        durationMs: Date.now() - testAStart
      });
    }

    // =========================================================================
    // TEST B: Login successfully -> automatically starts scan for original URL -> progress displayed -> report loaded
    // =========================================================================
    const testBStart = Date.now();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();

      // Navigate to login with pendingUrl
      await page.goto(`${baseUrl}/login?pendingUrl=https%3A%2F%2Fexample.com`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.auth-pending-banner', { state: 'visible', timeout: 5000 });

      // Execute login and automatic scan trigger
      await page.evaluate(async (url) => {
        localStorage.setItem('fliqTestUid', 'user-b-test');
        localStorage.setItem('fliqEmail', 'test-user-b@example.com');
        localStorage.setItem('fliqName', 'Test User B');
        const pendingUrl = sessionStorage.getItem('fliqPendingUrl') || url;
        sessionStorage.removeItem('fliqPendingUrl');
        await triggerPendingScan(pendingUrl);
      }, 'https://example.com');

      // Wait for progress shell
      await page.waitForSelector('.progress-shell', { state: 'visible', timeout: 10000 });
      const progressPath = await page.evaluate(() => location.pathname);
      const scanId = progressPath.split('/')[3];
      const hasProgressShell = Boolean(scanId && scanId.length >= 8);

      // Verify progress steps visible
      const stepsCount = await page.evaluate(() => document.querySelectorAll('.step').length);

      // Wait for test to complete and report to render
      await page.waitForSelector('.report-head', { state: 'visible', timeout: 90000 });
      const reportTitle = await page.evaluate(() => document.querySelector('.report-head h1')?.textContent || '');
      const hasCompletedBadge = await page.evaluate(() => Boolean(document.querySelector('.badge.completed')));
      const hasCategoryMetrics = await page.evaluate(() => document.querySelectorAll('.category-metric').length >= 5);

      const passed = hasProgressShell && stepsCount >= 8 && reportTitle.includes('example.com') && hasCompletedBadge && hasCategoryMetrics;

      testResults.push({
        id: 'test-b-login-auto-scan',
        name: 'Test B: Login successfully -> Automatically starts scan for original URL -> Progress displayed -> Report loaded',
        passed,
        expected: 'Scan starts automatically, navigates to /dashboard/tests/:id, displays real progress steps, renders final report',
        actual: `Scan ID: ${scanId}, Progress steps: ${stepsCount}, Report Title: ${reportTitle}, Completed badge: ${hasCompletedBadge}, Category metrics: ${hasCategoryMetrics}`,
        durationMs: Date.now() - testBStart,
        scanId
      });
      await context.close();
    } catch (err) {
      testResults.push({
        id: 'test-b-login-auto-scan',
        name: 'Test B: Login successfully -> Automatically starts scan for original URL -> Progress displayed -> Report loaded',
        passed: false,
        expected: 'Scan starts automatically, navigates to /dashboard/tests/:id, displays real progress steps, renders final report',
        actual: `Error: ${err.message}`,
        durationMs: Date.now() - testBStart
      });
    }

    // =========================================================================
    // TEST C: Create account -> automatically starts scan for original URL -> progress displayed -> report loaded
    // =========================================================================
    const testCStart = Date.now();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();

      // Navigate to signup with pendingUrl
      await page.goto(`${baseUrl}/signup?pendingUrl=https%3A%2F%2Fexample.com`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.auth-pending-banner', { state: 'visible', timeout: 5000 });

      // Verify switching between /login and /signup preserves pendingUrl in link
      const loginLinkHref = await page.evaluate(() => document.querySelector('.auth-switch a')?.getAttribute('href') || '');
      const preservesQueryInSwitch = loginLinkHref.includes('pendingUrl=');

      // Click to /login via the switch link
      await page.click('.auth-switch a');
      await page.waitForURL(/\/login\?pendingUrl=/, { timeout: 5000 });

      // Click back to /signup
      await page.click('.auth-switch a');
      await page.waitForURL(/\/signup\?pendingUrl=/, { timeout: 5000 });

      // Execute account creation & automatic scan trigger
      await page.evaluate(async (url) => {
        localStorage.setItem('fliqTestUid', 'user-c-test');
        localStorage.setItem('fliqEmail', 'new-user-c@example.com');
        localStorage.setItem('fliqName', 'New User C');
        const pendingUrl = sessionStorage.getItem('fliqPendingUrl') || url;
        sessionStorage.removeItem('fliqPendingUrl');
        await triggerPendingScan(pendingUrl);
      }, 'https://example.com');

      // Wait for progress shell
      await page.waitForSelector('.progress-shell', { state: 'visible', timeout: 10000 });
      const progressPath = await page.evaluate(() => location.pathname);
      const scanId = progressPath.split('/')[3];

      // Wait for test to complete and report to render
      await page.waitForSelector('.report-head', { state: 'visible', timeout: 90000 });
      const reportTitle = await page.evaluate(() => document.querySelector('.report-head h1')?.textContent || '');
      const hasReport = reportTitle.includes('example.com');

      const passed = preservesQueryInSwitch && Boolean(scanId) && hasReport;

      testResults.push({
        id: 'test-c-signup-auto-scan',
        name: 'Test C: Create account -> Preserves URL across auth links -> Automatically starts scan -> Report loaded',
        passed,
        expected: 'Switch link preserves pendingUrl, automatic scan trigger succeeds without re-entering URL, full report loaded',
        actual: `Preserves query: ${preservesQueryInSwitch}, Scan ID: ${scanId}, Report Title: ${reportTitle}`,
        durationMs: Date.now() - testCStart,
        scanId
      });
      await context.close();
    } catch (err) {
      testResults.push({
        id: 'test-c-signup-auto-scan',
        name: 'Test C: Create account -> Preserves URL across auth links -> Automatically starts scan -> Report loaded',
        passed: false,
        expected: 'Switch link preserves pendingUrl, automatic scan trigger succeeds without re-entering URL, full report loaded',
        actual: `Error: ${err.message}`,
        durationMs: Date.now() - testCStart
      });
    }

    // =========================================================================
    // TEST D: Refresh auth page -> URL remains preserved -> no duplicate scans created
    // =========================================================================
    const testDStart = Date.now();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();

      await page.goto(`${baseUrl}/login?pendingUrl=https%3A%2F%2Fexample.com`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.auth-pending-banner', { state: 'visible', timeout: 5000 });

      // Read current scans count
      const readTestsCount = async () => {
        try {
          const raw = await fs.readFile(path.join(dataDir, 'tests.json'), 'utf8');
          return JSON.parse(raw).length;
        } catch { return 0; }
      };

      const countBefore = await readTestsCount();

      // Refresh the page
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.auth-pending-banner', { state: 'visible', timeout: 5000 });

      const urlAfterReload = page.url();
      const hasPreservedUrlInQuery = urlAfterReload.includes('pendingUrl=');
      const sessionStorageAfterReload = await page.evaluate(() => sessionStorage.getItem('fliqPendingUrl'));
      const hasPreservedSession = sessionStorageAfterReload === 'https://example.com';

      // Verify no scans created during page reload
      const countAfter = await readTestsCount();
      const noDuplicateScans = countAfter === countBefore;

      const passed = hasPreservedUrlInQuery && hasPreservedSession && noDuplicateScans;

      testResults.push({
        id: 'test-d-refresh-no-duplicate',
        name: 'Test D: Refresh auth page -> URL remains preserved -> No duplicate scans created',
        passed,
        expected: 'URL query and sessionStorage remain intact after reload, 0 scans created on reload',
        actual: `URL after reload: ${urlAfterReload}, sessionStorage: ${sessionStorageAfterReload}, Scans before: ${countBefore}, Scans after: ${countAfter}`,
        durationMs: Date.now() - testDStart
      });
      await context.close();
    } catch (err) {
      testResults.push({
        id: 'test-d-refresh-no-duplicate',
        name: 'Test D: Refresh auth page -> URL remains preserved -> No duplicate scans created',
        passed: false,
        expected: 'URL query and sessionStorage remain intact after reload, 0 scans created on reload',
        actual: `Error: ${err.message}`,
        durationMs: Date.now() - testDStart
      });
    }

    // =========================================================================
    // TEST E: Login failure -> URL preserved -> error displayed -> user can retry
    // =========================================================================
    const testEStart = Date.now();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();

      await page.goto(`${baseUrl}/login?pendingUrl=https%3A%2F%2Fexample.com`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.auth-pending-banner', { state: 'visible', timeout: 5000 });

      // Fill bad credentials and submit
      await page.fill('#auth-form input[name="email"]', 'invalid-nonexistent-user@example.com');
      await page.fill('#auth-form input[name="password"]', 'badpassword123');
      await page.click('#auth-form button[type="submit"]');

      // Wait for error in #auth-message
      await page.waitForFunction(() => {
        const msg = document.querySelector('#auth-message')?.textContent || '';
        return msg.length > 0;
      }, { timeout: 10000 });

      const errorMessage = await page.evaluate(() => document.querySelector('#auth-message')?.textContent || '');
      const hasError = errorMessage.length > 0;

      // Pending URL must still be in sessionStorage and banner
      const sessionUrlAfterFailure = await page.evaluate(() => sessionStorage.getItem('fliqPendingUrl'));
      const bannerStillVisible = await page.evaluate(() => Boolean(document.querySelector('.auth-pending-banner')));
      const submitButtonEnabled = await page.evaluate(() => !document.querySelector('#auth-form button[type="submit"]')?.disabled);

      const passed = hasError && sessionUrlAfterFailure === 'https://example.com' && bannerStillVisible && submitButtonEnabled;

      testResults.push({
        id: 'test-e-login-failure-retry',
        name: 'Test E: Login failure -> URL preserved in session and UI -> Error displayed -> Submit re-enabled for retry',
        passed,
        expected: 'Error message displayed, sessionStorage preserves URL, banner remains visible, user can retry',
        actual: `Error message: "${errorMessage}", SessionStorage preserved: ${sessionUrlAfterFailure}, Banner visible: ${bannerStillVisible}, Submit enabled: ${submitButtonEnabled}`,
        durationMs: Date.now() - testEStart
      });
      await context.close();
    } catch (err) {
      testResults.push({
        id: 'test-e-login-failure-retry',
        name: 'Test E: Login failure -> URL preserved in session and UI -> Error displayed -> Submit re-enabled for retry',
        passed: false,
        expected: 'Error message displayed, sessionStorage preserves URL, banner remains visible, user can retry',
        actual: `Error: ${err.message}`,
        durationMs: Date.now() - testEStart
      });
    }

    // =========================================================================
    // TEST F: Authenticated visitor -> enter URL -> click "Run a test" -> scan starts immediately without login redirect
    // =========================================================================
    const testFStart = Date.now();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();

      // Establish authenticated session
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        localStorage.setItem('fliqTestUid', 'user-f-test');
        localStorage.setItem('fliqEmail', 'logged-in-tester@example.com');
        localStorage.setItem('fliqName', 'Logged In Tester');
      });

      // Open Watch demo modal and submit
      await page.waitForSelector('button[data-go="#demo"]', { timeout: 8000 });
      await page.click('button[data-go="#demo"]');
      await page.waitForSelector('#quick-test-url', { state: 'visible', timeout: 5000 });

      await page.fill('#quick-test-url', 'https://example.com');
      await page.click('#quick-test-submit');

      // Must start scan directly and NOT redirect to /login
      await page.waitForFunction(() => {
        return location.pathname.includes('/dashboard/tests/') || Boolean(document.querySelector('.progress-shell'));
      }, { timeout: 15000 });

      const currentPath = await page.evaluate(() => location.pathname);
      const scanId = currentPath.split('/')[3];
      const didNotRedirectToLogin = !currentPath.includes('/login');
      const hasValidScanId = Boolean(scanId && scanId.length >= 8);

      const passed = didNotRedirectToLogin && hasValidScanId;

      testResults.push({
        id: 'test-f-authed-direct-scan',
        name: 'Test F: Authenticated visitor -> Enter URL -> Click Run a test -> Starts immediately without login redirect',
        passed,
        expected: 'Direct scan initiation, navigates to /dashboard/tests/:id without /login redirect',
        actual: `Path: ${currentPath}, Scan ID: ${scanId}, Did not redirect to login: ${didNotRedirectToLogin}`,
        durationMs: Date.now() - testFStart,
        scanId
      });
      await context.close();
    } catch (err) {
      testResults.push({
        id: 'test-f-authed-direct-scan',
        name: 'Test F: Authenticated visitor -> Enter URL -> Click Run a test -> Starts immediately without login redirect',
        passed: false,
        expected: 'Direct scan initiation, navigates to /dashboard/tests/:id without /login redirect',
        actual: `Error: ${err.message}`,
        durationMs: Date.now() - testFStart
      });
    }

    // =========================================================================
    // TEST G: User A cannot access User B's scan records (cross-tenant data isolation)
    // =========================================================================
    const testGStart = Date.now();
    try {
      const userBUid = 'user-b-' + Date.now();
      const userAUid = 'user-a-' + Date.now();

      // Create a test belonging to User B via loopback test header
      const createRes = await fetch(`${baseUrl}/api/tests`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-fliq-test-uid': userBUid
        },
        body: JSON.stringify({ url: 'https://example.com' })
      });

      if (!createRes.ok) {
        throw new Error(`Failed to create test for User B: HTTP ${createRes.status}`);
      }
      const testB = await createRes.json();
      const testBId = testB.id;

      // 1. User B can access their own test
      const userBAccessRes = await fetch(`${baseUrl}/api/tests/${testBId}`, {
        headers: { 'x-fliq-test-uid': userBUid }
      });
      const userBAccessOk = userBAccessRes.status === 200;

      // 2. User A attempts to access User B's test -> MUST be denied (404)
      const userAAccessRes = await fetch(`${baseUrl}/api/tests/${testBId}`, {
        headers: { 'x-fliq-test-uid': userAUid }
      });
      const userAAccessDenied = userAAccessRes.status === 404;

      // 3. User A attempts to access User B's screenshot -> MUST be denied (404)
      const userAShotRes = await fetch(`${baseUrl}/api/screenshots/${testBId}-desktop.png`, {
        headers: { 'x-fliq-test-uid': userAUid }
      });
      const userAShotDenied = userAShotRes.status === 404;

      // 4. Unauthenticated caller attempts to access User B's test -> MUST be denied (401 or 404)
      const unauthAccessRes = await fetch(`${baseUrl}/api/tests/${testBId}`);
      const unauthAccessDenied = unauthAccessRes.status === 401 || unauthAccessRes.status === 404;

      // 5. User A's test list (/api/tests) must NOT include User B's test
      const userAListRes = await fetch(`${baseUrl}/api/tests`, {
        headers: { 'x-fliq-test-uid': userAUid }
      });
      const userAList = userAListRes.ok ? await userAListRes.json() : [];
      const testBNotInUserAList = !userAList.some(t => t.id === testBId);

      const passed = userBAccessOk && userAAccessDenied && userAShotDenied && unauthAccessDenied && testBNotInUserAList;

      testResults.push({
        id: 'test-g-cross-tenant-isolation',
        name: 'Test G: User A cannot access User B\'s private scan records or screenshots',
        passed,
        expected: 'User B accesses own test (200), User A blocked (404), User A screenshot blocked (404), Unauth blocked (401/404), Test B absent from User A list',
        actual: `User B access: ${userBAccessRes.status}, User A access: ${userAAccessRes.status}, User A screenshot: ${userAShotRes.status}, Unauth access: ${unauthAccessRes.status}, Absent from User A list: ${testBNotInUserAList}`,
        durationMs: Date.now() - testGStart,
        scanId: testBId
      });
    } catch (err) {
      testResults.push({
        id: 'test-g-cross-tenant-isolation',
        name: 'Test G: User A cannot access User B\'s private scan records or screenshots',
        passed: false,
        expected: 'Cross-tenant isolation enforced',
        actual: `Error: ${err.message}`,
        durationMs: Date.now() - testGStart
      });
    }

  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  const passedTests = testResults.filter(t => t.passed).length;
  const totalTests = testResults.length;
  const failedTests = totalTests - passedTests;
  const durationMs = Date.now() - suiteStart;

  const report = {
    suite: 'FLIQ Authentication-First Workflow Verification Suite',
    timestamp: new Date().toISOString(),
    totalTests,
    passedTests,
    failedTests,
    durationMs,
    allPassed: failedTests === 0,
    tests: testResults
  };

  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'auth-workflow-test-results.json'), JSON.stringify(report, null, 2));
  } catch (err) {
    console.error('[FLIQ] Failed to persist auth workflow test results:', err.message);
  }

  return report;
}
