import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runReportConsistencyTests } from '../lib/report-consistency-tests.js';

describe('FLIQ Report Consistency & Reconciliation Regression Test Suite', async () => {
  const report = await runReportConsistencyTests();

  for (const testCase of report.results) {
    test(`[${testCase.passed ? 'PASS' : 'FAIL'}] ${testCase.id}: ${testCase.name}`, () => {
      assert.equal(testCase.passed, true, `Test failed: ${JSON.stringify(testCase.details)}`);
    });
  }

  test('All report consistency and reconciliation tests pass with 100% accuracy', () => {
    assert.equal(report.allPassed, true, `Expected 0 failed tests, but got ${report.failedTests} failed`);
  });
});
