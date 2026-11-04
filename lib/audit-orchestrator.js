/**
 * FLIQ Production-Grade Audit Orchestrator & Evidence-Based Scoring Engine
 * 
 * SCORING POLICY SPECIFICATION:
 * 1. Finding Preservation & Distinct Occurrence Fingerprinting:
 *    - Duplicate observations (identical URL + ruleId + selector/resource) are merged without inflating penalties.
 *    - Distinct element occurrences (different selectors, URLs, or HTML elements) are preserved with full evidence.
 * 2. Grouped Base & Incremental Scoring:
 *    - The primary occurrence of a defect rule applies the base deduction (Confirmed: High -18, Medium -8, Low -3; Potential: High -8, Medium -4, Low -1).
 *    - Each additional distinct occurrence (N > 1) applies an incremental deduction (High: +2 pts, cap +10; Medium: +1 pt, cap +6; Low: +1 pt, cap +3).
 *    - Repeated observations of the exact same element across viewports (Desktop/Tablet/Mobile) add 0 incremental penalty.
 * 3. Deduction Caps & Defenses:
 *    - Repetitive missing security header deductions (sec-*-missing) are capped at 15 points total to protect static sites.
 *    - Informational observations apply 0 score deductions.
 *    - Category score strictly equals: Math.max(0, 100 - sum(deductions)).
 * 4. Overall Weighted Composite:
 *    - Accessibility: 25%, Functionality: 25%, Performance: 20%, SEO: 15%, Security: 15%.
 */

export const DEFAULT_SCORING_CONFIG = {
  weights: {
    accessibility: 0.25,
    functionality: 0.25,
    performance: 0.20,
    seo: 0.15,
    security: 0.15
  },
  baseDeductions: {
    confirmed: { high: 18, medium: 8, low: 3 },
    potential: { high: 8, medium: 4, low: 1 }
  },
  incrementalOccurrenceDeductions: {
    high: { inc: 2, maxExtra: 10 },
    medium: { inc: 1, maxExtra: 6 },
    low: { inc: 1, maxExtra: 3 }
  },
  missingHeaderDeductionCap: 15
};

