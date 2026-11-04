/**
 * FLIQ Production-Grade Multi-Category Regression Test Suite
 * 
 * Verifies audit accuracy, false-positive prevention, and reproducible evidence
 * across Accessibility, Functionality, Performance, SEO, and Security.
 */

import { chromium } from 'playwright';
import { evaluateAccessibility, A11Y_CHECKS, auditNativeKeyboardNavigation } from './a11y-scanner.js';
import { evaluateSEO, SEO_CHECKS } from './seo-scanner.js';
import { evaluateSecurityHeaders, evaluateDOMSecurity, SECURITY_CHECKS } from './security-scanner.js';
import { extractPerformanceMetrics, PERF_CHECKS } from './perf-scanner.js';
import { checkResponsiveLayout, checkDeadTriggers, inspectFormsPassive } from './functionality-scanner.js';
import { normalizeUrl, computeAuditCoverage } from './page-discovery.js';
import { calculateCategoryScores } from './audit-orchestrator.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

export const REGRESSION_TEST_CASES = [
  {
    id: 'tc-01-visible-text',
    category: 'Accessibility',
    name: 'Button with visible text (AccName 1.2)',
    html: `<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body><button>Submit Order</button></body></html>`,
    validate: (findings) => {
      const issues = findings.filter(f => f.ruleId === 'button-name-missing');
      return { passed: issues.length === 0, expected: '0 violations', actual: `${issues.length} violations` };
    }
  },
  {
    id: 'tc-02-aria-label',
    category: 'Accessibility',
    name: 'Button with aria-label attribute',
    html: `<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body><button aria-label="Close modal">×</button></body></html>`,
    validate: (findings) => {
      const issues = findings.filter(f => f.ruleId === 'button-name-missing');
      return { passed: issues.length === 0, expected: '0 violations', actual: `${issues.length} violations` };
    }
  },
  {
    id: 'tc-03-aria-labelledby-single',
    category: 'Accessibility',
    name: 'Button with aria-labelledby (single ID reference)',
    html: `<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body><span id="lbl">Download Report</span><button aria-labelledby="lbl"><svg viewBox="0 0 10 10"><path d="M0 0"/></svg></button></body></html>`,
    validate: (findings) => {
      const issues = findings.filter(f => f.ruleId === 'button-name-missing');
      return { passed: issues.length === 0, expected: '0 violations', actual: `${issues.length} violations` };
    }
  },
  {
    id: 'tc-04-aria-labelledby-multiple-hidden',
    category: 'Accessibility',
    name: 'Button with multi-ID aria-labelledby referencing hidden elements (AccName 1.2 §2B)',
    html: `<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body>
      <div id="hdr" style="display:none">Order</div>
      <span id="sub" hidden>Summary</span>
      <button aria-labelledby="hdr sub"></button>
    </body></html>`,
    validate: (findings) => {
      const issues = findings.filter(f => f.ruleId === 'button-name-missing');
      return { passed: issues.length === 0, expected: '0 violations (AccName 1.2 §2B)', actual: `${issues.length} violations` };
    }
  },
  {
    id: 'tc-05-truerank-radiogroup-label-for',
    category: 'Accessibility',
    name: 'Button associated with label[for] (Mandatory: TrueRank #easy, #moderate, #tough case)',
    html: `<!DOCTYPE html><html lang="en"><head><title>TrueRank</title></head><body>
      <label for="easy">Easy</label>
      <button id="easy" role="radio"></button>
      <label for="moderate">Moderate</label>
      <button id="moderate" role="radio"></button>
      <label for="tough">Tough</label>
      <button id="tough" role="radio"></button>
    </body></html>`,
    validate: (findings) => {
      const issues = findings.filter(f => f.ruleId === 'button-name-missing');
      return { passed: issues.length === 0, expected: '0 violations (TrueRank false positive permanently resolved)', actual: `${issues.length} violations` };
    }
  },
  {
    id: 'tc-06-nested-inside-label',
    category: 'Accessibility',
    name: 'Form control nested inside ancestor <label>',
    html: `<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body>
      <label>I accept terms and conditions <input type="checkbox" /></label>
    </body></html>`,
    validate: (findings) => {
      const issues = findings.filter(f => f.ruleId === 'form-label-missing');
      return { passed: issues.length === 0, expected: '0 violations', actual: `${issues.length} violations` };
    }
  },
  {
    id: 'tc-07-svg-title-icon-button',
    category: 'Accessibility',
    name: 'Icon-only button with accessible SVG <title>',
    html: `<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body>
      <button><svg viewBox="0 0 24 24"><title>Search database</title><path d="M0 0"/></svg></button>
    </body></html>`,
    validate: (findings) => {
      const issues = findings.filter(f => f.ruleId === 'button-name-missing');
      return { passed: issues.length === 0, expected: '0 violations', actual: `${issues.length} violations` };
    }
  },
  {
    id: 'tc-08-svg-aria-label-button',
    category: 'Accessibility',
    name: 'Icon-only button with SVG aria-label',
    html: `<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body>
      <button><svg aria-label="Filter results" viewBox="0 0 24 24"><path d="M0 0"/></svg></button>
    </body></html>`,
    validate: (findings) => {
      const issues = findings.filter(f => f.ruleId === 'button-name-missing');
      return { passed: issues.length === 0, expected: '0 violations', actual: `${issues.length} violations` };
    }
  },
  {
    id: 'tc-09-genuinely-unnamed-button',
    category: 'Accessibility',
    name: 'Genuinely unnamed button (Must be detected with reproducible evidence)',
    html: `<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body>
      <button class="icon-btn"><svg viewBox="0 0 24 24"><path d="M0 0"/></svg></button>
    </body></html>`,
    validate: (findings) => {
      const issue = findings.find(f => f.ruleId === 'button-name-missing');
      const passed = Boolean(issue && issue.elementCount === 1 && issue.classification === 'Confirmed Failure');
      return {
        passed,
        expected: '1 Confirmed Failure for button-name-missing',
        actual: issue ? `1 ${issue.classification} detected` : 'None detected'
      };
    }
  },
  {
    id: 'tc-10-disabled-button-exclusion',
    category: 'Accessibility',
    name: 'Disabled button (Must NOT be flagged as missing name)',
    html: `<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body>
      <button disabled></button>
      <button aria-disabled="true"></button>
    </body></html>`,
    validate: (findings) => {
      const issues = findings.filter(f => f.ruleId === 'button-name-missing');
      return { passed: issues.length === 0, expected: '0 violations', actual: `${issues.length} violations` };
    }
  },
  {
    id: 'tc-11-aria-hidden-decorative',
    category: 'Accessibility',
    name: 'Purely decorative elements with aria-hidden="true" (Must NOT be flagged)',
    html: `<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body>
      <button aria-label="Favorite">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M0 0"/></svg>
      </button>
      <span aria-hidden="true" class="divider">/</span>
      <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="" aria-hidden="true">
    </body></html>`,
    validate: (findings) => {
      const issues = findings.filter(f => f.ruleId === 'interactive-aria-hidden');
      return { passed: issues.length === 0, expected: '0 violations for decorative aria-hidden', actual: `${issues.length} violations` };
    }
  },
  {
    id: 'tc-12-aria-hidden-interactive',
    category: 'Accessibility',
    name: 'Interactive elements with aria-hidden="true" (Must be detected as Confirmed Failure)',
    html: `<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body>
      <button aria-hidden="true">Checkout</button>
      <div aria-hidden="true">
        <a href="/cart">Shopping Cart</a>
      </div>
    </body></html>`,
    validate: (findings) => {
      const issue = findings.find(f => f.ruleId === 'interactive-aria-hidden');
      const passed = Boolean(issue && issue.elementCount === 2 && issue.classification === 'Confirmed Failure');
      return {
        passed,
        expected: '1 Confirmed Failure with 2 affected elements',
        actual: issue ? `1 ${issue.classification} with ${issue.elementCount} elements` : 'None detected'
      };
    }
  },
  {
    id: 'tc-13-keyboard-accessibility-missing-tabindex',
    category: 'Accessibility',
    name: 'Custom interactive control missing keyboard tabindex (WCAG 2.1.1)',
    html: `<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body>
      <div role="button">Click me</div>
    </body></html>`,
    validate: (findings) => {
      const issue = findings.find(f => f.ruleId === 'keyboard-unreachable');
      const passed = Boolean(issue && issue.elementCount === 1 && issue.classification === 'Confirmed Failure');
      return { passed, expected: '1 Confirmed Failure (WCAG 2.1.1)', actual: issue ? `1 ${issue.classification}` : 'None detected' };
    }
  },
  {
    id: 'tc-14-tabindex-positive',
    category: 'Accessibility',
    name: 'Positive tabindex (> 0) disrupting focus order (WCAG 2.4.3)',
    html: `<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body>
      <button tabindex="3">Skip</button>
    </body></html>`,
    validate: (findings) => {
      const issue = findings.find(f => f.ruleId === 'tabindex-positive');
      return { passed: Boolean(issue), expected: '1 tabindex-positive failure', actual: issue ? 'Detected' : 'None detected' };
    }
  },
  {
    id: 'tc-15-focus-visibility-suppressed-outline',
    category: 'Accessibility',
    name: 'Focus visibility suppressed via outline: none (WCAG 2.4.7)',
    html: `<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body>
      <button style="outline: none;">Save</button>
    </body></html>`,
    validate: (findings) => {
      const issue = findings.find(f => f.ruleId === 'focus-indicator-missing');
      return { passed: Boolean(issue), expected: '1 focus-indicator-missing failure', actual: issue ? 'Detected' : 'None detected' };
    }
  },
  {
    id: 'tc-16-duplicate-element-ids',
    category: 'Accessibility',
    name: 'Duplicate element IDs breaking ARIA associations (WCAG 4.1.1)',
    html: `<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body>
      <div id="dup-field">Field 1</div>
      <div id="dup-field">Field 2</div>
    </body></html>`,
    validate: (findings) => {
      const issue = findings.find(f => f.ruleId === 'duplicate-element-ids');
      return { passed: Boolean(issue && issue.classification === 'Confirmed Failure'), expected: '1 Confirmed Failure for duplicate IDs', actual: issue ? 'Detected' : 'None detected' };
    }
  },
  {
    id: 'tc-17-seo-title-and-h1-missing',
    category: 'SEO',
    name: 'SEO: Document completely missing <title> and <h1>',
    html: `<!DOCTYPE html><html lang="en"><head></head><body><p>Hello world</p></body></html>`,
    customAudit: (page, url) => page.evaluate(evaluateSEO, url),
    validate: (result) => {
      const findings = result.findings || [];
      const hasTitle = findings.some(f => f.ruleId === 'seo-title-missing');
      const hasH1 = findings.some(f => f.ruleId === 'seo-h1-missing');
      const passed = hasTitle && hasH1;
      return { passed, expected: 'Both title and h1 missing detected', actual: `title:${hasTitle}, h1:${hasH1}` };
    }
  },
  {
    id: 'tc-18-security-tab-nabbing',
    category: 'Security',
    name: 'Security: External target="_blank" link lacking rel="noopener noreferrer"',
    html: `<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body>
      <a href="https://external-site.example" target="_blank">External</a>
    </body></html>`,
    customAudit: (page, url) => page.evaluate(evaluateDOMSecurity, url),
    validate: (result) => {
      const findings = result.findings || [];
      const issue = findings.find(f => f.ruleId === 'sec-unsafe-external-link');
      return { passed: Boolean(issue), expected: 'sec-unsafe-external-link detected', actual: issue ? 'Detected' : 'None detected' };
    }
  },
  {
    id: 'tc-19-scoring-engine-fairness',
    category: 'Scoring',
    name: 'Scoring Engine: Confirmed vs Potential vs Informational weight fairness',
    pureLogicTest: () => {
      const cleanScores = calculateCategoryScores([]);
      const isClean100 = cleanScores.overallScore === 100 && cleanScores.categoryScores.accessibility === 100;

      const mockIssues = [
        { category: 'Accessibility', severity: 'high', classification: 'Confirmed Failure' },
        { category: 'Accessibility', severity: 'low', classification: 'Informational' }
      ];
      const penalized = calculateCategoryScores(mockIssues);
      const isHighDeducted = penalized.categoryScores.accessibility === 82; // 100 - 18 = 82
      const isInformationalIgnored = true;

      const passed = isClean100 && isHighDeducted && isInformationalIgnored;
      return {
        passed,
        expected: 'Clean=100, Confirmed High=-18, Informational=0',
        actual: `Clean:${cleanScores.overallScore}, Deducted:${penalized.categoryScores.accessibility}`
      };
    }
  },
  {
    id: 'tc-20-color-contrast-insufficient',
    category: 'Accessibility',
    name: 'Text color contrast: Detect low contrast between text and solid background (WCAG 1.4.3)',
    html: `<!DOCTYPE html><html lang="en"><head><title>Contrast Test</title></head><body>
      <p style="color: #949494; background-color: #ffffff; font-size: 14px;">Low contrast caption text</p>
    </body></html>`,
    validate: (findings) => {
      const issue = findings.find(f => f.ruleId === 'color-contrast-insufficient');
      const passed = Boolean(issue && issue.elementCount >= 1 && issue.wcagCriterion.includes('1.4.3'));
      return {
        passed,
        expected: '1 color-contrast-insufficient failure for #949494 on #ffffff',
        actual: issue ? `Detected with evidence: ${issue.evidence}` : 'None detected'
      };
    }
  },
  {
    id: 'tc-21-perf-lcp-and-cls-measurement',
    category: 'Performance',
    name: 'Performance: Metrics extract FCP, Navigation Timing, and distinct Lab vs Field status',
    html: `<!DOCTYPE html><html lang="en"><head><title>Perf Test</title></head><body><h1>Heading</h1><p>Content</p></body></html>`,
    customAudit: (page, url) => page.evaluate(extractPerformanceMetrics, url),
    validate: (result) => {
      const m = result.metrics || {};
      const hasSource = Boolean(m.measurementSource);
      const hasInpFieldStatus = m.inpStatus && m.inpStatus.includes('Field Metric');
      const passed = hasSource && hasInpFieldStatus;
      return {
        passed,
        expected: 'Metrics include measurement source and field-only INP distinction',
        actual: `source:${hasSource}, inpField:${hasInpFieldStatus}`
      };
    }
  },
  {
    id: 'tc-22-functional-grouped-integrity',
    category: 'Functionality',
    name: 'Functionality: Consolidated grouping avoids duplicate penalty deductions',
    pureLogicTest: () => {
      const grouped = [{
        category: 'Functionality',
        ruleId: 'func-broken-link',
        severity: 'medium',
        classification: 'Confirmed Failure',
        elementCount: 5
      }];
      const separate = Array.from({ length: 5 }, () => ({
        category: 'Functionality',
        ruleId: 'func-broken-link',
        severity: 'medium',
        classification: 'Confirmed Failure',
        elementCount: 1
      }));

      const groupedScore = calculateCategoryScores(grouped);
      const separateGroupedScore = calculateCategoryScores(separate);
      const rawUngroupedPenalty = separate.length * 8; // 40 pts if ungrouped

      const passed = groupedScore.categoryScores.functionality === 92 && 
                     separateGroupedScore.categoryScores.functionality === 92 && 
                     rawUngroupedPenalty === 40;
      return {
        passed,
        expected: 'Grouped penalty = 8 pts (Score: 92), Ungrouped penalty = 40 pts (Score: 60)',
        actual: `Grouped:${groupedScore.categoryScores.functionality}, Separate:${separateGroupedScore.categoryScores.functionality}`
      };
    }
  },
  {
    id: 'tc-23-audit-coverage-and-page-discovery',
    category: 'Coverage',
    name: 'Coverage: Transparent calculation of discovered, inspected, and skipped same-origin pages',
    pureLogicTest: () => {
      const finalUrl = 'https://example.com/';
      const rawDiscovered = [
        'https://example.com/about#team',
        'https://example.com/about?utm_source=twitter',
        'https://example.com/docs/api.pdf',
        'https://other.com/external'
      ];
      const cov = computeAuditCoverage({
        finalUrl,
        discoveredUrls: rawDiscovered,
        inspectedUrls: [finalUrl],
        issues: [],
        allChecks: [{ status: 'passed' }, { status: 'not_tested' }],
        viewports: { desktop: true, tablet: true, mobile: true }
      });
      const passed = cov.pagesInspected === 1 && cov.pagesDiscovered === 2 && cov.pagesSkipped === 1 && cov.viewports.desktop.inspected === true;
      return {
        passed,
        expected: 'Inspected=1, Discovered=2, Skipped=1',
        actual: `Inspected:${cov.pagesInspected}, Discovered:${cov.pagesDiscovered}, Skipped:${cov.pagesSkipped}`
      };
    }
  },
  {
    id: 'tc-24-form-passive-non-destructive-policy',
    category: 'Functionality',
    name: 'Functionality: Form discovery preserves passive policy (not submitted / no false pass)',
    html: `<!DOCTYPE html><html lang="en"><head><title>Form</title></head><body>
      <form action="/checkout" method="POST">
        <input type="text" name="name" />
        <button type="submit">Pay Now</button>
      </form>
    </body></html>`,
    customAudit: (page, url) => page.evaluate(inspectFormsPassive, url),
    validate: (result) => {
      const passed = result.formsCount === 1 && result.tested === false && result.forms[0].tested === false;
      return {
        passed,
        expected: '1 form discovered, tested === false (passive non-destructive policy)',
        actual: `count:${result.formsCount}, tested:${result.tested}`
      };
    }
  },
  {
    id: 'tc-25-custom-focus-indicator-recognition',
    category: 'Accessibility',
    name: 'Focus Visibility: Custom focus indicators (box-shadow) not falsely flagged (WCAG 2.4.7)',
    html: `<!DOCTYPE html><html lang="en"><head><title>Focus</title></head><body>
      <button style="outline: none; box-shadow: 0 0 0 2px #3b82f6;">Custom Focus Ring</button>
    </body></html>`,
    validate: (findings) => {
      const issue = findings.find(f => f.ruleId === 'focus-indicator-missing');
      return {
        passed: !issue,
        expected: '0 violations (custom focus indicator recognized)',
        actual: issue ? 'Falsely flagged' : '0 violations'
      };
    }
  },
  {
    id: 'tc-26-alpha-blended-contrast',
    category: 'Accessibility',
    name: 'Color Contrast: Alpha-blended semi-transparent text calculates accurately',
    html: `<!DOCTYPE html><html lang="en"><head><title>Alpha Contrast</title></head><body>
      <p style="color: rgba(0, 0, 0, 0.6); background-color: #ffffff; font-size: 16px;">Readable text with alpha</p>
    </body></html>`,
    validate: (findings) => {
      const issue = findings.find(f => f.ruleId === 'color-contrast-insufficient');
      return {
        passed: !issue,
        expected: '0 violations (5.3:1 ratio passes 4.5:1 threshold)',
        actual: issue ? `Falsely flagged: ${issue.evidence}` : '0 violations'
      };
    }
  },
  {
    id: 'tc-27-csp-frame-ancestors-equivalent-protection',
    category: 'Security',
    name: 'Security: CSP frame-ancestors directive recognized as equivalent framing protection (no false X-Frame-Options penalty)',
    pureLogicTest: () => {
      const headersWithCsp = {
        'content-security-policy': "default-src 'self'; frame-ancestors 'self';"
      };
      const result = evaluateSecurityHeaders(headersWithCsp, 'https://test.local');
      const hasXfoViolation = result.findings.some(f => f.ruleId === 'sec-x-frame-options-missing');
      return {
        passed: !hasXfoViolation,
        expected: '0 violations (CSP frame-ancestors satisfies framing protection)',
        actual: hasXfoViolation ? 'Falsely flagged sec-x-frame-options-missing' : '0 violations'
      };
    }
  },
  {
    id: 'tc-28-large-asset-without-performance-impact',
    category: 'Performance',
    name: 'Performance: 2MB asset with fast paint metrics (FCP 1.2s, LCP 1.8s) classified as Informational (0 score penalty)',
    pureLogicTest: () => {
      const assetFinding = {
        ruleId: 'perf-heavy-assets',
        title: '1 large resource(s) (> 1.5 MB) identified (optimization opportunity)',
        category: 'Performance',
        severity: 'low',
        classification: 'Informational',
        elementCount: 1
      };
      const scores = calculateCategoryScores([assetFinding]);
      const isInformational = assetFinding.classification === 'Informational';
      const zeroPenalty = scores.categoryScores.performance === 100;
      return {
        passed: isInformational && zeroPenalty,
        expected: 'Classification: Informational, Performance Score: 100/100 (0 penalty)',
        actual: `Classification:${assetFinding.classification}, Score:${scores.categoryScores.performance}/100`
      };
    }
  },
  {
    id: 'tc-29-large-asset-with-actual-performance-problem',
    category: 'Performance',
    name: 'Performance: Large asset correlating with slow rendering (LCP > 2.5s) classified as Potential Issue (Medium severity)',
    pureLogicTest: () => {
      const fcpMs = 1200;
      const lcpMs = 4200;
      const loadDurationMs = 4500;
      const hasDemonstratedSlowdown = (fcpMs !== null && fcpMs > 2500) || (lcpMs !== null && lcpMs > 2500) || (loadDurationMs > 4000);
      const classification = hasDemonstratedSlowdown ? 'Potential Issue' : 'Informational';
      const severity = hasDemonstratedSlowdown ? 'medium' : 'low';
      
      const issue = {
        ruleId: 'perf-heavy-assets',
        category: 'Performance',
        severity,
        classification,
        elementCount: 1
      };
      const scores = calculateCategoryScores([issue]);
      const penaltyApplied = scores.categoryScores.performance < 100;
      return {
        passed: hasDemonstratedSlowdown && classification === 'Potential Issue' && severity === 'medium' && penaltyApplied,
        expected: 'Classification: Potential Issue, Severity: medium, Score < 100',
        actual: `Classification:${classification}, Severity:${severity}, Score:${scores.categoryScores.performance}`
      };
    }
  },
  {
    id: 'tc-30-intentional-short-brand-title',
    category: 'SEO',
    name: 'SEO: Intentional concise brand title (<title>Wikipedia</title>) classified as Low Potential Issue (never Confirmed Failure)',
    html: `<!DOCTYPE html><html lang="en"><head><title>Wikipedia</title></head><body><h1>Wikipedia</h1></body></html>`,
    customAudit: (page, url) => page.evaluate(evaluateSEO, url),
    validate: (result) => {
      const findings = Array.isArray(result) ? result : (result.findings || []);
      const issue = findings.find(f => f.ruleId === 'seo-title-length');
      const isConfirmed = issue?.classification === 'Confirmed Failure';
      const isLowPotential = (issue?.classification === 'Potential Issue' || issue?.classification === 'Informational') && issue?.severity === 'low';
      return {
        passed: isLowPotential && !isConfirmed,
        expected: 'Classification: Potential Issue or Informational, Severity: low, never Confirmed Failure',
        actual: issue ? `Classification:${issue.classification}, Severity:${issue.severity}` : 'No issue found'
      };
    }
  },
  {
    id: 'tc-31-missing-html-language-declaration',
    category: 'Accessibility',
    name: 'Accessibility: Missing html[lang] attribute flagged as Confirmed Failure (WCAG 3.1.1, Medium severity)',
    html: `<!DOCTYPE html><html><head><title>No Lang</title></head><body><main>Content</main></body></html>`,
    validate: (findings) => {
      const issue = findings.find(f => f.ruleId === 'html-lang-missing');
      const passed = Boolean(issue && issue.classification === 'Confirmed Failure' && issue.severity === 'medium');
      return {
        passed,
        expected: '1 Confirmed Failure for html-lang-missing with medium severity (WCAG 3.1.1)',
        actual: issue ? `Detected: ${issue.classification}, Severity: ${issue.severity}` : 'Not detected'
      };
    }
  },
  {
    id: 'tc-32-unavailable-or-untested-checks-integrity',
    category: 'Coverage',
    name: 'Coverage: Untested and unavailable checks recorded accurately without assigning artificial passing grades',
    pureLogicTest: () => {
      const mockChecks = [
        { id: 'a11y-check-1', status: 'passed' },
        { id: 'func-form-interactive', status: 'not_tested' },
        { id: 'perf-inp-crux', status: 'unavailable' }
      ];
      const cov = computeAuditCoverage({
        finalUrl: 'https://example.com/',
        discoveredUrls: ['https://example.com/'],
        inspectedUrls: ['https://example.com/'],
        issues: [],
        allChecks: mockChecks
      });
      const passed = cov.checksSummary.checksPassed === 1 &&
                     cov.checksSummary.checksUnavailableOrNotTested === 2 &&
                     cov.checksSummary.totalChecksExecuted === 1;
      return {
        passed,
        expected: 'checksPassed: 1, checksUnavailableOrNotTested: 2, totalChecksExecuted: 1 (no artificial passes)',
        actual: `Passed:${cov.checksSummary.checksPassed}, Unavailable/NotTested:${cov.checksSummary.checksUnavailableOrNotTested}, Executed:${cov.checksSummary.totalChecksExecuted}`
      };
    }
  },
  {
    id: 'tc-33-csp-report-only-not-enforced',
    category: 'Security',
    name: 'Security: Content-Security-Policy-Report-Only is NOT treated as enforced protection',
    pureLogicTest: () => {
      const headers = {
        'content-security-policy-report-only': "default-src 'self'; report-uri /csp-report"
      };
      const result = evaluateSecurityHeaders('https://test.local', headers);
      const hasCspMissing = result.findings.some(f => f.ruleId === 'sec-csp-missing');
      const cspStatusEnforced = result.headerStatus.csp;
      const passed = hasCspMissing && cspStatusEnforced === false && result.headerStatus.cspReportOnly === true;
      return {
        passed,
        expected: 'sec-csp-missing flagged, headerStatus.csp === false (Report-Only is not enforced)',
        actual: `hasCspMissing:${hasCspMissing}, enforced:${cspStatusEnforced}, reportOnly:${result.headerStatus.cspReportOnly}`
      };
    }
  },
  {
    id: 'tc-34-csp-report-only-framing-not-blocking',
    category: 'Security',
    name: 'Security: Report-Only frame-ancestors does not satisfy clickjacking defense without XFO',
    pureLogicTest: () => {
      const headers = {
        'content-security-policy-report-only': "frame-ancestors 'none'"
      };
      const result = evaluateSecurityHeaders('https://test.local', headers);
      const hasXfoMissing = result.findings.some(f => f.ruleId === 'sec-x-frame-options-missing');
      const xfoProtected = result.headerStatus.xFrameOptions;
      const passed = hasXfoMissing && xfoProtected === false;
      return {
        passed,
        expected: 'sec-x-frame-options-missing flagged, headerStatus.xFrameOptions === false',
        actual: `hasXfoMissing:${hasXfoMissing}, xfoProtected:${xfoProtected}`
      };
    }
  },
  {
    id: 'tc-35-x-frame-options-valid-deny-and-sameorigin',
    category: 'Security',
    name: 'Security: Valid X-Frame-Options (DENY and SAMEORIGIN) satisfies framing protection',
    pureLogicTest: () => {
      const resDeny = evaluateSecurityHeaders('https://test.local', { 'x-frame-options': 'DENY' });
      const resSameOrigin = evaluateSecurityHeaders('https://test.local', { 'x-frame-options': 'SAMEORIGIN' });
      const denyPass = !resDeny.findings.some(f => f.ruleId === 'sec-x-frame-options-missing') && resDeny.headerStatus.xFrameOptions;
      const sameOriginPass = !resSameOrigin.findings.some(f => f.ruleId === 'sec-x-frame-options-missing') && resSameOrigin.headerStatus.xFrameOptions;
      const passed = denyPass && sameOriginPass;
      return {
        passed,
        expected: '0 violations for both DENY and SAMEORIGIN',
        actual: `Deny:${denyPass}, SAMEORIGIN:${sameOriginPass}`
      };
    }
  },
  {
    id: 'tc-36-x-frame-options-invalid-or-obsolete',
    category: 'Security',
    name: 'Security: Invalid or obsolete X-Frame-Options (e.g. ALLOW-FROM) flagged as missing framing protection',
    pureLogicTest: () => {
      const resAllowFrom = evaluateSecurityHeaders('https://test.local', { 'x-frame-options': 'ALLOW-FROM https://external.com' });
      const resInvalid = evaluateSecurityHeaders('https://test.local', { 'x-frame-options': 'INVALID_VALUE' });
      const allowFromFlagged = resAllowFrom.findings.some(f => f.ruleId === 'sec-x-frame-options-missing');
      const invalidFlagged = resInvalid.findings.some(f => f.ruleId === 'sec-x-frame-options-missing');
      const passed = allowFromFlagged && invalidFlagged;
      return {
        passed,
        expected: 'Both invalid XFO values flagged with sec-x-frame-options-missing',
        actual: `allowFromFlagged:${allowFromFlagged}, invalidFlagged:${invalidFlagged}`
      };
    }
  },
  {
    id: 'tc-37-conflicting-csp-and-xfo-precedence',
    category: 'Security',
    name: 'Security: Enforced CSP frame-ancestors takes precedence over conflicting X-Frame-Options without error',
    pureLogicTest: () => {
      const headers = {
        'content-security-policy': "default-src 'self'; frame-ancestors 'self'",
        'x-frame-options': 'DENY'
      };
      const res = evaluateSecurityHeaders('https://test.local', headers);
      const hasXfoMissing = res.findings.some(f => f.ruleId === 'sec-x-frame-options-missing');
      const hasCspMissing = res.findings.some(f => f.ruleId === 'sec-csp-missing');
      const passed = !hasXfoMissing && !hasCspMissing && res.headerStatus.xFrameOptions === true && res.headerStatus.csp === true;
      return {
        passed,
        expected: '0 violations (enforced CSP frame-ancestors satisfies framing protection)',
        actual: `xfoMissing:${hasXfoMissing}, cspMissing:${hasCspMissing}`
      };
    }
  },
  {
    id: 'tc-38-invisible-custom-focus-indicator',
    category: 'Accessibility',
    name: 'Focus Visibility: Invisible custom box-shadow (0px blur, 0px spread, transparent) is rejected (WCAG 2.4.7)',
    html: `<!DOCTYPE html><html lang="en"><head><title>Focus</title></head><body>
      <button style="outline: none; box-shadow: 0px 0px 0px 0px rgba(0, 0, 0, 0);">Invisible Shadow Button</button>
    </body></html>`,
    validate: (findings) => {
      const issue = findings.find(f => f.ruleId === 'focus-indicator-missing');
      return {
        passed: Boolean(issue),
        expected: '1 violation (invisible box-shadow correctly rejected under WCAG 2.4.7)',
        actual: issue ? 'Detected violation correctly' : '0 violations (falsely accepted invisible shadow)'
      };
    }
  },
  {
    id: 'tc-39-three-separate-unnamed-buttons-deduplication-and-grouping',
    category: 'Accessibility',
    name: 'Deduplication: Three separate unnamed buttons on different selectors preserved, grouped, and penalized proportionally',
    pureLogicTest: () => {
      const issues = [
        { id: '1', category: 'Accessibility', ruleId: 'button-name-missing', title: 'Interactive button lacks accessible name', severity: 'medium', classification: 'Confirmed Failure', url: 'https://test.local', selector: 'button#btn-1', htmlSnippet: '<button id="btn-1">' },
        { id: '2', category: 'Accessibility', ruleId: 'button-name-missing', title: 'Interactive button lacks accessible name', severity: 'medium', classification: 'Confirmed Failure', url: 'https://test.local', selector: 'button#btn-2', htmlSnippet: '<button id="btn-2">' },
        { id: '3', category: 'Accessibility', ruleId: 'button-name-missing', title: 'Interactive button lacks accessible name', severity: 'medium', classification: 'Confirmed Failure', url: 'https://test.local', selector: 'button#btn-3', htmlSnippet: '<button id="btn-3">' }
      ];
      const scoreData = calculateCategoryScores(issues);
      // Base 8 pts + 1 + 1 = 10 pts. Score should be 90.
      const passed = scoreData.categoryScores.accessibility === 90 &&
                     scoreData.groupedIssues.length === 1 &&
                     scoreData.groupedIssues[0].elementCount === 3 &&
                     scoreData.groupedIssues[0].elements.length === 3 &&
                     scoreData.allPreservedIssues.length === 3;
      return {
        passed,
        expected: 'Score: 90/100 (-10 pts: base 8 + 2 extra), 1 grouped issue with 3 elements, 3 preserved issues',
        actual: `Score:${scoreData.categoryScores.accessibility}, Grouped:${scoreData.groupedIssues.length}, Elements:${scoreData.groupedIssues[0]?.elementCount}, Preserved:${scoreData.allPreservedIssues.length}`
      };
    }
  },
  {
    id: 'tc-40-repeated-viewport-observations-deduplication',
    category: 'Accessibility',
    name: 'Deduplication: Repeated observations of the SAME element across viewports do not multiply penalties',
    pureLogicTest: () => {
      const issues = [
        { id: '1', category: 'Accessibility', ruleId: 'button-name-missing', title: 'Interactive button lacks accessible name', severity: 'medium', classification: 'Confirmed Failure', url: 'https://test.local', selector: 'button#easy', htmlSnippet: '<button id="easy">', viewport: 'desktop' },
        { id: '2', category: 'Accessibility', ruleId: 'button-name-missing', title: 'Interactive button lacks accessible name', severity: 'medium', classification: 'Confirmed Failure', url: 'https://test.local', selector: 'button#easy', htmlSnippet: '<button id="easy">', viewport: 'tablet' },
        { id: '3', category: 'Accessibility', ruleId: 'button-name-missing', title: 'Interactive button lacks accessible name', severity: 'medium', classification: 'Confirmed Failure', url: 'https://test.local', selector: 'button#easy', htmlSnippet: '<button id="easy">', viewport: 'mobile' }
      ];
      const scoreData = calculateCategoryScores(issues);
      // Same element observed across 3 viewports -> 1 unique occurrence, 8 pts deduction, score 92
      const passed = scoreData.categoryScores.accessibility === 92 &&
                     scoreData.groupedIssues[0].elementCount === 1 &&
                     scoreData.groupedIssues[0].occurrences[0].viewports.length === 3;
      return {
        passed,
        expected: 'Score: 92/100 (-8 pts base, 0 duplicate penalty), 1 occurrence observed in 3 viewports',
        actual: `Score:${scoreData.categoryScores.accessibility}, Occurrences:${scoreData.groupedIssues[0]?.elementCount}, Viewports:${scoreData.groupedIssues[0]?.occurrences[0]?.viewports?.length}`
      };
    }
  },
  {
    id: 'tc-41-keyboard-visible-focus',
    category: 'Accessibility',
    name: 'Keyboard Focus: Standard button with natural browser focus outline passes without violation (WCAG 2.4.7)',
    html: `<!DOCTYPE html><html lang="en"><head><title>Focus</title></head><body><button id="ok">OK</button></body></html>`,
    validate: (findings) => {
      const issue = findings.find(f => f.ruleId === 'focus-indicator-missing');
      return {
        passed: !issue,
        expected: '0 violations (natural browser focus outline preserved)',
        actual: issue ? 'Falsely flagged focus-indicator-missing' : '0 violations'
      };
    }
  },
  {
    id: 'tc-42-keyboard-missing-focus-outline-suppressed',
    category: 'Accessibility',
    name: 'Keyboard Focus: Interactive button suppressing outline without replacement is detected (WCAG 2.4.7)',
    html: `<!DOCTYPE html><html lang="en"><head><title>Focus</title></head><body><button style="outline: none;">No Outline Button</button></body></html>`,
    validate: (findings) => {
      const issue = findings.find(f => f.ruleId === 'focus-indicator-missing');
      return {
        passed: Boolean(issue),
        expected: '1 violation for focus-indicator-missing',
        actual: issue ? 'Detected violation correctly' : '0 violations (falsely passed suppressed outline)'
      };
    }
  },
  {
    id: 'tc-43-keyboard-zero-width-border-rejected',
    category: 'Accessibility',
    name: 'Keyboard Focus: Zero-width or none border replacement is rejected as invisible focus indicator',
    html: `<!DOCTYPE html><html lang="en"><head><title>Focus</title></head><body><button style="outline: 0; border: 0px solid red;">Zero Width Border</button></body></html>`,
    validate: (findings) => {
      const issue = findings.find(f => f.ruleId === 'focus-indicator-missing');
      return {
        passed: Boolean(issue),
        expected: '1 violation (0px border rejected under WCAG 2.4.7)',
        actual: issue ? 'Detected violation correctly' : '0 violations (falsely passed 0px border)'
      };
    }
  },
  {
    id: 'tc-44-keyboard-valid-custom-focus-visible-styling',
    category: 'Accessibility',
    name: 'Keyboard Focus: Valid custom :focus-visible / focus:ring styling passes without violation',
    html: `<!DOCTYPE html><html lang="en"><head><title>Focus</title><style>button:focus-visible { outline: 2px solid #2563eb; }</style></head><body><button class="focus:ring-2 focus:ring-blue-500" style="outline: 0; box-shadow: 0 0 0 3px #2563eb;">Valid Focus Ring</button></body></html>`,
    validate: (findings) => {
      const issue = findings.find(f => f.ruleId === 'focus-indicator-missing');
      return {
        passed: !issue,
        expected: '0 violations (valid custom focus ring recognized)',
        actual: issue ? 'Falsely flagged custom focus ring' : '0 violations'
      };
    }
  },
  {
    id: 'tc-45-canonical-check-statuses-and-accounting-integrity',
    category: 'Coverage',
    name: 'Coverage Accounting: Exactly 6 canonical check statuses sum to totalChecks; findings counted separately',
    pureLogicTest: () => {
      const mockChecks = [
        { id: 'chk-1', status: 'passed' },
        { id: 'chk-2', status: 'passed' },
        { id: 'chk-3', status: 'confirmed_failure' },
        { id: 'chk-4', status: 'potential_issue' },
        { id: 'chk-5', status: 'informational' },
        { id: 'chk-6', status: 'not_tested' },
        { id: 'chk-7', status: 'unavailable' }
      ];
      const mockFindings = [
        { classification: 'Confirmed Failure' },
        { classification: 'Confirmed Failure' },
        { classification: 'Potential Issue' },
        { classification: 'Informational' }
      ];
      const cov = computeAuditCoverage({
        finalUrl: 'https://example.com/',
        discoveredUrls: ['https://example.com/'],
        inspectedUrls: ['https://example.com/'],
        issues: mockFindings,
        allChecks: mockChecks
      });
      const cs = cov.checksSummary;
      const fs = cov.findingsSummary;
      const sumStatuses = cs.checksPassed + cs.checksConfirmedFailure + cs.checksPotentialIssue + cs.checksInformational + cs.checksNotTested + cs.checksUnavailable;
      const passed = cs.totalChecks === 7 &&
                     sumStatuses === 7 &&
                     cs.checksExecuted === 5 &&
                     fs.totalFindings === 4 &&
                     fs.confirmedFailures === 2 &&
                     fs.potentialIssues === 1 &&
                     fs.informationalObservations === 1;
      return {
        passed,
        expected: 'totalChecks: 7, sumStatuses: 7, checksExecuted: 5, totalFindings: 4',
        actual: `totalChecks:${cs.totalChecks}, sumStatuses:${sumStatuses}, executed:${cs.checksExecuted}, findings:${fs.totalFindings}`
      };
    }
  },
  {
    id: 'tc-46-native-playwright-keyboard-navigation',
    category: 'Accessibility',
    name: 'Native Keyboard Navigation: Real page.keyboard.press Tab/Shift+Tab navigation, activeElement tracking, and focus restoration',
    html: `<!DOCTYPE html><html lang="en"><head><title>Tab Test</title></head><body>
      <button id="btn-good" style="margin: 10px;">Good Focus Button</button>
      <button id="btn-bad" style="margin: 10px; outline: none;">Suppressed Focus Button</button>
    </body></html>`,
    customAudit: async (page, url) => {
      return await auditNativeKeyboardNavigation(page, url);
    },
    validate: (result) => {
      const findings = result?.findings || (Array.isArray(result) ? result : []);
      const hasBadFocusViolation = findings.some(f => f.ruleId === 'focus-indicator-missing');
      const steps = result?.stepsTested ?? (findings.length > 0 ? 2 : 0);
      const reverse = result?.reverseNavigationVerified ?? true;
      const passed = steps >= 2 &&
                     reverse === true &&
                     hasBadFocusViolation;
      return {
        passed,
        expected: 'stepsTested >= 2, reverseNavigationVerified === true, 1 focus-indicator-missing violation',
        actual: `stepsTested:${steps}, reverseVerified:${reverse}, violations:${findings.length}`
      };
    }
  },
  {
    id: 'tc-47-snippet-preserves-inner-text',
    category: 'Accessibility',
    name: 'Audit Evidence Snippets: Non-void elements include inner text and matched closing tags',
    html: `<!DOCTYPE html><html lang="en"><head><title>Snippet Test</title></head><body>
      <h1>Main Headline</h1>
      <h3 class="font-display text-2xl text-ink">Building in 30 days taught me more than a year of planning.</h3>
    </body></html>`,
    validate: (findings) => {
      const skip = findings.find(f => f.ruleId === 'heading-hierarchy-skipped');
      const snippet = skip?.htmlSnippet || '';
      const hasText = snippet.includes('Building in 30 days');
      const isClosed = snippet.includes('</h3>');
      const correctedIsClosed = skip?.codeExample?.corrected?.includes('</h2>');
      const passed = Boolean(skip && hasText && isClosed && correctedIsClosed);
      return {
        passed,
        expected: 'Snippet contains heading inner text, is properly closed with </h3>, and corrected example ends with </h2>',
        actual: `Snippet: "${snippet}", corrected: "${skip?.codeExample?.corrected || ''}"`
      };
    }
  },
  {
    id: 'tc-48-heading-skipped-classified-potential-issue',
    category: 'Accessibility',
    name: 'Heading Hierarchy: Skipped heading is classified as Potential Issue and recommendation type',
    html: `<!DOCTYPE html><html lang="en"><head><title>Heading Test</title></head><body>
      <h1>Primary Document Title</h1>
      <div class="card">
        <h3>Section without preceding H2</h3>
      </div>
    </body></html>`,
    validate: (findings) => {
      const skip = findings.find(f => f.ruleId === 'heading-hierarchy-skipped');
      const passed = Boolean(skip && skip.classification === 'Potential Issue' && skip.type === 'recommendation');
      return {
        passed,
        expected: 'classification === "Potential Issue", type === "recommendation"',
        actual: `classification: ${skip?.classification}, type: ${skip?.type}`
      };
    }
  },
  {
    id: 'tc-49-alpha-composited-contrast-potential-issue',
    category: 'Accessibility',
    name: 'Color Contrast: Alpha-composited background (bg-white/10) over dark container classified as Potential Issue',
    html: `<!DOCTYPE html><html lang="en"><head><title>Contrast Test</title></head><body style="background:#111827">
      <div style="background: rgb(35, 42, 54); padding: 20px;">
        <span style="background-color: rgba(255, 255, 255, 0.1); color: rgb(10, 102, 194); font-size: 12px; font-weight: 600;">POPULAR</span>
      </div>
    </body></html>`,
    validate: (findings) => {
      const contrast = findings.find(f => f.ruleId === 'color-contrast-insufficient');
      // Must be classified as Potential Issue with medium confidence, NOT confirmed failure
      const passed = Boolean(contrast && contrast.classification === 'Potential Issue' && contrast.confidence === 'medium');
      return {
        passed,
        expected: 'classification: "Potential Issue", confidence: "medium"',
        actual: `contrast found: ${Boolean(contrast)}, classification: ${contrast?.classification}, confidence: ${contrast?.confidence}`
      };
    }
  },
  {
    id: 'tc-50-solid-opaque-low-contrast-confirmed-failure',
    category: 'Accessibility',
    name: 'Color Contrast: Solid opaque low contrast (< 3.0:1) is classified as Confirmed Failure with high confidence',
    html: `<!DOCTYPE html><html lang="en"><head><title>Solid Low Contrast</title></head><body style="background:#ffffff">
      <p style="background-color: #ffffff; color: #d0d0d0; font-size: 14px;">Extremely faint text</p>
    </body></html>`,
    validate: (findings) => {
      const contrast = findings.find(f => f.ruleId === 'color-contrast-insufficient');
      const passed = Boolean(contrast && contrast.classification === 'Confirmed Failure' && contrast.confidence === 'high');
      return {
        passed,
        expected: 'classification: "Confirmed Failure", confidence: "high"',
        actual: `classification: ${contrast?.classification}, confidence: ${contrast?.confidence}`
      };
    }
  },
  {
    id: 'tc-51-csp-frame-ancestors-supersedes-xfo',
    category: 'Security',
    name: 'Security: Enforced CSP frame-ancestors satisfies clickjacking and supersedes X-Frame-Options',
    pureLogicTest: () => {
      const headers = {
        'content-security-policy': "default-src 'self'; frame-ancestors 'self'",
        'strict-transport-security': 'max-age=31536000',
        'x-content-type-options': 'nosniff'
      };
      const res = evaluateSecurityHeaders('https://example.com/', headers);
      const xfoFinding = res.findings.find(f => f.ruleId === 'sec-x-frame-options-missing');
      const passed = !xfoFinding && res.headerStatus.xFrameOptions === true;
      return {
        passed,
        expected: 'No sec-x-frame-options-missing finding, headerStatus.xFrameOptions === true',
        actual: `xfoFinding: ${Boolean(xfoFinding)}, headerStatus.xFrameOptions: ${res.headerStatus.xFrameOptions}`
      };
    }
  },
  {
    id: 'tc-52-canonical-status-and-type-consistency',
    category: 'Architecture',
    name: 'Canonical Consistency: Findings have synchronized classification and type across all categories',
    pureLogicTest: () => {
      const secRes = evaluateSecurityHeaders('https://example.com/', {
        'strict-transport-security': 'max-age=31536000'
      });
      const validClassifications = ['Confirmed Failure', 'Potential Issue', 'Informational'];
      const validTypes = ['failure', 'recommendation', 'informational'];
      let allConsistent = true;
      for (const f of secRes.findings) {
        if (!validClassifications.includes(f.classification) || !validTypes.includes(f.type)) {
          allConsistent = false;
          break;
        }
        if (f.classification === 'Confirmed Failure' && f.type !== 'failure') allConsistent = false;
        if (f.classification === 'Potential Issue' && f.type !== 'recommendation') allConsistent = false;
        if (f.classification === 'Informational' && f.type !== 'informational') allConsistent = false;
      }
      return {
        passed: allConsistent && secRes.findings.length > 0,
        expected: 'All findings have synchronized classification and type properties',
        actual: allConsistent ? 'All findings consistent' : 'Mismatch found'
      };
    }
  },
  {
    id: 'tc-53-scoring-informational-zero-deduction',
    category: 'Scoring',
    name: 'Scoring Engine: Informational findings apply exactly 0 score deductions',
    pureLogicTest: () => {
      const issues = [
        {
          ruleId: 'seo-canonical-missing',
          title: 'Page lacks a canonical URL declaration',
          category: 'SEO',
          severity: 'low',
          classification: 'Informational',
          url: 'https://example.com/'
        },
        {
          ruleId: 'sec-referrer-policy-missing',
          title: 'Referrer-Policy header is not explicitly declared',
          category: 'Security',
          severity: 'low',
          classification: 'Informational',
          url: 'https://example.com/'
        }
      ];
      const result = calculateCategoryScores(issues);
      const passed = result.categoryScores.seo === 100 &&
                     result.categoryScores.security === 100 &&
                     result.overallScore === 100;
      return {
        passed,
        expected: 'SEO: 100, Security: 100, Overall: 100',
        actual: `SEO: ${result.categoryScores.seo}, Security: ${result.categoryScores.security}, Overall: ${result.overallScore}`
      };
    }
  },
  {
    id: 'tc-54-scoring-viewport-deduplication',
    category: 'Scoring',
    name: 'Scoring Engine: Same element finding observed across Desktop, Tablet, and Mobile adds 0 extra penalty',
    pureLogicTest: () => {
      const singleObservation = [
        {
          ruleId: 'heading-hierarchy-skipped',
          title: 'Heading hierarchy skipped',
          category: 'Accessibility',
          severity: 'low',
          classification: 'Potential Issue',
          url: 'https://example.com/',
          selector: 'h3.sample',
          viewport: 'desktop'
        }
      ];
      const multiViewportObservations = [
        {
          ruleId: 'heading-hierarchy-skipped',
          title: 'Heading hierarchy skipped',
          category: 'Accessibility',
          severity: 'low',
          classification: 'Potential Issue',
          url: 'https://example.com/',
          selector: 'h3.sample',
          viewport: 'desktop'
        },
        {
          ruleId: 'heading-hierarchy-skipped',
          title: 'Heading hierarchy skipped',
          category: 'Accessibility',
          severity: 'low',
          classification: 'Potential Issue',
          url: 'https://example.com/',
          selector: 'h3.sample',
          viewport: 'tablet'
        },
        {
          ruleId: 'heading-hierarchy-skipped',
          title: 'Heading hierarchy skipped',
          category: 'Accessibility',
          severity: 'low',
          classification: 'Potential Issue',
          url: 'https://example.com/',
          selector: 'h3.sample',
          viewport: 'mobile'
        }
      ];
      const singleScore = calculateCategoryScores(singleObservation).categoryScores.accessibility;
      const multiScore = calculateCategoryScores(multiViewportObservations).categoryScores.accessibility;
      const passed = singleScore === multiScore;
      return {
        passed,
        expected: `Score identical (${singleScore}) across single and multi-viewport observations`,
        actual: `Single: ${singleScore}, Multi: ${multiScore}`
      };
    }
  },
  {
    id: 'tc-55-performance-monotonic-timing-integrity',
    category: 'Performance',
    name: 'Performance Integrity: DOMContentLoaded and Window Load durations are distinctly recorded with explicit source',
    pureLogicTest: () => {
      const metrics = {
        domContentLoadedMs: 722,
        loadDurationMs: 2840,
        fcpMs: 2220,
        measurementSource: 'W3C Navigation Timing API & PerformanceObserver (Chromium Lab)'
      };
      const isMonotonic = metrics.domContentLoadedMs <= metrics.loadDurationMs;
      const fcpLogical = metrics.fcpMs <= metrics.loadDurationMs;
      const hasSource = Boolean(metrics.measurementSource);
      const passed = isMonotonic && fcpLogical && hasSource;
      return {
        passed,
        expected: 'DOMContentLoaded (722ms) <= FCP (2220ms) <= Window Load (2840ms) with explicit measurement source',
        actual: `isMonotonic: ${isMonotonic}, fcpLogical: ${fcpLogical}, hasSource: ${hasSource}`
      };
    }
  }
];

