import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runPricingAuthTests } from '../lib/pricing-auth-tests.js';

describe('FLIQ Pricing & Authentication Integration Verification Suite', async () => {
  const report = await runPricingAuthTests();

  for (const testCase of report.results) {
    test(`[${testCase.passed ? 'PASS' : 'FAIL'}] ${testCase.id}: ${testCase.name}`, () => {
      assert.equal(testCase.passed, true, `Test failed: ${testCase.actual} (Expected: ${testCase.expected})`);
    });
  }

  test('All pricing and authentication integration tests pass with 100% accuracy', () => {
    assert.equal(report.allPassed, true, `Expected 0 failed tests, but got ${report.failedTests} failed`);
  });
});
