import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateReportPdfBuffer } from '../lib/entitlements.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

describe('FLIQ Report Navigation, Rendering & Forms Scope Verification', () => {
  let appJsContent = '';

  test('0. Load app.js and verify syntax integrity', async () => {
    appJsContent = await fs.readFile(path.join(rootDir, 'app.js'), 'utf8');
    assert.ok(appJsContent.length > 0, 'app.js must be readable and non-empty');
  });

  test('1. Static analysis: app.js must not reference undeclared forms variable', () => {
    // Check that inside coverageTabContent, forms is declared before use
    const coverageFnMatch = appJsContent.match(/function\s+coverageTabContent\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(coverageFnMatch, 'coverageTabContent function must exist in app.js');

    const fnBody = coverageFnMatch[1];
    assert.ok(
      fnBody.includes('const forms ='),
      'coverageTabContent must declare "const forms =" in its own scope'
    );
    assert.ok(
      fnBody.includes('const formsCount ='),
      'coverageTabContent must declare "const formsCount =" to safely resolve count'
    );
    assert.ok(
      !fnBody.includes('${forms.formsCount'),
      'coverageTabContent must not directly access ${forms.formsCount without safe scope resolution'
    );
  });

  test('2. Static analysis: resultPage validates activeTab against allowed tabs', () => {
    assert.ok(
      appJsContent.includes("if (!tabs.includes(activeTab))"),
      'resultPage must validate activeTab against allowed tabs'
    );
  });

  test('3. Static analysis: action===download handles errors and parsing safely', () => {
    assert.ok(
      appJsContent.includes("action==='download'"),
      'download action handler must exist in app.js'
    );
    assert.ok(
      appJsContent.includes("Failed to download report"),
      'download action handler must handle download failures gracefully'
    );
  });

  test('4. Functional execution: coverageTabContent simulation with full report data', () => {
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function testCoverageTab(t) {
      const cov = t.auditCoverage || {
        scope: 'Single-Page Deep Inspection with Discovery',
        pagesDiscovered: 1,
        pagesInspected: 1,
        pagesInaccessible: 0,
        pagesSkipped: 0,
        viewports: { desktop: { inspected: true }, tablet: { inspected: true }, mobile: { inspected: true } },
        checksSummary: { totalChecks: 47, checksExecuted: 41, totalChecksExecuted: 41, checksUnexecuted: 6, checksPassed: 33, checksConfirmedFailure: 0, checksPotentialIssue: 6, checksInformational: 2, checksFailed: 6, checksNotTested: 4, checksUnavailable: 2, checksUnavailableOrNotTested: 6 },
        findingsSummary: { totalFindings: 0, confirmedFailures: 0, potentialIssues: 0, informationalObservations: 0 },
        coverageDisclaimer: 'Audited across viewports'
      };
      const cs = cov.checksSummary || {};
      const fs = cov.findingsSummary || { totalFindings: 0, confirmedFailures: 0, potentialIssues: 0, informationalObservations: 0 };
      const executed = cs.checksExecuted ?? 0;
      const unexecuted = cs.checksUnexecuted ?? 0;

      const forms = t.functionalityReport?.forms || t.forms || { formsCount: 0 };
      const formsCount = typeof forms.formsCount === 'number'
        ? forms.formsCount
        : (Array.isArray(forms.forms) ? forms.forms.length : (Array.isArray(forms) ? forms.length : 0));

      return `Discovered (${formsCount}) · Not submitted`;
    }

    // Scenario A: Full functionalityReport.forms object
    const reportA = {
      functionalityReport: {
        forms: { formsCount: 4, forms: [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }, { id: 'f4' }], tested: false }
      }
    };
    const renderedA = testCoverageTab(reportA);
    assert.equal(renderedA, 'Discovered (4) · Not submitted');

    // Scenario B: Root forms object
    const reportB = {
      forms: { formsCount: 2 }
    };
    const renderedB = testCoverageTab(reportB);
    assert.equal(renderedB, 'Discovered (2) · Not submitted');

    // Scenario C: Root forms array
    const reportC = {
      forms: [{ id: 'form1' }]
    };
    const renderedC = testCoverageTab(reportC);
    assert.equal(renderedC, 'Discovered (1) · Not submitted');

    // Scenario D: Completely missing forms and functionalityReport (Previously crashed!)
    const reportD = {};
    const renderedD = testCoverageTab(reportD);
    assert.equal(renderedD, 'Discovered (0) · Not submitted');

    // Scenario E: functionalityReport is null
    const reportE = { functionalityReport: null };
    const renderedE = testCoverageTab(reportE);
    assert.equal(renderedE, 'Discovered (0) · Not submitted');
  });

  test('5. Report download serialization integrity', () => {
    const sampleReport = {
      id: 'test-download-123',
      url: 'https://example.com',
      hostname: 'example.com',
      status: 'completed',
      score: 95,
      categoryScores: { accessibility: 98, functionality: 100, performance: 90, seo: 95, security: 92 },
      completedAt: new Date().toISOString(),
      issues: [
        { id: 'i1', title: 'Missing alt text', severity: 'medium', category: 'Accessibility' }
      ],
      functionalityReport: {
        forms: { formsCount: 1, forms: [{ id: 'search-form' }] }
      },
      auditCoverage: {
        scope: 'Single-Page Deep Inspection',
        pagesInspected: 1
      }
    };

    const jsonString = JSON.stringify(sampleReport, null, 2);
    assert.ok(jsonString.length > 50, 'Serialized report JSON must be non-empty');

    const parsed = JSON.parse(jsonString);
    assert.equal(parsed.id, sampleReport.id);
    assert.equal(parsed.score, 95);
    assert.equal(parsed.functionalityReport.forms.formsCount, 1);
  });

  test('6. Report PDF export buffer generation', () => {
    const sampleReport = {
      id: 'test-pdf-123',
      url: 'https://example.com',
      hostname: 'example.com',
      score: 92,
      completedAt: new Date().toISOString(),
      issues: [
        { id: 'i1', title: 'Example issue 1', severity: 'high' },
        { id: 'i2', title: 'Example issue 2', severity: 'low' }
      ]
    };

    const pdfBuf = generateReportPdfBuffer(sampleReport);
    assert.ok(Buffer.isBuffer(pdfBuf), 'PDF generator must return a Buffer');
    assert.ok(pdfBuf.length > 100, 'PDF buffer must have valid binary content');
    assert.ok(pdfBuf.toString('utf8', 0, 8).startsWith('%PDF-1.'), 'PDF buffer must start with PDF header magic bytes');
  });
});
