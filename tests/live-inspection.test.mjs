import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runLiveInspectionTests } from '../lib/live-inspection-tests.js';

describe('FLIQ Live Website Inspection Verification Suite', async () => {
  const report = await runLiveInspectionTests();

  for (const testCase of report.results) {
    test(`[${testCase.passed ? 'PASS' : 'FAIL'}] ${testCase.id}: ${testCase.name}`, () => {
      assert.equal(testCase.passed, true, `Test failed: ${JSON.stringify(testCase.details)}`);
    });
  }

  test('All live inspection tests pass with 100% accuracy', () => {
    assert.equal(report.allPassed, true, `Expected 0 failed tests, but got ${report.failedTests} failed`);
  });
});
