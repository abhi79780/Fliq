/**
 * FLIQ Pricing & Authentication Integration Test Suite
 * 
 * Verifies:
 * - Scenario 1: Authenticated user in Settings -> Billing -> Compare plans -> clicks Creator/Team -> remains authenticated -> navigates to /checkout with plan & period preserved.
 * - Scenario 2: Unauthenticated visitor on /pricing clicks Creator/Team -> redirected to /signup with plan & period preserved and banner -> post-auth navigates to /checkout.
 * - Scenario 3: Existing session persistence: refreshing /pricing preserves auth, navigating between dashboard/settings/pricing preserves auth, no signOut() called.
 * - Checkout view: Honest payment preparation view showing plan, frequency, subtotal, email, features, gateway notice, and no API access.
 */

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');

export async function runPricingAuthTests(customChromium = chromium, baseUrl = 'http://127.0.0.1:3000') {
  const testResults = [];
  const suiteStart = Date.now();
  let browser = null;

  // Structural & Code Verification (deterministic baseline)
  try {
    const appJs = await fs.readFile(path.join(rootDir, 'app.js'), 'utf8');

    // 1. handlePlanSelect and navigatePostAuth exist and are exposed
    const hasHandlePlanSelect = appJs.includes('async function handlePlanSelect(');
    const hasNavigatePostAuth = appJs.includes('async function navigatePostAuth(');
    const hasExposedAuth = appJs.includes('handlePlanSelect') && appJs.includes('navigatePostAuth') && appJs.includes('window.fliqAuth=');

    testResults.push({
      id: 'test-structural-plan-auth-handlers',
      name: 'Structural: handlePlanSelect and navigatePostAuth are implemented and exposed on window.fliqAuth',
      passed: hasHandlePlanSelect && hasNavigatePostAuth && hasExposedAuth,
      expected: 'Functions exist and are attached to window.fliqAuth',
      actual: `hasHandlePlanSelect: ${hasHandlePlanSelect}, hasNavigatePostAuth: ${hasNavigatePostAuth}, hasExposedAuth: ${hasExposedAuth}`
    });

    // 2. Pricing cards have data-plan-select
    const hasPlanSelectAttrs = appJs.includes('data-plan-select="${esc(p.name.toLowerCase())}"');
    const hasPlanSelectListener = appJs.includes("e.target.closest('[data-plan-select]')");

    testResults.push({
      id: 'test-structural-pricing-card-triggers',
      name: 'Structural: Pricing cards attach data-plan-select and click listener delegates to handlePlanSelect',
      passed: hasPlanSelectAttrs && hasPlanSelectListener,
      expected: 'data-plan-select attribute present and handled in click event listener',
      actual: `hasPlanSelectAttrs: ${hasPlanSelectAttrs}, hasPlanSelectListener: ${hasPlanSelectListener}`
    });

    // 3. Checkout route & view registered
    const hasCheckoutRoute = appJs.includes("path==='/checkout'") || appJs.includes("path.startsWith('/checkout')");
    const hasCheckoutFunction = appJs.includes('function checkoutPage()');
    const isCheckoutProtected = appJs.includes("p==='/checkout'") || appJs.includes("p.startsWith('/checkout/')");

    testResults.push({
      id: 'test-structural-checkout-route-and-view',
      name: 'Structural: /checkout route, checkoutPage component, and route protection are configured',
      passed: hasCheckoutRoute && hasCheckoutFunction && isCheckoutProtected,
      expected: '/checkout route active, component defined, and protected from unauthenticated access',
      actual: `hasCheckoutRoute: ${hasCheckoutRoute}, hasCheckoutFunction: ${hasCheckoutFunction}, isCheckoutProtected: ${isCheckoutProtected}`
    });

    // 4. Zero API access in plans and checkout
    const plansMatch = appJs.match(/const plans\s*=\s*\[([\s\S]*?)\];/);
    const hasApiInPlans = plansMatch ? /api access/i.test(plansMatch[0]) : false;
    const checkoutMatch = appJs.match(/function checkoutPage\(\)\{[\s\S]*?\n\}/);
    const hasApiInCheckout = checkoutMatch ? /api access/i.test(checkoutMatch[0]) : false;

    testResults.push({
      id: 'test-structural-no-api-access',
      name: 'Structural: Strictly NO API access mentioned in plans or checkout page',
      passed: !hasApiInPlans && !hasApiInCheckout,
      expected: 'Zero occurrences of API access in plans array and checkout view',
      actual: `hasApiInPlans: ${hasApiInPlans}, hasApiInCheckout: ${hasApiInCheckout}`
    });

  } catch (err) {
    testResults.push({
      id: 'test-structural-exception',
      name: 'Structural: Static code checks threw exception',
      passed: false,
      expected: 'Clean static inspection',
      actual: err.message
    });
  }

  // Playwright End-to-End Verification
  try {
    browser = await customChromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-sandbox']
    });

    const setAuthenticatedSession = async (page, user = { uid: 'pricing-tester-uid', email: 'tester@fliq.local', name: 'Pricing Tester' }) => {
      await page.evaluate((u) => {
        localStorage.setItem('fliqTestUid', u.uid);
        localStorage.setItem('fliqEmail', u.email);
        localStorage.setItem('fliqName', u.name);
      }, user);
    };

    // =========================================================================
    // TEST 1: Authenticated User -> Settings -> Compare plans -> Click Creator "Get started" -> /checkout
    // =========================================================================
    const test1Start = Date.now();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();

      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
      await setAuthenticatedSession(page, { uid: 'auth-user-plan1', email: 'user1@example.com', name: 'User One' });

      // Open Settings -> Billing
      await page.goto(`${baseUrl}/dashboard/settings#Billing`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('button[data-go="/pricing"]', { state: 'visible', timeout: 5000 });

      // Click "Compare plans"
      await page.click('button[data-go="/pricing"]');
      await page.waitForFunction(() => location.pathname === '/pricing', { timeout: 5000 });

      // Click "Get started" on the Creator plan card
      await page.waitForSelector('[data-plan-select="creator"]', { state: 'visible', timeout: 5000 });
      await page.click('[data-plan-select="creator"]');

      // Must navigate to /checkout?plan=creator&period=monthly without redirecting to login
      await page.waitForFunction(() => location.pathname === '/checkout', { timeout: 8000 });

      const currentUrl = page.url();
      const currentPath = await page.evaluate(() => location.pathname);
      const searchParams = new URL(currentUrl).searchParams;
      const planParam = searchParams.get('plan');
      const periodParam = searchParams.get('period');
      const userUid = await page.evaluate(() => localStorage.getItem('fliqTestUid'));
      const hasCheckoutHead = await page.evaluate(() => Boolean(document.querySelector('.checkout-page')));

      const passed = currentPath === '/checkout' && planParam === 'creator' && periodParam === 'monthly' && userUid === 'auth-user-plan1' && hasCheckoutHead;

      testResults.push({
        id: 'test-auth-user-select-creator-navigates-checkout',
        name: 'Scenario 1: Authenticated user clicking Creator "Get started" navigates to /checkout with plan & period preserved',
        passed,
        expected: 'Navigates to /checkout?plan=creator&period=monthly, user remains authenticated, UID preserved',
        actual: `URL: ${currentUrl}, plan: ${planParam}, period: ${periodParam}, uid: ${userUid}, checkoutPage visible: ${hasCheckoutHead}`,
        durationMs: Date.now() - test1Start
      });

      await context.close();
    } catch (err) {
      testResults.push({
        id: 'test-auth-user-select-creator-navigates-checkout',
        name: 'Scenario 1: Authenticated user clicking Creator "Get started" navigates to /checkout with plan & period preserved',
        passed: false,
        expected: 'Navigates to /checkout without login redirect',
        actual: err.message,
        durationMs: Date.now() - test1Start
      });
    }

    // =========================================================================
    // TEST 2: Authenticated User -> Yearly toggle -> Select Team plan -> /checkout?plan=team&period=yearly
    // =========================================================================
    const test2Start = Date.now();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();

      await page.goto(`${baseUrl}/pricing`, { waitUntil: 'domcontentloaded' });
      await setAuthenticatedSession(page, { uid: 'auth-user-plan2', email: 'user2@example.com', name: 'User Two' });

      // Click "Yearly" toggle
      await page.waitForSelector('button[data-period="Yearly"]', { state: 'visible', timeout: 5000 });
      await page.click('button[data-period="Yearly"]');

      // Click "Get started" on Team plan
      await page.waitForSelector('[data-plan-select="team"]', { state: 'visible', timeout: 5000 });
      await page.click('[data-plan-select="team"]');

      await page.waitForFunction(() => location.pathname === '/checkout', { timeout: 8000 });

      const currentUrl = page.url();
      const currentPath = await page.evaluate(() => location.pathname);
      const searchParams = new URL(currentUrl).searchParams;
      const planParam = searchParams.get('plan');
      const periodParam = searchParams.get('period');
      const userUid = await page.evaluate(() => localStorage.getItem('fliqTestUid'));

      const passed = currentPath === '/checkout' && planParam === 'team' && periodParam === 'yearly' && userUid === 'auth-user-plan2';

      testResults.push({
        id: 'test-auth-user-select-team-yearly-checkout',
        name: 'Scenario 1b: Authenticated user selecting Yearly billing and Team plan navigates to /checkout?plan=team&period=yearly',
        passed,
        expected: 'Navigates to /checkout?plan=team&period=yearly with auth preserved',
        actual: `URL: ${currentUrl}, plan: ${planParam}, period: ${periodParam}, uid: ${userUid}`,
        durationMs: Date.now() - test2Start
      });

      await context.close();
    } catch (err) {
      testResults.push({
        id: 'test-auth-user-select-team-yearly-checkout',
        name: 'Scenario 1b: Authenticated user selecting Yearly billing and Team plan navigates to /checkout?plan=team&period=yearly',
        passed: false,
        expected: 'Navigates to /checkout?plan=team&period=yearly',
        actual: err.message,
        durationMs: Date.now() - test2Start
      });
    }

    // =========================================================================
    // TEST 3: Unauthenticated Visitor -> Click Creator "Get started" -> Redirects to /signup with plan & period
    // =========================================================================
    const test3Start = Date.now();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();

      await page.goto(`${baseUrl}/pricing`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-plan-select="creator"]', { state: 'visible', timeout: 5000 });

      await page.click('[data-plan-select="creator"]');

      // Must redirect to /signup with plan and period query params
      await page.waitForURL(/\/signup\?plan=creator/, { timeout: 8000 });

      const currentUrl = page.url();
      const searchParams = new URL(currentUrl).searchParams;
      const planParam = searchParams.get('plan');
      const periodParam = searchParams.get('period');
      const storedPendingPlan = await page.evaluate(() => sessionStorage.getItem('fliqPendingPlan'));

      // Check contextual plan banner
      await page.waitForSelector('.auth-pending-banner', { state: 'visible', timeout: 5000 });
      const bannerText = await page.evaluate(() => document.querySelector('.auth-pending-banner')?.textContent || '');
      const bannerHasPlan = bannerText.toLowerCase().includes('creator plan');
      const bannerHasExplanation = bannerText.toLowerCase().includes('checkout preparation');

      const passed = planParam === 'creator' && periodParam === 'monthly' && storedPendingPlan === 'creator' && bannerHasPlan && bannerHasExplanation;

      testResults.push({
        id: 'test-visitor-select-creator-redirects-signup',
        name: 'Scenario 2: Unauthenticated visitor clicking Creator "Get started" redirects to /signup with plan query & contextual banner',
        passed,
        expected: 'Redirects to /signup?plan=creator&period=monthly, stores pending plan in sessionStorage, displays plan banner',
        actual: `URL: ${currentUrl}, storedPendingPlan: ${storedPendingPlan}, bannerHasPlan: ${bannerHasPlan}, bannerHasExplanation: ${bannerHasExplanation}`,
        durationMs: Date.now() - test3Start
      });

      await context.close();
    } catch (err) {
      testResults.push({
        id: 'test-visitor-select-creator-redirects-signup',
        name: 'Scenario 2: Unauthenticated visitor clicking Creator "Get started" redirects to /signup with plan query & contextual banner',
        passed: false,
        expected: 'Redirects to /signup with plan parameters and banner',
        actual: err.message,
        durationMs: Date.now() - test3Start
      });
    }

    // =========================================================================
    // TEST 4: Post-Auth Continuation -> User logs in -> Automatically proceeds to /checkout
    // =========================================================================
    const test4Start = Date.now();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();

      // Start on /signup with pending plan
      await page.goto(`${baseUrl}/signup?plan=creator&period=monthly`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#auth-form', { state: 'visible', timeout: 5000 });

      // Emulate successful post-auth navigation via window.fliqAuth.navigatePostAuth()
      await setAuthenticatedSession(page, { uid: 'post-auth-user', email: 'postauth@example.com', name: 'Post Auth User' });
      await page.evaluate(async () => {
        await window.fliqAuth.navigatePostAuth();
      });

      await page.waitForFunction(() => location.pathname === '/checkout', { timeout: 8000 });

      const currentUrl = page.url();
      const currentPath = await page.evaluate(() => location.pathname);
      const searchParams = new URL(currentUrl).searchParams;
      const planParam = searchParams.get('plan');
      const periodParam = searchParams.get('period');

      const passed = currentPath === '/checkout' && planParam === 'creator' && periodParam === 'monthly';

      testResults.push({
        id: 'test-post-auth-continuation-checkout',
        name: 'Scenario 2b: After authentication, user automatically continues to /checkout?plan=creator&period=monthly',
        passed,
        expected: 'Automatically navigates to /checkout with original plan and period',
        actual: `Path: ${currentPath}, plan: ${planParam}, period: ${periodParam}`,
        durationMs: Date.now() - test4Start
      });

      await context.close();
    } catch (err) {
      testResults.push({
        id: 'test-post-auth-continuation-checkout',
        name: 'Scenario 2b: After authentication, user automatically continues to /checkout?plan=creator&period=monthly',
        passed: false,
        expected: 'Automatically navigates to /checkout',
        actual: err.message,
        durationMs: Date.now() - test4Start
      });
    }

    // =========================================================================
    // TEST 5: Session Persistence -> Refreshing /pricing preserves session; no signOut() calls
    // =========================================================================
    const test5Start = Date.now();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();

      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
      await setAuthenticatedSession(page, { uid: 'session-persist-user', email: 'persist@example.com', name: 'Persist User' });

      // Navigate to /pricing
      await page.goto(`${baseUrl}/pricing`, { waitUntil: 'domcontentloaded' });

      // Refresh /pricing
      await page.reload({ waitUntil: 'domcontentloaded' });

      // Check auth session
      const userUid = await page.evaluate(() => localStorage.getItem('fliqTestUid'));
      const signOutCalls = await page.evaluate(() => window.__fliqSignOutCalls || 0);

      // Navigate back to /dashboard
      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sidebar', { state: 'visible', timeout: 5000 });

      const currentPath = await page.evaluate(() => location.pathname);
      const passed = userUid === 'session-persist-user' && signOutCalls === 0 && currentPath === '/dashboard';

      testResults.push({
        id: 'test-session-persistence-pricing-refresh',
        name: 'Scenario 3: Refreshing /pricing preserves authentication session, never calls signOut(), and dashboard remains accessible',
        passed,
        expected: 'Session intact, signOut() calls = 0, dashboard loads',
        actual: `userUid: ${userUid}, signOutCalls: ${signOutCalls}, currentPath: ${currentPath}`,
        durationMs: Date.now() - test5Start
      });

      await context.close();
    } catch (err) {
      testResults.push({
        id: 'test-session-persistence-pricing-refresh',
        name: 'Scenario 3: Refreshing /pricing preserves authentication session, never calls signOut(), and dashboard remains accessible',
        passed: false,
        expected: 'Session intact without signOut() calls',
        actual: err.message,
        durationMs: Date.now() - test5Start
      });
    }

    // =========================================================================
    // TEST 6: Checkout Preparation View -> Pricing values, Subtotal, Gateway Notice, No API Access
    // =========================================================================
    const test6Start = Date.now();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();

      await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
      await setAuthenticatedSession(page, { uid: 'checkout-view-tester', email: 'billing@example.com', name: 'Billing Tester' });

      // Open checkout for Creator plan (yearly)
      await page.goto(`${baseUrl}/checkout?plan=creator&period=yearly`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.checkout-page', { state: 'visible', timeout: 5000 });

      const pageContent = await page.evaluate(() => document.querySelector('.checkout-page')?.textContent || '');
      const hasPlanName = pageContent.includes('Creator Plan') || pageContent.includes('Creator');
      const hasYearlyPrice = pageContent.includes('$48');
      const hasGatewayNotice = pageContent.toLowerCase().includes('lemon squeezy') && pageContent.toLowerCase().includes('preparation');
      const hasUserEmail = pageContent.includes('billing@example.com');
      const hasNoApiAccess = !/api access/i.test(pageContent);

      const passed = hasPlanName && hasYearlyPrice && hasGatewayNotice && hasUserEmail && hasNoApiAccess;

      testResults.push({
        id: 'test-checkout-view-details-and-notice',
        name: 'Checkout Preparation View: Renders plan name, $48 yearly price, user email, gateway preparation notice, and 0 API access',
        passed,
        expected: 'Accurate pricing values, user email, gateway notice, and zero API access',
        actual: `hasPlanName: ${hasPlanName}, hasYearlyPrice: ${hasYearlyPrice}, hasGatewayNotice: ${hasGatewayNotice}, hasUserEmail: ${hasUserEmail}, hasNoApiAccess: ${hasNoApiAccess}`,
        durationMs: Date.now() - test6Start
      });

      await context.close();
    } catch (err) {
      testResults.push({
        id: 'test-checkout-view-details-and-notice',
        name: 'Checkout Preparation View: Renders plan name, $48 yearly price, user email, gateway preparation notice, and 0 API access',
        passed: false,
        expected: 'Checkout view renders properly',
        actual: err.message,
        durationMs: Date.now() - test6Start
      });
    }

    // =========================================================================
    // TEST 7: Authenticated User selects Free plan -> Navigates to /dashboard
    // =========================================================================
    const test7Start = Date.now();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();

      await page.goto(`${baseUrl}/pricing`, { waitUntil: 'domcontentloaded' });
      await setAuthenticatedSession(page, { uid: 'free-plan-user', email: 'freeuser@example.com', name: 'Free User' });

      // Click "Get started" on Free plan
      await page.waitForSelector('[data-plan-select="free"]', { state: 'visible', timeout: 5000 });
      await page.click('[data-plan-select="free"]');

      await page.waitForFunction(() => location.pathname === '/dashboard', { timeout: 8000 });
      const currentPath = await page.evaluate(() => location.pathname);

      const passed = currentPath === '/dashboard';

      testResults.push({
        id: 'test-auth-user-select-free-dashboard',
        name: 'Free Plan Selection: Authenticated user selecting Free plan navigates directly to /dashboard',
        passed,
        expected: 'Navigates directly to /dashboard',
        actual: `currentPath: ${currentPath}`,
        durationMs: Date.now() - test7Start
      });

      await context.close();
    } catch (err) {
      testResults.push({
        id: 'test-auth-user-select-free-dashboard',
        name: 'Free Plan Selection: Authenticated user selecting Free plan navigates directly to /dashboard',
        passed: false,
        expected: 'Navigates to /dashboard',
        actual: err.message,
        durationMs: Date.now() - test7Start
      });
    }

  } catch (browserErr) {
    console.error('[FLIQ] Playwright pricing auth tests browser error:', browserErr.message);
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }

  const passedCount = testResults.filter(t => t.passed).length;
  const totalCount = testResults.length;
  const allPassed = passedCount === totalCount && totalCount > 0;

  const report = {
    suite: 'FLIQ Pricing & Authentication Integration Test Suite',
    executedAt: new Date().toISOString(),
    durationMs: Date.now() - suiteStart,
    totalTests: totalCount,
    passedTests: passedCount,
    failedTests: totalCount - passedCount,
    allPassed,
    results: testResults
  };

  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'pricing-auth-test-results.json'),
      JSON.stringify(report, null, 2),
      'utf8'
    );
  } catch (writeErr) {
    console.error('[FLIQ] Could not save pricing auth test results:', writeErr.message);
  }

  return report;
}