export function calculateCategoryScores(allIssues = [], allChecks = [], customConfig = {}) {
  const config = {
    ...DEFAULT_SCORING_CONFIG,
    ...customConfig,
    weights: { ...DEFAULT_SCORING_CONFIG.weights, ...(customConfig.weights || {}) },
    baseDeductions: {
      confirmed: { ...DEFAULT_SCORING_CONFIG.baseDeductions.confirmed, ...(customConfig.baseDeductions?.confirmed || {}) },
      potential: { ...DEFAULT_SCORING_CONFIG.baseDeductions.potential, ...(customConfig.baseDeductions?.potential || {}) }
    },
    incrementalOccurrenceDeductions: {
      high: { ...DEFAULT_SCORING_CONFIG.incrementalOccurrenceDeductions.high, ...(customConfig.incrementalOccurrenceDeductions?.high || {}) },
      medium: { ...DEFAULT_SCORING_CONFIG.incrementalOccurrenceDeductions.medium, ...(customConfig.incrementalOccurrenceDeductions?.medium || {}) },
      low: { ...DEFAULT_SCORING_CONFIG.incrementalOccurrenceDeductions.low, ...(customConfig.incrementalOccurrenceDeductions?.low || {}) }
    },
    missingHeaderDeductionCap: customConfig.missingHeaderDeductionCap ?? DEFAULT_SCORING_CONFIG.missingHeaderDeductionCap
  };

  const categories = ['Accessibility', 'Functionality', 'Performance', 'SEO', 'Security'];
  const scores = {};
  const deductionBreakdown = {};
  const categoryExplanations = {};
  const groupedIssuesByCategory = {};
  const allPreservedIssues = [];

  for (const cat of categories) {
    const catIssues = allIssues.filter(i => (i.category || '').toLowerCase() === cat.toLowerCase());
    let penalty = 0;
    const catDeductions = [];

    // Step 1: Distinct Occurrence Identification & Viewport Deduplication
    // Duplicate observation = same URL + same ruleId + same selector or resource identifier
    const seenFingerprints = new Map();
    const uniqueOccurrences = [];

    for (const issue of catIssues) {
      const url = (issue.url || '').trim().toLowerCase();
      const ruleId = (issue.ruleId || issue.title || '').trim().toLowerCase();
      const selector = (issue.selector || issue.htmlSnippet || issue.title || '').trim().toLowerCase();
      const fingerprint = `${url}::${ruleId}::${selector}`;

      if (seenFingerprints.has(fingerprint)) {
        // Repeated observation of the SAME element (e.g. across Desktop, Tablet, Mobile)
        // Record viewport without multiplying the finding or penalty
        const existing = seenFingerprints.get(fingerprint);
        if (issue.viewport && !existing.viewports.includes(issue.viewport)) {
          existing.viewports.push(issue.viewport);
        }
        continue;
      }

      const occurrenceRecord = {
        ...issue,
        viewports: issue.viewport ? [issue.viewport] : []
      };
      seenFingerprints.set(fingerprint, occurrenceRecord);
      uniqueOccurrences.push(occurrenceRecord);
      allPreservedIssues.push(occurrenceRecord);
    }

    // Step 2: Group unique occurrences by ruleId
    const ruleGroups = new Map();
    for (const occ of uniqueOccurrences) {
      const groupKey = (occ.ruleId || occ.title || '').toLowerCase();
      if (!ruleGroups.has(groupKey)) {
        ruleGroups.set(groupKey, []);
      }
      ruleGroups.get(groupKey).push(occ);
    }

    const groupedCategoryIssues = [];

    for (const [groupKey, occList] of ruleGroups.entries()) {
      const primary = occList[0];
      const isInfo = primary.classification === 'Informational' || primary.type === 'informational';
      const isConfirmed = !isInfo && (primary.classification === 'Confirmed Failure' || (!primary.classification && primary.type === 'failure'));
      const isPotential = !isInfo && !isConfirmed && (primary.classification === 'Potential Issue' || (!primary.classification && primary.type === 'recommendation'));

      // Aggregate all elements from individual occurrences for inspection
      const allElements = [];
      for (const occ of occList) {
        if (occ.elements && Array.isArray(occ.elements) && occ.elements.length > 0) {
          allElements.push(...occ.elements);
        } else {
          allElements.push({
            tagName: occ.tagName || occ.selector?.split(/[#.[]/)[0] || 'element',
            selector: occ.selector || '',
            accessibleRole: occ.accessibleRole || '',
            accessibleName: occ.accessibleName || '',
            wcagCriterion: occ.wcagCriterion || '',
            url: occ.url || '',
            htmlSnippet: occ.htmlSnippet || '',
            evidence: occ.evidence || occ.actualBehavior || '',
            suggestedFix: occ.suggestedFix || occ.recommendedFix || ''
          });
        }
      }

      // Deduplicate elements inside the grouped list by selector & snippet
      const uniqueElements = [];
      const seenElemSelectors = new Set();
      for (const el of allElements) {
        const elKey = `${el.url || ''}::${el.selector || el.htmlSnippet || ''}`;
        if (!seenElemSelectors.has(elKey)) {
          seenElemSelectors.add(elKey);
          uniqueElements.push(el);
        }
      }

      const occurrenceCount = Math.max(occList.length, uniqueElements.length);

      const groupedIssue = {
        ...primary,
        title: occurrenceCount > 1 
          ? `${occurrenceCount} occurrences: ${primary.title.replace(/^\d+\s+[^:]+:\s*/, '').replace(/^\d+\s+/, '')}`
          : primary.title,
        elementCount: occurrenceCount,
        elements: uniqueElements,
        occurrences: occList.map(o => ({
          url: o.url,
          selector: o.selector,
          htmlSnippet: o.htmlSnippet,
          evidence: o.evidence || o.actualBehavior,
          reproductionSteps: o.reproductionSteps,
          viewports: o.viewports
        }))
      };
      groupedCategoryIssues.push(groupedIssue);

      if (isInfo) continue; // Informational observations do not penalize scores

      // Base deduction for the defect rule from configurable policy
      const sevKey = (primary.severity || 'medium').toLowerCase();
      const baseMap = isConfirmed ? config.baseDeductions.confirmed : config.baseDeductions.potential;
      const baseDeduction = baseMap[sevKey] ?? (isConfirmed ? 8 : 4);

      const incConfig = config.incrementalOccurrenceDeductions[sevKey] || { inc: 1, maxExtra: 6 };
      const extraOccurrences = Math.max(0, occurrenceCount - 1);
      const extraDeduction = Math.min(extraOccurrences * incConfig.inc, incConfig.maxExtra);
      let pts = baseDeduction + extraDeduction;

      // Cap repetitive missing header deductions to prevent excessive stacking on static sites
      if (cat.toLowerCase() === 'security' && (primary.ruleId || '').startsWith('sec-') && (primary.ruleId || '').includes('-missing')) {
        const cap = config.missingHeaderDeductionCap;
        if (penalty >= cap) {
          pts = 0; // Cap combined missing header penalties at configured cap (default 15 pts)
        } else if (penalty + pts > cap) {
          pts = cap - penalty;
        }
      }

      if (pts > 0) {
        penalty += pts;
        catDeductions.push({
          ruleId: primary.ruleId,
          title: groupedIssue.title,
          severity: primary.severity,
          classification: primary.classification || (isConfirmed ? 'Confirmed Failure' : 'Potential Issue'),
          occurrenceCount,
          baseDeduction,
          incrementalDeduction: extraDeduction,
          deduction: pts
        });
      }
    }

    groupedIssuesByCategory[cat.toLowerCase()] = groupedCategoryIssues;

    const catKey = cat.toLowerCase();
    scores[catKey] = Math.max(0, Math.min(100, 100 - penalty));
    deductionBreakdown[catKey] = catDeductions;

    // Itemized category explanation
    if (catDeductions.length === 0) {
      categoryExplanations[catKey] = `${cat}: 100/100 (Clean evaluation; 0 defects detected across automated checks).`;
    } else {
      const breakdownText = catDeductions.map(d => `${d.title} (-${d.deduction} pts)`).join(', ');
      categoryExplanations[catKey] = `${cat}: ${scores[catKey]}/100 (${breakdownText}).`;
    }
  }

  // Weighted overall composite score using configured weights
  let weightedSum = 0;
  for (const [catKey, weight] of Object.entries(config.weights)) {
    weightedSum += (scores[catKey] ?? 100) * weight;
  }
  const overallScore = Math.round(weightedSum);

  const explanation = `Overall score (${overallScore}/100) computed from 5 audited categories: Accessibility (${scores.accessibility}/100, ${config.weights.accessibility * 100}%), Functionality (${scores.functionality}/100, ${config.weights.functionality * 100}%), Performance (${scores.performance}/100, ${config.weights.performance * 100}%), SEO (${scores.seo}/100, ${config.weights.seo * 100}%), and Security (${scores.security}/100, ${config.weights.security * 100}%). Base deductions: High -${config.baseDeductions.confirmed.high}/-${config.baseDeductions.potential.high}, Medium -${config.baseDeductions.confirmed.medium}/-${config.baseDeductions.potential.medium}, Low -${config.baseDeductions.confirmed.low}/-${config.baseDeductions.potential.low}. Additional distinct occurrences apply incremental penalties (+${config.incrementalOccurrenceDeductions.medium.inc} pt each, capped at +${config.incrementalOccurrenceDeductions.medium.maxExtra}). Missing headers capped at -${config.missingHeaderDeductionCap} pts total. Informational items apply 0 deductions. Untested manual checks and field metrics are excluded from scoring.`;

  return {
    overallScore,
    categoryScores: scores,
    deductionBreakdown,
    categoryExplanations,
    scoreExplanation: explanation,
    groupedIssues: Object.values(groupedIssuesByCategory).flat(),
    allPreservedIssues
  };
}
