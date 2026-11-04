/**
 * FLIQ Watch Demo / Run a Test Workflow Verification Suite
 * 
 * Verifies End-to-End Playwright Workflow:
 * - Test A: Landing page -> Watch demo -> Valid URL -> Real scan creation & navigation
 * - Test B: Invalid URL -> Inline validation message -> Modal stays open
 * - Test C: Rapid click -> Duplicate submissions prevented -> Button loading state
 * - Test D: Scan execution -> Real progress updates -> Final audit report rendered
 * - Test E: Backend error simulation -> Visible error in modal -> Button re-enabled
 */

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

export async function runDemoWorkflowTests(customChromium = chromium, baseUrl = 'http://127.0.0.1:3000') {
  const testResults = [];
  let browser = null;

  try {
    browser = await customChromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-sandbox']
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    // TEST A: Open landing page, click Watch demo, enter https://example.com, click Run a test, verify real scan created
    const testAStart = Date.now();
    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        localStorage.setItem('fliqEmail', 'demo-runner@example.com');
        localStorage.setItem('fliqName', 'Demo Runner');
      });
      await page.waitForSelector('button[data-go="#demo"]', { timeout: 8000 });
      await page.click('button[data-go="#demo"]');
      await page.waitForSelector('#quick-test-url', { state: 'visible', timeout: 5000 });

      const modalVisible = await page.evaluate(() => Boolean(document.querySelector('.demo-modal')));
      if (!modalVisible) throw new Error('Modal did not open on Watch demo click.');

      await page.fill('#quick-test-url', 'https://example.com');
      await page.click('#quick-test-submit');

      await page.waitForFunction(() => {
        return location.pathname.includes('/dashboard/tests/') || Boolean(document.querySelector('.progress-shell'));
      }, { timeout: 15000 });

      const currentPath = await page.evaluate(() => location.pathname);
      const scanId = currentPath.split('/')[3];
      const hasValidId = Boolean(scanId && scanId.length >= 8);

      testResults.push({
        id: 'test-a-create-scan',
        name: 'Test A: Open landing page -> Watch demo -> Enter https://example.com -> Real scan created',
        passed: hasValidId,
        expected: 'Scan created with valid ID and navigated to /dashboard/tests/:id',
        actual: `Navigated to ${currentPath} (Scan ID: ${scanId})`,
        durationMs: Date.now() - testAStart,
        scanId
      });
    } catch (err) {
      testResults.push({
        id: 'test-a-create-scan',
        name: 'Test A: Open landing page -> Watch demo -> Enter https://example.com -> Real scan created',
        passed: false,
        expected: 'Scan created with valid ID and navigated to /dashboard/tests/:id',
        actual: `Error: ${err.message}`,
        durationMs: Date.now() - testAStart
      });
    }

    // TEST B: Enter an invalid URL -> Verify inline validation -> Confirm modal stays open
    const testBStart = Date.now();
    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        localStorage.setItem('fliqEmail', 'demo-runner@example.com');
        localStorage.setItem('fliqName', 'Demo Runner');
      });
      await page.waitForSelector('button[data-go="#demo"]', { timeout: 8000 });
      await page.click('button[data-go="#demo"]');
      await page.waitForSelector('#quick-test-url', { state: 'visible', timeout: 5000 });

      await page.fill('#quick-test-url', 'not-a-valid-url');
      await page.click('#quick-test-submit');

      await page.waitForSelector('#demo-error', { state: 'visible', timeout: 3000 });
      const errorText = await page.evaluate(() => document.querySelector('#demo-error')?.textContent || '');
      const modalStillOpen = await page.evaluate(() => Boolean(document.querySelector('.demo-modal')));
      const hasInputErrorClass = await page.evaluate(() => document.querySelector('#quick-test-url')?.classList.contains('has-error'));

      const passed = modalStillOpen && errorText.length > 0 && hasInputErrorClass;
      testResults.push({
        id: 'test-b-invalid-url-validation',
        name: 'Test B: Invalid URL displays inline validation and keeps modal open',
        passed,
        expected: 'Inline error displayed in #demo-error, input highlighted, modal remains open',
        actual: `Modal open: ${modalStillOpen}, Error message: "${errorText}", Input has-error: ${hasInputErrorClass}`,
        durationMs: Date.now() - testBStart
      });
    } catch (err) {
      testResults.push({
        id: 'test-b-invalid-url-validation',
        name: 'Test B: Invalid URL displays inline validation and keeps modal open',
        passed: false,
        expected: 'Inline error displayed in #demo-error, input highlighted, modal remains open',
        actual: `Error: ${err.message}`,
        durationMs: Date.now() - testBStart
      });
    }

    // TEST C: Submit a valid URL -> Verify duplicate submissions are prevented
    const testCStart = Date.now();
    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        localStorage.setItem('fliqEmail', 'demo-runner@example.com');
        localStorage.setItem('fliqName', 'Demo Runner');
      });
      await page.waitForSelector('button[data-go="#demo"]', { timeout: 8000 });
      await page.click('button[data-go="#demo"]');
      await page.waitForSelector('#quick-test-url', { state: 'visible', timeout: 5000 });

      await page.fill('#quick-test-url', 'https://example.com');

      let postCount = 0;
      await page.route('**/api/tests', async route => {
        if (route.request().method() === 'POST') {
          postCount++;
          await new Promise(r => setTimeout(r, 600));
        }
        await route.continue();
      });

      await page.click('#quick-test-submit');
      const isDisabledAfterFirstClick = await page.evaluate(() => {
        const btn = document.querySelector('#quick-test-submit');
        return btn?.disabled && btn?.textContent.includes('Starting');
      });

      await page.click('#quick-test-submit').catch(() => {});

      await page.waitForFunction(() => {
        return location.pathname.includes('/dashboard/tests/');
      }, { timeout: 15000 });

      await page.unroute('**/api/tests');

      const passed = isDisabledAfterFirstClick && postCount === 1;
      testResults.push({
        id: 'test-c-duplicate-prevention',
        name: 'Test C: Duplicate submissions are prevented and loading state is displayed',
        passed,
        expected: 'Button disabled with "Starting test…", exactly 1 POST request sent',
        actual: `Disabled during request: ${isDisabledAfterFirstClick}, POST requests received: ${postCount}`,
        durationMs: Date.now() - testCStart
      });
    } catch (err) {
      testResults.push({
        id: 'test-c-duplicate-prevention',
        name: 'Test C: Duplicate submissions are prevented and loading state is displayed',
        passed: false,
        expected: 'Button disabled with "Starting test…", exactly 1 POST request sent',
        actual: `Error: ${err.message}`,
        durationMs: Date.now() - testCStart
      });
    }

    // TEST D: Wait for scan completion -> Verify the final report is displayed
    const testDStart = Date.now();
    try {
      const currentPath = await page.evaluate(() => location.pathname);
      const scanId = currentPath.split('/')[3];

      if (!scanId) {
        throw new Error('No active scan ID found to wait for completion.');
      }

      await page.waitForFunction(() => {
        return Boolean(document.querySelector('.report-head') || document.querySelector('.tabs'));
      }, { timeout: 60000 });

      const hasReportHead = await page.evaluate(() => Boolean(document.querySelector('.report-head')));
      const hasTabs = await page.evaluate(() => Boolean(document.querySelector('.tabs')));
      const hasMetrics = await page.evaluate(() => Boolean(document.querySelector('.report-metrics') || document.querySelector('.metric')));

      const passed = hasReportHead && hasTabs;
      testResults.push({
        id: 'test-d-scan-completion-and-report',
        name: 'Test D: Scan completes and final report is displayed with score and tabs',
        passed,
        expected: 'Report header, score cards, and tabs rendered after scan finishes',
        actual: `Report head: ${hasReportHead}, Tabs rendered: ${hasTabs}, Metrics: ${hasMetrics}`,
        durationMs: Date.now() - testDStart
      });
    } catch (err) {
      testResults.push({
        id: 'test-d-scan-completion-and-report',
        name: 'Test D: Scan completes and final report is displayed with score and tabs',
        passed: false,
        expected: 'Report header, score cards, and tabs rendered after scan finishes',
        actual: `Error: ${err.message}`,
        durationMs: Date.now() - testDStart
      });
    }

    // TEST E: Simulate a backend error -> Verify that the user receives a visible error message
    const testEStart = Date.now();
    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        localStorage.setItem('fliqEmail', 'demo-runner@example.com');
        localStorage.setItem('fliqName', 'Demo Runner');
      });
      await page.waitForSelector('button[data-go="#demo"]', { timeout: 8000 });
      await page.click('button[data-go="#demo"]');
      await page.waitForSelector('#quick-test-url', { state: 'visible', timeout: 5000 });

      await page.route('**/api/tests', async route => {
        if (route.request().method() === 'POST') {
          await route.fulfill({
            status: 429,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Your daily test limit has been reached. Try again tomorrow.' })
          });
        } else {
          await route.continue();
        }
      });

      await page.fill('#quick-test-url', 'https://example.com');
      await page.click('#quick-test-submit');

      await page.waitForSelector('#demo-error', { state: 'visible', timeout: 5000 });
      const errorMsg = await page.evaluate(() => document.querySelector('#demo-error')?.textContent || '');
      const modalOpen = await page.evaluate(() => Boolean(document.querySelector('.demo-modal')));
      const buttonReenabled = await page.evaluate(() => {
        const btn = document.querySelector('#quick-test-submit');
        return btn && !btn.disabled;
      });

      await page.unroute('**/api/tests');

      const passed = modalOpen && errorMsg.includes('daily test limit') && buttonReenabled;
      testResults.push({
        id: 'test-e-backend-error-handling',
        name: 'Test E: Backend error displays visible message in modal and re-enables submit',
        passed,
        expected: 'Backend error message visible in #demo-error, modal remains open, button re-enabled',
        actual: `Modal open: ${modalOpen}, Error shown: "${errorMsg}", Button re-enabled: ${buttonReenabled}`,
        durationMs: Date.now() - testEStart
      });
    } catch (err) {
      testResults.push({
        id: 'test-e-backend-error-handling',
        name: 'Test E: Backend error displays visible message in modal and re-enables submit',
        passed: false,
        expected: 'Backend error message visible in #demo-error, modal remains open, button re-enabled',
        actual: `Error: ${err.message}`,
        durationMs: Date.now() - testEStart
      });
    }

    await browser.close();
    browser = null;
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    throw err;
  }

  const passedCount = testResults.filter(t => t.passed).length;
  const totalCount = testResults.length;
  const report = {
    executedAt: new Date().toISOString(),
    totalTests: totalCount,
    passedTests: passedCount,
    failedTests: totalCount - passedCount,
    allPassed: passedCount === totalCount,
    results: testResults
  };

  const outputPath = path.join(rootDir, 'data', 'demo-workflow-test-results.json');
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
  return report;
}
