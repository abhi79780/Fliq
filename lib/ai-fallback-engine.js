/**
 * FLIQ Deterministic Quality & Analysis Engine
 * 
 * Provides robust, production-grade analysis for audit reports:
 * Generates evidence-based, rule-derived explanations, remediation guidance,
 * and executive quality summaries entirely locally and deterministically.
 * 
 * Guarantees that website scanning, scoring, screenshot capture, and report generation
 * operate 100% reliably, offline-capable, without external AI API dependencies.
 */

export function generateDeterministicSummary(issues = [], targetUrl = '', options = {}) {
  const total = issues.length;
  let domain = 'the inspected website';
  if (targetUrl) {
    try {
      domain = new URL(targetUrl).hostname;
    } catch {
      domain = targetUrl;
    }
  }

  if (total === 0) {
    return `Standard Analysis: Automated quality audits for ${domain} detected 0 critical failures. The evaluated accessibility criteria, DOM structure, response security headers, and Core Web Vitals meet baseline quality standards.`;
  }

  // Count by severity
  const critical = issues.filter(i => i.severity === 'critical' || i.severity === 'high').length;
  const medium = issues.filter(i => i.severity === 'medium').length;
  const low = issues.filter(i => i.severity === 'low' || i.severity === 'info').length;

  // Count by category
  const categories = ['Accessibility', 'Functionality', 'Performance', 'SEO', 'Security'];
  const catCounts = {};
  for (const cat of categories) {
    const c = issues.filter(i => (i.category || '').toLowerCase() === cat.toLowerCase()).length;
    if (c > 0) catCounts[cat] = c;
  }

  const activeCategories = Object.entries(catCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} (${count})`);

  const confirmedFailures = issues.filter(i => i.classification === 'Confirmed Failure' || i.type === 'failure').length;
  const potentialIssues = issues.filter(i => i.classification === 'Potential Issue' || i.type === 'recommendation').length;

  // Build top priorities list
  const topIssues = issues
    .filter(i => i.severity === 'critical' || i.severity === 'high')
    .slice(0, 3)
    .map(i => i.title);

  let summaryParts = [];

  summaryParts.push(
    `Standard Rule-Based Analysis: Audit completed for ${domain} with ${total} detected finding(s). ` +
    `Breakdown includes ${confirmedFailures} confirmed barrier(s) and ${potentialIssues} potential optimization opportunity(ies) across ${activeCategories.length} categories: ${activeCategories.join(', ')}.`
  );

  if (topIssues.length > 0) {
    summaryParts.push(
      `Top remediation priorities: ${topIssues.join('; ')}. Immediate attention to these high-impact items will produce the greatest improvement in user experience and compliance scores.`
    );
  } else {
    summaryParts.push(
      `No critical or high-severity blockers were identified. The findings represent moderate enhancements to improve overall user accessibility, technical SEO signals, and performance headroom.`
    );
  }

  summaryParts.push(
    `Review individual finding evidence, browser-observed snippets, and technical recommendations in each category tab below. (Standard rule-based quality analysis.)`
  );

  return summaryParts.join('\n\n');
}

export function enrichIssuesWithRuleExplanations(issues = []) {
  return issues.map(issue => {
    const enriched = { ...issue };

    // Standard rule-based technical explanation
    if (!enriched.explanation || enriched.explanation.startsWith('AI analysis is not configured') || enriched.explanation.startsWith('AI analysis unavailable')) {
      const parts = [];
      if (enriched.description) parts.push(enriched.description);
      if (enriched.whyItMatters) parts.push(`Impact: ${enriched.whyItMatters}`);
      if (enriched.expectedBehavior) parts.push(`Standard expectation: ${enriched.expectedBehavior}`);
      enriched.explanation = parts.join(' ') || 'Review finding evidence and apply recommended fix.';
    }

    if (!enriched.recommendedFix) {
      if (enriched.category === 'Accessibility') {
        enriched.recommendedFix = 'Ensure accessible markup, labels, and color contrast meet WCAG 2.2 specifications.';
      } else if (enriched.category === 'Security') {
        enriched.recommendedFix = 'Configure modern HTTP security response headers and enforce HTTPS transport.';
      } else if (enriched.category === 'Performance') {
        enriched.recommendedFix = 'Optimize asset delivery, caching policies, and critical rendering path.';
      } else if (enriched.category === 'SEO') {
        enriched.recommendedFix = 'Provide descriptive metadata, heading structures, and crawler-friendly tags.';
      } else {
        enriched.recommendedFix = 'Review the DOM element and resolve the reported behavioral issue.';
      }
    }

    enriched.isAiGenerated = false;
    enriched.analysisType = 'rule-based';

    return enriched;
  });
}

export async function executeAIOrFallbackReport(issues = [], targetUrl = '', customConfig = {}) {
  const enrichedIssues = enrichIssuesWithRuleExplanations(issues);
  const summary = generateDeterministicSummary(enrichedIssues, targetUrl);

  return {
    configured: false,
    isAiGenerated: false,
    source: 'rule-based',
    aiSummary: summary,
    issues: enrichedIssues
  };
}
