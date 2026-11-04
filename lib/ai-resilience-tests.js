/**
 * FLIQ Deterministic Quality & Fallback Analysis Test Suite
 * 
 * Verifies that FLIQ functions 100% reliably and deterministically without Groq:
 * - Scenario A: Operates fully without any Groq configuration or API keys
 * - Scenario B: Generates deterministic quality summary for scans with findings
 * - Scenario C: Generates standard quality summary for clean scans with 0 critical findings
 * - Scenario D: Issue enrichment provides rule-based explanations and category-specific fixes
 * - Scenario E: Core evidence-based scoring calculations work reliably and accurately without Groq
 * - Scenario F: Report execution returns consistent report contract
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateDeterministicSummary,
  enrichIssuesWithRuleExplanations,
  executeAIOrFallbackReport
} from './ai-fallback-engine.js';
import { calculateCategoryScores } from './audit-orchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');

const SAMPLE_ISSUES = [
  {
    id: 'iss-a11y-contrast',
    ruleId: 'a11y-color-contrast',
    title: 'Low contrast text element (2.8:1)',
    category: 'Accessibility',
    severity: 'high',
    classification: 'Confirmed Failure',
    description: 'Text contrast ratio is below the required 4.5:1 ratio.',
    whyItMatters: 'Users with visual impairments cannot comfortably read this content.',
    expectedBehavior: 'Contrast ratio must be at least 4.5:1 for normal text.',
    recommendedFix: 'Darken text color or lighten background.',
    selector: '.hero-subtitle',
    htmlSnippet: '<p class="hero-subtitle">Muted subtitle</p>'
  },
  {
    id: 'iss-sec-csp',
    ruleId: 'sec-csp',
    title: 'Content-Security-Policy (CSP) header is missing',
    category: 'Security',
    severity: 'high',
    classification: 'Confirmed Failure',
    description: 'No Content-Security-Policy header detected on initial HTTP response.',
    whyItMatters: 'Prevents mitigation against cross-site scripting (XSS) and code injection.',
    expectedBehavior: 'Server must send a strict Content-Security-Policy header.',
    recommendedFix: "Configure Content-Security-Policy with default-src 'self'.",
    selector: 'headers',
    htmlSnippet: ''
  },
  {
    id: 'iss-perf-lcp',
    ruleId: 'perf-lcp',
    title: 'Largest Contentful Paint (LCP) exceeds 3.5s',
    category: 'Performance',
    severity: 'medium',
    classification: 'Potential Issue',
    description: 'Observed LCP was 3800ms, exceeding recommended 2500ms threshold.',
    whyItMatters: 'Slow loading times increase bounce rates and harm conversion.',
    expectedBehavior: 'LCP should occur in 2.5 seconds or less on mobile and desktop.',
    recommendedFix: 'Preload the hero image and optimize server response time.',
    selector: 'img.hero',
    htmlSnippet: '<img class="hero" src="/banner.jpg">'
  }
];

export async function runAIResilienceTests() {
  const results = [];
  const suiteStart = Date.now();

  const record = (id, scenario, name, passed, details = {}) => {
    results.push({
      id,
      scenario,
      name,
      passed,
      details,
      timestamp: new Date().toISOString()
    });
  };

  // --------------------------------------------------------------------------
  // Scenario A: Operates fully without any Groq configuration or API keys
  // --------------------------------------------------------------------------
  try {
    const reportA = await executeAIOrFallbackReport(SAMPLE_ISSUES, 'https://example.com');
    const passed = (
      reportA.isAiGenerated === false &&
      reportA.configured === false &&
      reportA.source === 'rule-based' &&
      typeof reportA.aiSummary === 'string' &&
      reportA.aiSummary.length > 50 &&
      reportA.aiSummary.includes('Standard Rule-Based Analysis') &&
      Array.isArray(reportA.issues) &&
      reportA.issues.length === 3 &&
      reportA.issues.every(i => typeof i.explanation === 'string' && i.isAiGenerated === false)
    );
    record('TEST_SCENARIO_A', 'Scenario A', 'Operates fully without any Groq configuration or API keys', passed, {
      isAiGenerated: reportA.isAiGenerated,
      source: reportA.source,
      summaryLength: reportA.aiSummary?.length,
      sampleExplanation: reportA.issues[0]?.explanation
    });
  } catch (err) {
    record('TEST_SCENARIO_A', 'Scenario A', 'Operates fully without any Groq configuration or API keys', false, { error: err.message });
  }

  // --------------------------------------------------------------------------
  // Scenario B: Generates deterministic quality summary for scans with findings
  // --------------------------------------------------------------------------
  try {
    const summaryB = generateDeterministicSummary(SAMPLE_ISSUES, 'https://example.com');
    const passed = (
      typeof summaryB === 'string' &&
      summaryB.includes('Standard Rule-Based Analysis') &&
      summaryB.includes('example.com') &&
      summaryB.includes('3 detected finding(s)') &&
      summaryB.includes('Top remediation priorities')
    );
    record('TEST_SCENARIO_B', 'Scenario B', 'Generates deterministic quality summary for scans with findings', passed, {
      summaryPreview: summaryB.slice(0, 100)
    });
  } catch (err) {
    record('TEST_SCENARIO_B', 'Scenario B', 'Generates deterministic quality summary for scans with findings', false, { error: err.message });
  }

  // --------------------------------------------------------------------------
  // Scenario C: Generates standard quality summary for clean scans with 0 critical findings
  // --------------------------------------------------------------------------
  try {
    const summaryC = generateDeterministicSummary([], 'https://example.com');
    const passed = (
      typeof summaryC === 'string' &&
      summaryC.includes('0 critical failures') &&
      summaryC.includes('meet baseline quality standards')
    );
    record('TEST_SCENARIO_C', 'Scenario C', 'Generates standard quality summary for clean scans with 0 critical findings', passed, {
      summary: summaryC
    });
  } catch (err) {
    record('TEST_SCENARIO_C', 'Scenario C', 'Generates standard quality summary for clean scans with 0 critical findings', false, { error: err.message });
  }

  // --------------------------------------------------------------------------
  // Scenario D: Issue enrichment provides rule-based explanations and category-specific fixes
  // --------------------------------------------------------------------------
  try {
    const rawIssues = [
      { id: '1', category: 'Accessibility', description: 'Missing image alt' },
      { id: '2', category: 'Security', description: 'Missing HSTS header' },
      { id: '3', category: 'Performance', description: 'High TTFB' },
      { id: '4', category: 'SEO', description: 'Missing title tag' }
    ];
    const enriched = enrichIssuesWithRuleExplanations(rawIssues);
    const passed = (
      enriched.length === 4 &&
      enriched.every(i => i.isAiGenerated === false && i.analysisType === 'rule-based') &&
      enriched.every(i => typeof i.explanation === 'string' && typeof i.recommendedFix === 'string') &&
      enriched[0].recommendedFix.includes('WCAG') &&
      enriched[1].recommendedFix.includes('HTTPS') &&
      enriched[2].recommendedFix.includes('caching') &&
      enriched[3].recommendedFix.includes('metadata')
    );
    record('TEST_SCENARIO_D', 'Scenario D', 'Issue enrichment provides rule-based explanations and category-specific fixes', passed, {
      enrichedCount: enriched.length,
      sampleFix: enriched[0].recommendedFix
    });
  } catch (err) {
    record('TEST_SCENARIO_D', 'Scenario D', 'Issue enrichment provides rule-based explanations and category-specific fixes', false, { error: err.message });
  }

  // --------------------------------------------------------------------------
  // Scenario E: Core evidence-based scoring calculations work reliably and accurately without Groq
  // --------------------------------------------------------------------------
  try {
    const enriched = enrichIssuesWithRuleExplanations(SAMPLE_ISSUES);
    const scores = calculateCategoryScores(enriched);
    const passed = (
      typeof scores.overallScore === 'number' &&
      scores.overallScore >= 0 &&
      scores.overallScore <= 100 &&
      typeof scores.categoryScores === 'object' &&
      (scores.categoryScores.accessibility !== undefined || scores.categoryScores.Accessibility !== undefined) &&
      (scores.categoryScores.security !== undefined || scores.categoryScores.Security !== undefined) &&
      (scores.categoryScores.performance !== undefined || scores.categoryScores.Performance !== undefined)
    );
    record('TEST_SCENARIO_E', 'Scenario E', 'Core evidence-based scoring works 100% without Groq', passed, {
      overallScore: scores.overallScore,
      categoryScores: scores.categoryScores
    });
  } catch (err) {
    record('TEST_SCENARIO_E', 'Scenario E', 'Core evidence-based scoring works 100% without Groq', false, { error: err.message });
  }

  // --------------------------------------------------------------------------
  // Scenario F: Report execution returns consistent report contract
  // --------------------------------------------------------------------------
  try {
    const reportF = await executeAIOrFallbackReport(SAMPLE_ISSUES, 'https://example.com');
    const passed = (
      reportF.configured === false &&
      reportF.isAiGenerated === false &&
      reportF.source === 'rule-based' &&
      Array.isArray(reportF.issues) &&
      typeof reportF.aiSummary === 'string'
    );
    record('TEST_SCENARIO_F', 'Scenario F', 'Report execution returns consistent report contract without Groq', passed, {
      configured: reportF.configured,
      isAiGenerated: reportF.isAiGenerated,
      source: reportF.source
    });
  } catch (err) {
    record('TEST_SCENARIO_F', 'Scenario F', 'Report execution returns consistent report contract without Groq', false, { error: err.message });
  }

  const passedCount = results.filter(r => r.passed).length;
  const totalCount = results.length;
  const durationMs = Date.now() - suiteStart;

  const suiteReport = {
    suite: 'FLIQ Deterministic Quality & Fallback Analysis Test Suite',
    executedAt: new Date().toISOString(),
    durationMs,
    totalTests: totalCount,
    passedTests: passedCount,
    failedTests: totalCount - passedCount,
    allPassed: passedCount === totalCount,
    results
  };

  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'ai-resilience-test-results.json'),
      JSON.stringify(suiteReport, null, 2),
      'utf8'
    );
  } catch (saveErr) {
    console.error('[FLIQ] Failed to save test results:', saveErr.message);
  }

  return suiteReport;
}