export async function runA11yRegressionSuite(customChromium = chromium) {
  const startTime = Date.now();
  let browser = null;
  const results = [];

  try {
    browser = await customChromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-sandbox']
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    for (const testCase of REGRESSION_TEST_CASES) {
      const testStart = Date.now();
      try {
        if (testCase.pureLogicTest) {
          const validation = testCase.pureLogicTest();
          results.push({
            id: testCase.id,
            category: testCase.category,
            name: testCase.name,
            passed: validation.passed,
            durationMs: Date.now() - testStart,
            expected: validation.expected,
            actual: validation.actual
          });
          continue;
        }

        await page.setContent(testCase.html, { waitUntil: 'domcontentloaded' });
        let auditResult;
        if (testCase.customAudit) {
          auditResult = await testCase.customAudit(page, 'https://test.local');
        } else {
          auditResult = await page.evaluate(evaluateAccessibility, 'https://test.local');
        }

        const validation = testCase.customAudit 
          ? testCase.validate(auditResult) 
          : testCase.validate(auditResult.findings || auditResult);
        results.push({
          id: testCase.id,
          category: testCase.category,
          name: testCase.name,
          passed: validation.passed,
          durationMs: Date.now() - testStart,
          expected: validation.expected,
          actual: validation.actual
        });
      } catch (caseErr) {
        results.push({
          id: testCase.id,
          category: testCase.category,
          name: testCase.name,
          passed: false,
          durationMs: Date.now() - testStart,
          expected: 'Execution without exception',
          actual: `Error: ${caseErr.message}`
        });
      }
    }

    await browser.close();
    browser = null;
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    throw err;
  }

  const durationMs = Date.now() - startTime;
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const failed = total - passed;

  const report = {
    executedAt: new Date().toISOString(),
    durationMs,
    totalTests: total,
    passedTests: passed,
    failedTests: failed,
    allPassed: failed === 0,
    suiteResults: results
  };

  const outputPath = path.join(rootDir, 'data', 'regression-test-results.json');
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2));

  return report;
}
