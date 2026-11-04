/**
 * FLIQ Production-Grade Functionality Scanner
 * 
 * Verifies runtime JavaScript health, same-origin network requests,
 * asset loading, internal links, dead-end interactive triggers, and responsive layout stability.
 * Explicitly documents passive non-destructive form handling.
 */

export const FUNCTIONALITY_CHECKS = [
  { id: 'func-js-errors', name: 'JavaScript runtime error integrity', type: 'automated', standard: 'ECMAScript Standard', summary: 'Page executes without unhandled JavaScript exceptions' },
  { id: 'func-network-status', name: 'Network resource response status', type: 'automated', standard: 'HTTP/1.1 & HTTP/2 Standards', summary: 'Same-origin network requests return successful HTTP status codes' },
  { id: 'func-broken-images', name: 'Image rendering & resource availability', type: 'automated', standard: 'HTML Living Standard', summary: 'All image assets load and render with non-zero dimensions' },
  { id: 'func-internal-links', name: 'Internal link destination integrity', type: 'automated', standard: 'RFC 3986', summary: 'Internal links navigate to valid reachable URLs' },
  { id: 'func-responsive-layout', name: 'Responsive viewport horizontal stability', type: 'automated', standard: 'CSS Overflow Module Level 3', summary: 'Content scales to viewport width without horizontal page scroll' },
  { id: 'func-dead-triggers', name: 'Interactive trigger & link destinations', type: 'automated', standard: 'W3C Web UI Best Practices', summary: 'Interactive links have valid destination targets or explicit roles' },
  { id: 'func-forms', name: 'Form submission & processing', type: 'manual', standard: 'HTML Living Standard §4.10', summary: 'Forms discovered but not submitted (Passive non-destructive policy)' }
];

export function checkResponsiveLayout(evalUrl) {
  const findings = [];
  const doc = document.documentElement;
  const isOverflowing = doc.scrollWidth > window.innerWidth;

  if (isOverflowing) {
    const diff = doc.scrollWidth - window.innerWidth;
    findings.push({
      ruleId: 'func-horizontal-overflow',
      title: `Content overflows viewport horizontally by ${diff}px`,
      category: 'Functionality',
      severity: 'medium',
      classification: 'Confirmed Failure',
      checkType: 'automated',
      elementCount: 1,
      url: evalUrl,
      selector: 'html',
      htmlSnippet: '<html>',
      evidence: `Document scrollWidth (${doc.scrollWidth}px) exceeds window.innerWidth (${window.innerWidth}px) by ${diff}px at viewport width ${window.innerWidth}px.`,
      expectedBehavior: 'Mobile and tablet layouts should fit within the screen width without requiring horizontal scrolling.',
      actualBehavior: `The page produces horizontal scrollbars (${diff}px overflow) at width ${window.innerWidth}px.`,
      description: 'An element on the page has a fixed width or negative margin larger than the current viewport, breaking mobile responsiveness.',
      whyItMatters: 'Horizontal scrollbars make mobile browsing frustrating and cause touch gestures to behave erratically.',
      wcagCriterion: 'WCAG 1.4.10: Reflow (Level AA)',
      reproductionSteps: `1. Set browser viewport width to ${window.innerWidth}px.\n2. Note horizontal scrollbar at bottom of viewport.`,
      recommendedFix: 'Add "max-width: 100%" or "overflow-x: hidden" to wide containers and avoid fixed pixel widths.',
      codeExample: {
        current: '.container { width: 1200px; }',
        corrected: '.container { width: 100%; max-width: 1200px; box-sizing: border-box; }'
      },
      confidence: 'high'
    });
  }

  return { findings, isOverflowing };
}

export function checkDeadTriggers(evalUrl) {
  const findings = [];
  const deadLinks = Array.from(document.querySelectorAll('a[href="#"], a[href="javascript:void(0)"], a[href="javascript:;"]')).filter(a => {
    const role = (a.getAttribute('role') || '').toLowerCase();
    const hasDataAction = a.hasAttribute('data-action') || a.hasAttribute('data-go') || a.hasAttribute('data-route') || a.hasAttribute('data-toggle');
    return !hasDataAction && role !== 'button' && role !== 'tab';
  });

  if (deadLinks.length > 0) {
    const sample = deadLinks[0].outerHTML || '<a href="#">';
    findings.push({
      ruleId: 'func-dead-link-trigger',
      title: `${deadLinks.length} placeholder link(s) (href="#") without explicit role or action`,
      category: 'Functionality',
      severity: 'low',
      classification: 'Potential Issue',
      checkType: 'automated',
      elementCount: deadLinks.length,
      url: evalUrl,
      selector: 'a[href="#"]',
      htmlSnippet: sample,
      evidence: `Found ${deadLinks.length} <a> tag(s) with href="#" and no role="button" or interactive routing attribute: ${sample}.`,
      expectedBehavior: 'Links should navigate to valid URLs. Interactive UI triggers should use <button> or role="button".',
      actualBehavior: `Observed placeholder link href="${deadLinks[0].getAttribute('href')}". Clicking scrolls page to top without action.`,
      description: 'Using href="#" on links intended to trigger JavaScript actions causes the browser to jump to the top of the page if the click event is not cancelled.',
      whyItMatters: 'Placeholder href="#" links disorient users who expect standard navigation and break keyboard activation semantics.',
      wcagCriterion: 'W3C Web UI Best Practices',
      reproductionSteps: '1. Click on the element.\n2. Observe page URL hash changing or jumping to top.',
      recommendedFix: 'Replace <a href="#"> with a semantic <button type="button">.',
      codeExample: {
        current: sample,
        corrected: sample.replace(/<a\b([^>]*)href="#"([^>]*)>/i, '<button type="button"$1$2>').replace(/<\/a>/i, '</button>')
      },
      confidence: 'medium'
    });
  }

  return { findings };
}

export function inspectFormsPassive(evalUrl) {
  const forms = Array.from(document.querySelectorAll('form'));
  const formList = forms.map((f, idx) => ({
    id: f.id || `form-${idx + 1}`,
    action: f.getAttribute('action') || '(current URL)',
    method: (f.getAttribute('method') || 'GET').toUpperCase(),
    fieldsCount: f.querySelectorAll('input:not([type="hidden"]), select, textarea').length,
    hasSubmitButton: Boolean(f.querySelector('button[type="submit"], input[type="submit"], button:not([type])')),
    tested: false,
    reasonUntested: 'Passive non-destructive scan policy: form submission was not executed'
  }));

  return {
    formsCount: forms.length,
    forms: formList,
    tested: false,
    policyNotice: 'Forms were detected but not submitted. Non-destructive scanning avoids generating test submissions, order placements, or database mutations.'
  };
}
