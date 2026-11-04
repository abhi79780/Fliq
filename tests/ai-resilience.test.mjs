import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runAIResilienceTests } from '../lib/ai-resilience-tests.js';

describe('FLIQ Deterministic Quality & Fallback Analysis Test Suite', async () => {
  const report = await runAIResilienceTests();

  for (const testCase of report.results) {
    test(`[${testCase.passed ? 'PASS' : 'FAIL'}] [${testCase.scenario}] ${testCase.id}: ${testCase.name}`, () => {
      assert.equal(testCase.passed, true, `Test failed: ${JSON.stringify(testCase.details)}`);
    });
  }

  test('All AI resilience and fallback tests pass without errors', () => {
    assert.equal(report.allPassed, true, `Expected 0 failed tests, but got ${report.failedTests} failed`);
  });
});
