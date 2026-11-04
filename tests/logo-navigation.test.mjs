import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runLogoNavigationTests } from '../lib/logo-navigation-tests.js';

describe('FLIQ Authentication-Aware Global Logo Navigation Test Suite', async () => {
  const report = await runLogoNavigationTests();

  for (const t of report.tests) {
    test(`[${t.passed ? 'PASS' : 'FAIL'}] ${t.name}`, () => {
      assert.equal(t.passed, true, `Expected: ${t.expected}, Actual: ${t.actual}`);
    });
  }

  test('All logo navigation tests pass without regressions', () => {
    assert.equal(report.allPassed, true, `Expected all tests to pass, but got ${report.failedTests} failed.`);
  });
});
