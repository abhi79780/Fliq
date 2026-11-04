/**
 * FLIQ Authentication-Aware Global Logo Navigation Verification Suite
 * 
 * Verifies Playwright End-to-End Requirements:
 * - TEST A: Log in -> Open Pricing -> Click FLIQ logo -> Dashboard
 * - TEST B: Log in -> Open Features -> Click FLIQ logo -> Dashboard
 * - TEST C: Log in -> Open Reports -> Click FLIQ logo -> Dashboard
 * - TEST D: Log out -> Open Pricing -> Click FLIQ logo -> Public homepage
 * - TEST E: Open public homepage without login -> Click logo -> Remain on homepage
 * - TEST F: Log in -> Click logo repeatedly -> User remains authenticated
 * - TEST G: Refresh the dashboard -> Authentication session remains active
 * - TEST H: Check that no unexpected Firebase signOut() call occurs during navigation
 */

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');

export async function runLogoNavigationTests(customChromium = chromium, baseUrl = 'http://127.0.0.1:3000') {
  const testResults = [];
  const suiteStart = Date.now();
  let browser = null;

  try {
    browser = await customChromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-sandbox']
    });

    // Helper: Authenticate page session
    const setAuthenticatedSession = async (page, user = { uid: 'auth-user-nav', email: 'navuser@fliq.local', name: 'Nav Tester' }) => {
      await page.evaluate((u) => {
        localStorage.setItem('fliqTestUid', u.uid);
        localStorage.setItem('fliqEmail', u.email);
        localStorage.setItem('fliqName', u.name);
      }, user);
    };

    // =========================================================================
    // TEST A: Log in -> Open Pricing -> Click FLIQ logo -> Dashboard
    // =========================================================================
    const testAStart = Date.now();
    let contextA = null;
    try {
      contextA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await contextA.newPage();

      await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
      await setAuthenticatedSession(page, { uid: 'test-user-a', email: 'usera@example.com', name: 'User A' });

      await page.goto(`${baseUrl}/pricing`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.topnav .logo-link', { state: 'visible', timeout: 5000 });

      // Click FLIQ logo
      await page.click('.topnav .logo-link');

      // Wait for navigation to /dashboard
      await page.waitForFunction(() => location.pathname === '/dashboard', { timeout: 8000 });
      await page.waitForSelector('.sidebar', { state: 'visible', timeout: 5000 });

      const currentPath = await page.evaluate(() => location.pathname);
      const userEmail = await page.evaluate(() => localStorage.getItem('fliqEmail'));
      const userUid = await page.evaluate(() => localStorage.getItem('fliqTestUid'));
      const hasSidebar = await page.evaluate(() => Boolean(document.querySelector('.sidebar')));

      const passed = currentPath === '/dashboard' && userEmail === 'usera@example.com' && userUid === 'test-user-a' && hasSidebar;

      testResults.push({
        id: 'test-a-login-pricing-logo-dashboard',
        name: 'TEST A: Log in -> Open Pricing -> Click FLIQ logo -> Dashboard',
        passed,
        expected: 'Navigates from /pricing to /dashboard, auth session preserved (UID: test-user-a)',
        actual: `Navigated to ${currentPath}, sidebar visible: ${hasSidebar}, userEmail: ${userEmail}, uid: ${userUid}`,
        durationMs: Date.now() - testAStart
      });
    } catch (err) {
      testResults.push({
        id: 'test-a-login-pricing-logo-dashboard',
        name: 'TEST A: Log in -> Open Pricing -> Click FLIQ logo -> Dashboard',
        passed: false,
        expected: 'Navigates from /pricing to /dashboard, auth session preserved',
        actual: `Error: ${err.message}`,
        durationMs: Date.now() - testAStart
      });
    } finally {
      if (contextA) await contextA.close().catch(() => {});
    }

    // =========================================================================
    // TEST B: Log in -> Open Features -> Click FLIQ logo -> Dashboard
    // =========================================================================
    const testBStart = Date.now();
    let contextB = null;
    try {
      contextB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await contextB.newPage();

      await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
      await setAuthenticatedSession(page, { uid: 'test-user-b', email: 'userb@example.com', name: 'User B' });

      await page.goto(`${baseUrl}/features`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.topnav .logo-link', { state: 'visible', timeout: 5000 });

      // Click FLIQ logo
      await page.click('.topnav .logo-link');

      // Wait for navigation to /dashboard
      await page.waitForFunction(() => location.pathname === '/dashboard', { timeout: 8000 });
      await page.waitForSelector('.sidebar', { state: 'visible', timeout: 5000 });

      const currentPath = await page.evaluate(() => location.pathname);
      const userEmail = await page.evaluate(() => localStorage.getItem('fliqEmail'));
      const userUid = await page.evaluate(() => localStorage.getItem('fliqTestUid'));
      const hasSidebar = await page.evaluate(() => Boolean(document.querySelector('.sidebar')));

      const passed = currentPath === '/dashboard' && userEmail === 'userb@example.com' && userUid === 'test-user-b' && hasSidebar;

      testResults.push({
        id: 'test-b-login-features-logo-dashboard',
        name: 'TEST B: Log in -> Open Features -> Click FLIQ logo -> Dashboard',
        passed,
        expected: 'Navigates from /features to /dashboard, auth session preserved (UID: test-user-b)',
        actual: `Navigated to ${currentPath}, sidebar visible: ${hasSidebar}, userEmail: ${userEmail}, uid: ${userUid}`,
        durationMs: Date.now() - testBStart
      });
    } catch (err) {
      testResults.push({
        id: 'test-b-login-features-logo-dashboard',
        name: 'TEST B: Log in -> Open Features -> Click FLIQ logo -> Dashboard',
        passed: false,
        expected: 'Navigates from /features to /dashboard, auth session preserved',
        actual: `Error: ${err.message}`,
        durationMs: Date.now() - testBStart
      });
    } finally {
      if (contextB) await contextB.close().catch(() => {});
    }

    // =========================================================================
    // TEST C: Log in -> Open Reports -> Click FLIQ logo -> Dashboard
    // =========================================================================
    const testCStart = Date.now();
    let contextC = null;
    try {
      contextC = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await contextC.newPage();

      await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
      await setAuthenticatedSession(page, { uid: 'test-user-c', email: 'userc@example.com', name: 'User C' });

      await page.goto(`${baseUrl}/dashboard/reports`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sidebar .logo-link', { state: 'visible', timeout: 5000 });

      // Click FLIQ logo in sidebar
      await page.click('.sidebar .logo-link');

      // Wait for navigation to /dashboard
      await page.waitForFunction(() => location.pathname === '/dashboard', { timeout: 8000 });

      const currentPath = await page.evaluate(() => location.pathname);
      const userEmail = await page.evaluate(() => localStorage.getItem('fliqEmail'));
      const userUid = await page.evaluate(() => localStorage.getItem('fliqTestUid'));

      const passed = currentPath === '/dashboard' && userEmail === 'userc@example.com' && userUid === 'test-user-c';

      testResults.push({
        id: 'test-c-login-reports-logo-dashboard',
        name: 'TEST C: Log in -> Open Reports -> Click FLIQ logo -> Dashboard',
        passed,
        expected: 'Navigates from /dashboard/reports to /dashboard, auth session preserved (UID: test-user-c)',
        actual: `Navigated to ${currentPath}, userEmail: ${userEmail}, uid: ${userUid}`,
        durationMs: Date.now() - testCStart
      });
    } catch (err) {
      testResults.push({
        id: 'test-c-login-reports-logo-dashboard',
        name: 'TEST C: Log in -> Open Reports -> Click FLIQ logo -> Dashboard',
        passed: false,
        expected: 'Navigates from /dashboard/reports to /dashboard, auth session preserved',
        actual: `Error: ${err.message}`,
        durationMs: Date.now() - testCStart
      });
    } finally {
      if (contextC) await contextC.close().catch(() => {});
    }

    // =========================================================================
    // TEST D: Log out -> Open Pricing -> Click FLIQ logo -> Public homepage
    // =========================================================================
    const testDStart = Date.now();
    let contextD = null;
    try {
      contextD = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await contextD.newPage();

      // Start as logged-in user
      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
      await setAuthenticatedSession(page, { uid: 'test-user-d', email: 'userd@example.com', name: 'User D' });
      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-action="signout"]', { state: 'visible', timeout: 5000 });

      // Click sign out
      await page.click('[data-action="signout"]');
      await page.waitForFunction(() => location.pathname === '/login', { timeout: 5000 });

      // Navigate to public Pricing page
      await page.goto(`${baseUrl}/pricing`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.topnav .logo-link', { state: 'visible', timeout: 5000 });

      // Click logo as unauthenticated visitor
      await page.click('.topnav .logo-link');
      await page.waitForFunction(() => location.pathname === '/', { timeout: 8000 });

      const currentPath = await page.evaluate(() => location.pathname);
      const hasHero = await page.evaluate(() => Boolean(document.querySelector('.hero')));
      const passed = currentPath === '/' && hasHero;

      testResults.push({
        id: 'test-d-logout-pricing-logo-home',
        name: 'TEST D: Log out -> Open Pricing -> Click FLIQ logo -> Public homepage',
        passed,
        expected: 'Navigates to / (public homepage), does not navigate to /dashboard',
        actual: `Navigated to ${currentPath}, hasHero: ${hasHero}`,
        durationMs: Date.now() - testDStart
      });
    } catch (err) {
      testResults.push({
        id: 'test-d-logout-pricing-logo-home',
        name: 'TEST D: Log out -> Open Pricing -> Click FLIQ logo -> Public homepage',
        passed: false,
        expected: 'Navigates to / (public homepage)',
        actual: `Error: ${err.message}`,
        durationMs: Date.now() - testDStart
      });
    } finally {
      if (contextD) await contextD.close().catch(() => {});
    }

    // =========================================================================
    // TEST E: Open public homepage without login -> Click logo -> Remain on homepage
    // =========================================================================
    const testEStart = Date.now();
    let contextE = null;
    try {
      contextE = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await contextE.newPage();

      await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.topnav .logo-link', { state: 'visible', timeout: 5000 });

      // Attach marker to ensure page does not reload
      await page.evaluate(() => { window.__fliqReloadMarker = 'active'; });

      // Click logo
      await page.click('.topnav .logo-link');

      const currentPath = await page.evaluate(() => location.pathname);
      const markerIntact = await page.evaluate(() => window.__fliqReloadMarker === 'active');
      const passed = currentPath === '/' && markerIntact;

      testResults.push({
        id: 'test-e-unauth-home-logo-remain',
        name: 'TEST E: Open public homepage without login -> Click logo -> Remain on homepage',
        passed,
        expected: 'Remains on / without reload, window state preserved',
        actual: `Path: ${currentPath}, markerIntact: ${markerIntact}`,
        durationMs: Date.now() - testEStart
      });
    } catch (err) {
      testResults.push({
        id: 'test-e-unauth-home-logo-remain',
        name: 'TEST E: Open public homepage without login -> Click logo -> Remain on homepage',
        passed: false,
        expected: 'Remains on /',
        actual: `Error: ${err.message}`,
        durationMs: Date.now() - testEStart
      });
    } finally {
      if (contextE) await contextE.close().catch(() => {});
    }

    // =========================================================================
    // TEST F: Log in -> Click logo repeatedly -> User remains authenticated
    // =========================================================================
    const testFStart = Date.now();
    let contextF = null;
    try {
      contextF = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await contextF.newPage();

      await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
      await setAuthenticatedSession(page, { uid: 'test-user-f', email: 'userf@example.com', name: 'User F' });

      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sidebar .logo-link', { state: 'visible', timeout: 5000 });

      // Click logo 5 times in succession
      for (let i = 0; i < 5; i++) {
        await page.click('.sidebar .logo-link');
        await page.waitForTimeout(100);
      }

      const currentPath = await page.evaluate(() => location.pathname);
      const userEmail = await page.evaluate(() => localStorage.getItem('fliqEmail'));
      const userUid = await page.evaluate(() => localStorage.getItem('fliqTestUid'));
      const hasSidebar = await page.evaluate(() => Boolean(document.querySelector('.sidebar')));

      const passed = currentPath === '/dashboard' && userEmail === 'userf@example.com' && userUid === 'test-user-f' && hasSidebar;

      testResults.push({
        id: 'test-f-repeated-logo-clicks-preserves-auth',
        name: 'TEST F: Log in -> Click logo repeatedly -> User remains authenticated',
        passed,
        expected: 'User remains authenticated on /dashboard after 5 consecutive clicks',
        actual: `Path: ${currentPath}, userEmail: ${userEmail}, uid: ${userUid}, sidebar: ${hasSidebar}`,
        durationMs: Date.now() - testFStart
      });
    } catch (err) {
      testResults.push({
        id: 'test-f-repeated-logo-clicks-preserves-auth',
        name: 'TEST F: Log in -> Click logo repeatedly -> User remains authenticated',
        passed: false,
        expected: 'User remains authenticated on /dashboard',
        actual: `Error: ${err.message}`,
        durationMs: Date.now() - testFStart
      });
    } finally {
      if (contextF) await contextF.close().catch(() => {});
    }

    // =========================================================================
    // TEST G: Refresh the dashboard -> Authentication session remains active
    // =========================================================================
    const testGStart = Date.now();
    let contextG = null;
    try {
      contextG = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await contextG.newPage();

      await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
      await setAuthenticatedSession(page, { uid: 'test-user-g', email: 'userg@example.com', name: 'User G' });

      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sidebar', { state: 'visible', timeout: 5000 });

      // Reload the page
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sidebar', { state: 'visible', timeout: 8000 });

      const currentPath = await page.evaluate(() => location.pathname);
      const userEmail = await page.evaluate(() => localStorage.getItem('fliqEmail'));
      const userUid = await page.evaluate(() => localStorage.getItem('fliqTestUid'));
      const passed = currentPath === '/dashboard' && userEmail === 'userg@example.com' && userUid === 'test-user-g';

      testResults.push({
        id: 'test-g-refresh-dashboard-session-active',
        name: 'TEST G: Refresh the dashboard -> Authentication session remains active',
        passed,
        expected: 'Dashboard reloads successfully, user session stays active',
        actual: `Path: ${currentPath}, userEmail: ${userEmail}, uid: ${userUid}`,
        durationMs: Date.now() - testGStart
      });
    } catch (err) {
      testResults.push({
        id: 'test-g-refresh-dashboard-session-active',
        name: 'TEST G: Refresh the dashboard -> Authentication session remains active',
        passed: false,
        expected: 'Session remains active after reload',
        actual: `Error: ${err.message}`,
        durationMs: Date.now() - testGStart
      });
    } finally {
      if (contextG) await contextG.close().catch(() => {});
    }

    // =========================================================================
    // TEST H: Check that no unexpected Firebase signOut() call occurs during navigation
    // =========================================================================
    const testHStart = Date.now();
    let contextH = null;
    try {
      contextH = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await contextH.newPage();

      await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
      await setAuthenticatedSession(page, { uid: 'test-user-h', email: 'userh@example.com', name: 'User H' });

      await page.goto(`${baseUrl}/pricing`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.topnav .logo-link', { state: 'visible', timeout: 5000 });

      const initialSignOutCalls = await page.evaluate(() => window.__fliqSignOutCalls || 0);

      // Perform logo navigation from Pricing to Dashboard
      await page.click('.topnav .logo-link');
      await page.waitForFunction(() => location.pathname === '/dashboard', { timeout: 8000 });

      const afterNavSignOutCalls = await page.evaluate(() => window.__fliqSignOutCalls || 0);
      const userStillAuthed = await page.evaluate(() => Boolean(localStorage.getItem('fliqTestUid')));

      const passed = initialSignOutCalls === 0 && afterNavSignOutCalls === 0 && userStillAuthed;

      testResults.push({
        id: 'test-h-no-unexpected-signout-during-nav',
        name: 'TEST H: Check that no unexpected Firebase signOut() call occurs during navigation',
        passed,
        expected: '0 signOut calls during logo navigation, user remains authenticated',
        actual: `Initial signOuts: ${initialSignOutCalls}, After nav signOuts: ${afterNavSignOutCalls}, Authed: ${userStillAuthed}`,
        durationMs: Date.now() - testHStart
      });
    } catch (err) {
      testResults.push({
        id: 'test-h-no-unexpected-signout-during-nav',
        name: 'TEST H: Check that no unexpected Firebase signOut() call occurs during navigation',
        passed: false,
        expected: '0 signOut calls during navigation',
        actual: `Error: ${err.message}`,
        durationMs: Date.now() - testHStart
      });
    } finally {
      if (contextH) await contextH.close().catch(() => {});
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
    suite: 'FLIQ Authentication-Aware Global Logo Navigation Verification Suite',
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
    await fs.writeFile(path.join(dataDir, 'logo-navigation-test-results.json'), JSON.stringify(report, null, 2));
  } catch (err) {
    console.error('[FLIQ] Failed to persist logo navigation test results:', err.message);
  }

  return report;
}
