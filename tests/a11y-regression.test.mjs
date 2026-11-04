import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runA11yRegressionSuite, REGRESSION_TEST_CASES } from '../lib/a11y-regression-runner.js';

describe('FLIQ Comprehensive Audit Regression Test Suite', async () => {
  const report = await runA11yRegressionSuite();

  for (const testCase of report.suiteResults) {
    test(`[${testCase.passed ? 'PASS' : 'FAIL'}] [${testCase.category}] ${testCase.id}: ${testCase.name}`, () => {
      assert.equal(testCase.passed, true, `Expected: ${testCase.expected}, but got: ${testCase.actual}`);
    });
  }

  test('All multi-category regression tests pass without false positives', () => {
    assert.equal(report.allPassed, true, `Expected 0 failed tests, but got ${report.failedTests} failed`);
  });
});
