import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, closeServer, server } from '../server.js';
import { runPricingAuthTests } from '../lib/pricing-auth-tests.js';

describe('FLIQ Pricing & Authentication Integration Verification Suite', async () => {
  let testServerUrl;
  let report = null;

  // Use FLIQ_TEST_PORT if configured, else 0 for a dynamic OS-assigned port
  const requestedPort = process.env.FLIQ_TEST_PORT ? parseInt(process.env.FLIQ_TEST_PORT, 10) : 0;

  after(async () => {
    await closeServer();
  });

  try {
    // 1. Automatically start a dedicated local test server
    await startServer(requestedPort, '127.0.0.1');
    const addr = server.address();
    const actualPort = (typeof addr === 'object' && addr?.port) ? addr.port : (requestedPort || 3000);
    testServerUrl = `http://127.0.0.1:${actualPort}`;

    // 2. Poll /api/health until successful response is received
    const healthDeadline = Date.now() + 10000;
    let isHealthy = false;
    while (Date.now() < healthDeadline) {
      try {
        const res = await fetch(`${testServerUrl}/api/health`);
        if (res.ok) {
          const body = await res.json();
          if (body.ok) {
            isHealthy = true;
            break;
          }
        }
      } catch {
        // Server still initializing
      }
      await new Promise(r => setTimeout(r, 100));
    }

    if (!isHealthy) {
      throw new Error(`Test server at ${testServerUrl} failed to become healthy within 10s`);
    }

    // 3. Execute the full pricing & auth verification suite against the active test server
    report = await runPricingAuthTests(undefined, testServerUrl);
  } catch (err) {
    await closeServer();
    throw err;
  }

  // 4. Register individual test assertions for granular test reporting
  for (const testCase of report?.results || []) {
    test(`[${testCase.passed ? 'PASS' : 'FAIL'}] ${testCase.id}: ${testCase.name}`, () => {
      assert.equal(testCase.passed, true, `Test failed: ${testCase.actual} (Expected: ${testCase.expected})`);
    });
  }

  test('All pricing and authentication integration tests pass with 100% accuracy', () => {
    assert.ok(report, 'Report should be generated');
    assert.equal(report.allPassed, true, `Expected 0 failed tests, but got ${report.failedTests} failed`);
  });
});
