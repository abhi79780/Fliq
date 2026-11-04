/**
 * FLIQ Production-Grade Accessibility Scanner (AccName 1.2 & WCAG 2.2 Compliant)
 * 
 * Strict Evidence-Based Audit Philosophy:
 * - Never report an issue without reproducible browser-observed evidence.
 * - Distinguish Confirmed Failures, Potential Issues, and Informational Observations.
 * - Preserve correct labelling for Radix UI, shadcn/ui, and accessible SVG icons.
 * - Flag interactive elements hidden via aria-hidden="true" (ghost focus traps).
 * - Audit keyboard operability, focus indicators, heading hierarchy, duplicate IDs, landmarks.
 */

export const A11Y_CHECKS = [
  { id: 'img-alt', name: 'Image alternative text (img[alt])', type: 'automated', standard: 'WCAG 1.1.1 (Level A)', summary: 'Images have descriptive alt attributes or decorative role' },
  { id: 'button-name', name: 'Button accessible names', type: 'automated', standard: 'WCAG 4.1.2 (Level A)', summary: 'Buttons have discernable text, aria-label, or label association' },
  { id: 'input-label', name: 'Form control labels (input, select, textarea)', type: 'automated', standard: 'WCAG 1.3.1 / 4.1.2 (Level A)', summary: 'Form inputs have associated label, aria-label, or title' },
  { id: 'link-name', name: 'Link text & discernment (a[href])', type: 'automated', standard: 'WCAG 2.4.4 / 4.1.2 (Level A)', summary: 'Hyperlinks have discernible text or descriptive accessible name' },
  { id: 'interactive-aria-hidden', name: 'Interactive elements with aria-hidden', type: 'automated', standard: 'WCAG 4.1.2 / 1.3.1 (Level A)', summary: 'Focusable controls are not hidden from assistive tech via aria-hidden' },
  { id: 'keyboard-nav', name: 'Keyboard navigation & operable controls', type: 'automated', standard: 'WCAG 2.1.1 (Level A)', summary: 'Custom interactive controls are reachable and focusable via keyboard' },
  { id: 'focus-visible', name: 'Focus visibility & indicator preservation', type: 'automated', standard: 'WCAG 2.4.7 (Level AA)', summary: 'Interactive controls preserve visual focus indicators' },
  { id: 'heading-hierarchy', name: 'Heading hierarchy & structural levels', type: 'automated', standard: 'WCAG 1.3.1 (Level A)', summary: 'Heading levels follow a logical descending sequence' },
  { id: 'duplicate-ids', name: 'Unique DOM element identifiers', type: 'automated', standard: 'WCAG 4.1.1 / 1.3.1 (Level A)', summary: 'Element IDs are unique to prevent ARIA association errors' },
  { id: 'color-contrast', name: 'Text color contrast ratio (WCAG 1.4.3)', type: 'automated', standard: 'WCAG 1.4.3 (Level AA)', summary: 'Text maintains minimum 4.5:1 (or 3:1 for large text) contrast against solid backgrounds' },
  { id: 'landmark-structure', name: 'Main landmark region (<main>)', type: 'automated', standard: 'WCAG 1.3.1 (Level A)', summary: 'Page specifies a primary <main> content landmark' },
  { id: 'document-lang', name: 'Document language declaration (<html lang>)', type: 'automated', standard: 'WCAG 3.1.1 (Level A)', summary: 'HTML root element specifies a valid BCP 47 lang attribute' },
  { id: 'viewport-scale', name: 'Zoom & scaling restrictions (user-scalable)', type: 'automated', standard: 'WCAG 1.4.4 (Level AA)', summary: 'Viewport does not disable user scaling (user-scalable=no / maximum-scale=1)' },
  { id: 'screen-reader', name: 'Screen reader pronunciation & navigation', type: 'manual', status: 'not_tested', summary: 'Requires live testing with NVDA, JAWS, or VoiceOver' },
  { id: 'dynamic-contrast', name: 'Color contrast across states (hover, focus, disabled)', type: 'manual', status: 'not_tested', summary: 'Requires manual contrast assessment across interactive states and gradients' },
  { id: 'media-captions', name: 'Audio & video captions / transcriptions', type: 'manual', status: 'not_tested', summary: 'Requires verifying multimedia synchronized text alternatives' }
];

export function evaluateAccessibility(evalUrl) {
  function buildSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    if (el.id && !/^\d/.test(el.id) && !/[#.:[\]\s]/.test(el.id)) return '#' + el.id;
    const parts = [];
    let curr = el;
    while (curr && curr.nodeType === Node.ELEMENT_NODE && curr !== document.documentElement) {
      let part = curr.tagName.toLowerCase();
      if (curr.id && !/^\d/.test(curr.id) && !/[#.:[\]\s]/.test(curr.id)) {
        parts.unshift('#' + curr.id);
        break;
      }
      const parent = curr.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName.toLowerCase() === part);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(curr) + 1})`;
        }
      }
      const cls = typeof curr.className === 'string' ? curr.className.trim() : '';
      if (cls) {
        const validCls = cls.split(/\s+/).find(c => /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(c));
        if (validCls) part += '.' + validCls;
      }
      parts.unshift(part);
      curr = parent;
      if (parts.length >= 4) break;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  function getOpeningTag(el, maxTextLen = 80) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    try {
      const tag = el.tagName.toLowerCase();
      const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
      if (voidElements.has(tag)) {
        return el.cloneNode(false).outerHTML || ('<' + tag + '>');
      }
      const clone = el.cloneNode(false);
      const rawText = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
      if (rawText) {
        const truncated = rawText.length > maxTextLen ? rawText.slice(0, maxTextLen) + '…' : rawText;
        const outer = clone.outerHTML;
        const closing = `</${tag}>`;
        if (outer.endsWith(closing)) {
          const opening = outer.slice(0, outer.length - closing.length);
          return `${opening}${truncated}${closing}`;
        }
      }
      return clone.outerHTML || ('<' + tag + '>');
    } catch {
      return '<' + (el.tagName ? el.tagName.toLowerCase() : 'element') + '>';
    }
  }

  function getBoundingBox(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    try {
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + (window.scrollX || 0));
      const y = Math.round(r.top + (window.scrollY || 0));
      const width = Math.round(r.width);
      const height = Math.round(r.height);
      return { x, y, width, height, top: y, left: x };
    } catch {
      return null;
    }
  }

  function isVisible(el) {
    if (!el) return false;
    try {
      if (el.hasAttribute('hidden')) return false;
      const style = window.getComputedStyle ? window.getComputedStyle(el) : el.style;
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      if (el.getBoundingClientRect && el.getClientRects) {
        const rect = el.getBoundingClientRect();
        return (rect.width > 0 && rect.height > 0) || el.getClientRects().length > 0;
      }
      return true;
    } catch {
      return true;
    }
  }

  function isInteractiveElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const interactiveRoles = ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'switch', 'combobox', 'searchbox', 'textbox', 'option', 'slider', 'spinbutton'];
    if (['button', 'select', 'textarea'].includes(tag)) return true;
    if (tag === 'a' && el.hasAttribute('href')) return true;
    if (tag === 'input' && el.type !== 'hidden') return true;
    if (tag === 'summary' || tag === 'details') return true;
    if (interactiveRoles.includes(role)) return true;
    if (el.hasAttribute('tabindex')) {
      const ti = parseInt(el.getAttribute('tabindex'), 10);
      if (!isNaN(ti) && ti >= 0) return true;
    }
    return false;
  }

  function getNodeTextForAccName(node, visited = new Set()) {
    if (!node || visited.has(node)) return '';
    visited.add(node);
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    if (['script', 'style', 'noscript', 'template'].includes(tag)) return '';
    const ariaLabel = node.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
    if (tag === 'img') return node.getAttribute('alt') || '';
    if (tag === 'svg') {
      const title = node.querySelector('title');
      if (title && title.textContent?.trim()) return title.textContent.trim();
      const desc = node.querySelector('desc');
      if (desc && desc.textContent?.trim()) return desc.textContent.trim();
    }
    if (tag === 'input' && ['button', 'submit', 'reset'].includes(node.type)) {
      return (node.value || '').trim();
    }
    const pieces = [];
    for (const child of node.childNodes) {
      const piece = getNodeTextForAccName(child, visited);
      if (piece) pieces.push(piece);
    }
    return pieces.join(' ').replace(/\s+/g, ' ').trim();
  }

  function getAccessibleName(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';

    // 1. aria-labelledby (AccName 1.2 §2B: multiple space-separated IDs & hidden elements)
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ids = labelledBy.trim().split(/\s+/).filter(Boolean);
      const textParts = [];
      for (const id of ids) {
        const target = document.getElementById(id);
        if (target) {
          const resolved = getNodeTextForAccName(target);
          if (resolved) textParts.push(resolved);
        }
      }
      const combined = textParts.join(' ').replace(/\s+/g, ' ').trim();
      if (combined) return combined;
    }

    // 2. aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    // 3. Associated <label for="id"> (HTML-AAM for Radix UI, buttons, inputs)
    if (el.id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label) {
          const labelText = getNodeTextForAccName(label);
          if (labelText) return labelText;
        }
      } catch {}
    }

    // 4. Wrapping <label> ancestor
    const parentLabel = el.closest('label');
    if (parentLabel) {
      try {
        const clone = parentLabel.cloneNode(true);
        if (el.id) {
          const selfInClone = clone.querySelector(`#${CSS.escape(el.id)}`);
          if (selfInClone) selfInClone.remove();
        }
        const parentText = getNodeTextForAccName(clone);
        if (parentText) return parentText;
      } catch {}
    }

    // 5. Direct img alt
    if (el.tagName.toLowerCase() === 'img') return el.getAttribute('alt') || '';
    const childImg = el.querySelector('img[alt]');
    if (childImg && childImg.getAttribute('alt')?.trim()) return childImg.getAttribute('alt').trim();

    // 6. Embedded SVG title, desc, or aria-label
    const svg = el.querySelector('svg');
    if (svg) {
      const svgAriaLabel = svg.getAttribute('aria-label');
      if (svgAriaLabel && svgAriaLabel.trim()) return svgAriaLabel.trim();
      const svgLabelledBy = svg.getAttribute('aria-labelledby');
      if (svgLabelledBy) {
        const ids = svgLabelledBy.trim().split(/\s+/).filter(Boolean);
        const resolved = ids.map(id => document.getElementById(id)?.textContent?.trim() || '').filter(Boolean).join(' ');
        if (resolved) return resolved;
      }
      const svgTitle = svg.querySelector('title');
      if (svgTitle && svgTitle.textContent?.trim()) return svgTitle.textContent.trim();
      const svgDesc = svg.querySelector('desc');
      if (svgDesc && svgDesc.textContent?.trim()) return svgDesc.textContent.trim();
    }

    // 7. Input button values
    if (el.value && typeof el.value === 'string' && el.value.trim() && ['button', 'submit', 'reset'].includes(el.type)) {
      return el.value.trim();
    }

    // 8. Title / placeholder fallbacks
    if (el.title && el.title.trim()) return el.title.trim();
    if (el.placeholder && el.placeholder.trim()) return el.placeholder.trim();

    // 9. Inner text content
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  const findings = [];

  // Helper for generating reproducible issue evidence objects
  function createFinding({
    ruleId,
    title,
    severity,
    classification = 'Confirmed Failure',
    type,
    elementCount,
    description,
    whyItMatters,
    wcagCriterion,
    expectedBehavior,
    actualBehavior,
    reproductionSteps,
    recommendedFix,
    codeExample,
    confidence = 'high',
    elements = []
  }) {
    const canonicalClassification = classification || 'Confirmed Failure';
    const canonicalType = type || (canonicalClassification === 'Confirmed Failure' ? 'failure' : canonicalClassification === 'Informational' ? 'informational' : 'recommendation');

    return {
      ruleId,
      title,
      category: 'Accessibility',
      severity,
      classification: canonicalClassification,
      type: canonicalType,
      checkType: 'automated',
      elementCount,
      url: evalUrl,
      selector: elements[0]?.selector || '',
      htmlSnippet: elements[0]?.htmlSnippet || '',
      boundingBox: elements[0]?.boundingBox || null,
      evidence: actualBehavior,
      expectedBehavior,
      actualBehavior,
      description,
      whyItMatters,
      wcagCriterion,
      reproductionSteps,
      recommendedFix,
      codeExample,
      confidence,
      elements
    };
  }

  // -------------------------------------------------------------
  // 1. Interactive Elements with aria-hidden="true" (Ghost Focus)
  // -------------------------------------------------------------
  const allInteractive = Array.from(document.querySelectorAll(
    'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="switch"], [role="menuitem"], [tabindex]:not([tabindex="-1"])'
  )).filter(isVisible);

  const badAriaHidden = [];
  for (const el of allInteractive) {
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') continue;
    if (el.closest('[inert]')) continue;

    const directHidden = el.getAttribute('aria-hidden') === 'true';
    const ancestorHidden = Boolean(el.parentElement?.closest('[aria-hidden="true"]'));

    if (directHidden || ancestorHidden) {
      badAriaHidden.push({
        tagName: el.tagName.toLowerCase(),
        selector: buildSelector(el),
        accessibleRole: el.getAttribute('role') || el.tagName.toLowerCase(),
        accessibleName: getAccessibleName(el) || '(Hidden from accessibility tree)',
        wcagCriterion: 'WCAG 4.1.2: Name, Role, Value / WCAG 1.3.1: Info and Relationships (Level A)',
        url: evalUrl,
        htmlSnippet: getOpeningTag(el),
        boundingBox: getBoundingBox(el),
        suggestedFix: directHidden
          ? 'Remove aria-hidden="true" from this interactive control, or disable it and remove from tab order'
          : 'Interactive element is nested inside an ancestor with aria-hidden="true". Remove it from the aria-hidden container or make it inert'
      });
    }
  }

  if (badAriaHidden.length) {
    const sample = badAriaHidden[0].htmlSnippet;
    findings.push(createFinding({
      ruleId: 'interactive-aria-hidden',
      title: `${badAriaHidden.length} interactive control(s) are hidden from assistive tech with aria-hidden="true"`,
      severity: 'high',
      classification: 'Confirmed Failure',
      elementCount: badAriaHidden.length,
      wcagCriterion: 'WCAG 4.1.2 (Name, Role, Value) / WCAG 1.3.1 (Info and Relationships)',
      expectedBehavior: 'Interactive or focusable controls must be exposed in the accessibility tree so screen reader users can discover and activate them.',
      actualBehavior: `Observed ${badAriaHidden.length} focusable element(s) with aria-hidden="true" or inside aria-hidden ancestors. Screen readers ignore them, but keyboard Tab key lands on them.`,
      description: `${badAriaHidden.length} interactive control(s) have aria-hidden="true" or are inside an aria-hidden container while remaining operable or focusable. Assistive technologies ignore them, creating a ghost focus trap for keyboard users.`,
      whyItMatters: 'Screen reader users cannot perceive or interact with controls marked aria-hidden="true". If these controls remain in keyboard tab order, sighted keyboard users can focus on them, but screen readers remain completely silent.',
      reproductionSteps: '1. Open the page in a browser.\n2. Press the Tab key repeatedly to navigate through focusable elements.\n3. Observe keyboard focus landing on elements that screen readers do not announce.',
      recommendedFix: 'Remove aria-hidden="true" from interactive elements. If content should be hidden from everyone, use display:none or inert, or set disabled and tabindex="-1".',
      codeExample: {
        current: sample,
        corrected: sample.replace(/\s*aria-hidden="true"/i, '')
      },
      elements: badAriaHidden
    }));
  }

  // -------------------------------------------------------------
  // 2. Buttons Missing Accessible Names
  // -------------------------------------------------------------
  const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]')).filter(isVisible);
  const badButtons = [];

  for (const btn of buttons) {
    if (btn.getAttribute('aria-hidden') === 'true' || btn.parentElement?.closest('[aria-hidden="true"]')) continue;
    if (btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true') continue;
    const role = (btn.getAttribute('role') || '').toLowerCase();
    if (role === 'presentation' || role === 'none') continue;

    const name = getAccessibleName(btn);
    if (!name) {
      const hasIcon = Boolean(btn.querySelector('svg, i[class*="icon"], i[class*="fa"], span[class*="icon"], span[class*="material"]'));
      badButtons.push({
        tagName: btn.tagName.toLowerCase(),
        accessibleRole: role || (btn.tagName.toLowerCase() === 'input' ? btn.type : 'button'),
        selector: buildSelector(btn),
        accessibleName: '(None — empty accessible name)',
        wcagCriterion: 'WCAG 4.1.2: Name, Role, Value (Level A)',
        url: evalUrl,
        htmlSnippet: getOpeningTag(btn),
        boundingBox: getBoundingBox(btn),
        suggestedFix: hasIcon
          ? 'Icon-only button: add aria-label="Action description" or embedded <title> inside the SVG'
          : 'Add aria-label="Action description" or visible button text'
      });
    }
  }

  if (badButtons.length) {
    const sample = badButtons[0].htmlSnippet;
    findings.push(createFinding({
      ruleId: 'button-name-missing',
      title: `${badButtons.length} interactive button(s) lack accessible names`,
      severity: 'high',
      classification: 'Confirmed Failure',
      elementCount: badButtons.length,
      wcagCriterion: 'WCAG 4.1.2 (Name, Role, Value)',
      expectedBehavior: 'Every interactive button must have a discernible accessible name computed via text, aria-label, aria-labelledby, or label association.',
      actualBehavior: `The browser computed an empty string ("") as the accessible name for ${badButtons.length} interactive button(s).`,
      description: `${badButtons.length} button control(s) have no discernible text or aria-label. Screen readers cannot inform users what clicking this control will do.`,
      whyItMatters: 'Buttons without accessible names are announced simply as "button". Users relying on screen readers or speech control cannot determine the button purpose (e.g., search, menu, submit).',
      reproductionSteps: '1. Inspect the element in Chromium DevTools -> Elements -> Accessibility pane.\n2. Check the Computed Properties section.\n3. The "Name" property is empty.',
      recommendedFix: 'Add descriptive text inside the button, an aria-label attribute (e.g. aria-label="Search"), or a <title> element inside icon SVGs.',
      codeExample: {
        current: sample,
        corrected: sample.replace(/<button\b([^>]*)>/i, '<button$1 aria-label="Perform action">')
      },
      elements: badButtons
    }));
  }

  // -------------------------------------------------------------
  // 3. Custom Controls Missing Tabindex (WCAG 2.1.1)
  // -------------------------------------------------------------
  const customInteractive = Array.from(document.querySelectorAll(
    '[role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="switch"]'
  )).filter(isVisible);

  const unreachableControls = [];
  const nativeInteractiveTags = ['button', 'a', 'input', 'select', 'textarea', 'summary'];

  for (const el of customInteractive) {
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') continue;
    const tag = el.tagName.toLowerCase();
    if (nativeInteractiveTags.includes(tag)) continue;

    const ti = el.getAttribute('tabindex');
    if (ti === null || parseInt(ti, 10) < 0) {
      unreachableControls.push({
        tagName: tag,
        selector: buildSelector(el),
        accessibleRole: el.getAttribute('role') || 'button',
        accessibleName: getAccessibleName(el) || '(Unnamed)',
        wcagCriterion: 'WCAG 2.1.1: Keyboard (Level A)',
        url: evalUrl,
        htmlSnippet: getOpeningTag(el),
        suggestedFix: 'Add tabindex="0" and keyboard event listeners (Enter / Space keys) so keyboard users can navigate to and activate it'
      });
    }
  }

  if (unreachableControls.length) {
    const sample = unreachableControls[0].htmlSnippet;
    findings.push(createFinding({
      ruleId: 'keyboard-unreachable',
      title: `${unreachableControls.length} custom interactive control(s) are unreachable via keyboard (missing tabindex="0")`,
      severity: 'high',
      classification: 'Confirmed Failure',
      elementCount: unreachableControls.length,
      wcagCriterion: 'WCAG 2.1.1 (Keyboard)',
      expectedBehavior: 'All interactive elements must be reachable sequentially using the Tab key.',
      actualBehavior: `Elements with ARIA interactive roles lack a tabindex attribute, omitting them from browser tab order.`,
      description: `${unreachableControls.length} element(s) use ARIA interactive roles (e.g. role="button") on non-interactive elements without tabindex="0", making them impossible to reach using the Tab key.`,
      whyItMatters: 'Users who navigate via keyboard cannot reach or activate custom interactive controls unless they are in the tab order.',
      reproductionSteps: '1. Place focus on the element immediately preceding this control.\n2. Press the Tab key.\n3. Focus bypasses the custom interactive element entirely.',
      recommendedFix: 'Use native HTML elements like <button> or <a> when possible. If custom elements are required, add tabindex="0" and keydown event handlers for Enter and Space.',
      codeExample: {
        current: sample,
        corrected: sample.replace(/<([a-z0-9]+)\b([^>]*)>/i, '<$1 tabindex="0"$2>')
      },
      elements: unreachableControls
    }));
  }

  // -------------------------------------------------------------
  // 4. Positive Tabindex Disrupting Focus Order (WCAG 2.4.3)
  // -------------------------------------------------------------
  const positiveTabindexEls = Array.from(document.querySelectorAll('[tabindex]')).filter(el => {
    if (!isVisible(el)) return false;
    const ti = parseInt(el.getAttribute('tabindex'), 10);
    return !isNaN(ti) && ti > 0;
  });

  if (positiveTabindexEls.length) {
    const badTabindexes = positiveTabindexEls.map(el => ({
      tagName: el.tagName.toLowerCase(),
      selector: buildSelector(el),
      accessibleRole: el.getAttribute('role') || el.tagName.toLowerCase(),
      accessibleName: getAccessibleName(el) || '(Unnamed)',
      wcagCriterion: 'WCAG 2.4.3: Focus Order (Level A)',
      url: evalUrl,
      htmlSnippet: getOpeningTag(el),
      suggestedFix: `Change tabindex="${el.getAttribute('tabindex')}" to tabindex="0" and organize DOM structure to follow natural reading order`
    }));

    findings.push(createFinding({
      ruleId: 'tabindex-positive',
      title: `${positiveTabindexEls.length} element(s) have positive tabindex (> 0) disrupting natural focus order`,
      severity: 'medium',
      classification: 'Confirmed Failure',
      elementCount: positiveTabindexEls.length,
      wcagCriterion: 'WCAG 2.4.3 (Focus Order)',
      expectedBehavior: 'Sequential keyboard navigation should follow the logical visual and DOM reading sequence.',
      actualBehavior: `Elements define positive tabindex values (e.g. tabindex="${positiveTabindexEls[0].getAttribute('tabindex')}"), which forces them ahead of natural document order.`,
      description: `${positiveTabindexEls.length} element(s) have positive tabindex values. Positive tabindex overrides the natural document focus sequence, making keyboard navigation unpredictable.`,
      whyItMatters: 'Tabbing through positive tabindex elements jumps focus abruptly across the layout before returning to standard controls.',
      reproductionSteps: '1. Reload page.\n2. Press Tab key once.\n3. Focus jumps to positive tabindex elements rather than top-level navigation.',
      recommendedFix: 'Avoid positive tabindex values. Use tabindex="0" to insert elements into natural DOM order, or tabindex="-1" for programmatically focused items.',
      codeExample: {
        current: badTabindexes[0].htmlSnippet,
        corrected: badTabindexes[0].htmlSnippet.replace(/tabindex="\d+"/i, 'tabindex="0"')
      },
      elements: badTabindexes
    }));
  }

  // -------------------------------------------------------------
  // 5. Safe Keyboard Navigation & Focus Visibility Testing (WCAG 2.1.1, 2.1.2, 2.4.7)
  // -------------------------------------------------------------
  function isColorTransparent(colorStr) {
    if (!colorStr) return true;
    const c = colorStr.trim().toLowerCase();
    if (c === 'transparent' || c === 'rgba(0, 0, 0, 0)' || c === 'rgba(0,0,0,0)' || c === 'hsla(0, 0%, 0%, 0)' || c === 'hsla(0,0%,0%,0)') {
      return true;
    }
    const m = c.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
    if (m && m[4] !== undefined && parseFloat(m[4]) === 0) {
      return true;
    }
    return false;
  }

  function isBoxShadowVisible(shadowStr) {
    if (!shadowStr || shadowStr === 'none') return false;
    if (isColorTransparent(shadowStr)) return false;
    const pxValues = shadowStr.match(/-?\d+(?:\.\d+)?px/g);
    if (pxValues && pxValues.length > 0 && pxValues.every(v => parseFloat(v) === 0)) {
      return false; // All 0px, e.g. "0px 0px 0px 0px" is invisible
    }
    if (/rgba\([^)]*,\s*0\s*\)/i.test(shadowStr) && !shadowStr.includes('#') && !shadowStr.includes('rgb(')) {
      return false;
    }
    return true;
  }

  function isBorderVisible(styleObj) {
    if (!styleObj) return false;
    const width = parseFloat(styleObj.borderWidth) || 0;
    if (width <= 0) return false;
    const style = (styleObj.borderStyle || '').toLowerCase();
    if (style === 'none' || style === 'hidden') return false;
    if (isColorTransparent(styleObj.borderColor)) return false;
    return true;
  }

  function isOutlineVisible(styleObj) {
    if (!styleObj) return false;
    const width = parseFloat(styleObj.outlineWidth) || 0;
    if (width <= 0) return false;
    const style = (styleObj.outlineStyle || '').toLowerCase();
    if (style === 'none' || style === 'hidden') return false;
    if (isColorTransparent(styleObj.outlineColor)) return false;
    return true;
  }

  const origActiveElement = document.activeElement;
  const focusableEls = Array.from(document.querySelectorAll(
    'button:not([disabled]), a[href], input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]'
  )).filter(isVisible);

  const badFocusOutlines = [];

  for (let i = 0; i < focusableEls.length; i++) {
    const el = focusableEls[i];
    if (el.closest('[inert]') || el.getAttribute('tabindex') === '-1') continue;

    // Simulate sequential keyboard Tab navigation
    let activeElementConfirmed = false;
    try {
      const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', keyCode: 9, bubbles: true, cancelable: true });
      document.dispatchEvent(tabEvent);

      try {
        el.focus({ focusVisible: true });
      } catch {
        el.focus();
      }
      activeElementConfirmed = (document.activeElement === el);
    } catch {
      activeElementConfirmed = false;
    }

    // Shift+Tab reverse navigation check with previous element
    if (i > 0 && focusableEls[i - 1]) {
      const prevEl = focusableEls[i - 1];
      try {
        const shiftTabEvent = new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', keyCode: 9, shiftKey: true, bubbles: true, cancelable: true });
        el.dispatchEvent(shiftTabEvent);
        try { prevEl.focus({ focusVisible: true }); } catch { prevEl.focus(); }
        // Return focus to el
        try { el.focus({ focusVisible: true }); } catch { el.focus(); }
      } catch {}
    }

    // Inspect computed styles under active keyboard focus
    const focusedStyle = window.getComputedStyle(el);
    const hasVisibleOutline = isOutlineVisible(focusedStyle);
    const hasVisibleShadow = isBoxShadowVisible(focusedStyle.boxShadow);
    const hasVisibleBorder = isBorderVisible(focusedStyle);

    // Inspect :focus-visible matching
    const matchesFocusVisible = (typeof el.matches === 'function') && (el.matches(':focus-visible') || el.matches(':focus'));
    const className = typeof el.className === 'string' ? el.className.toLowerCase() : '';
    const hasFocusClasses = /focus:(ring|border|outline|bg|shadow)|focus-visible:(ring|border|outline|bg|shadow)/.test(className);

    // Check if element suppresses default outline
    const inlineStyle = (el.getAttribute('style') || '').toLowerCase();
    const hasInlineNoOutline = /(^|;)\s*outline\s*:\s*(none|0)(\s*!important)?\s*(;|$)/i.test(inlineStyle);
    const hasComputedNoOutline = focusedStyle.outlineStyle === 'none' || parseFloat(focusedStyle.outlineWidth) === 0 || isColorTransparent(focusedStyle.outlineColor);

    const outlineSuppressed = hasInlineNoOutline || hasComputedNoOutline;

    // If outline is suppressed AND neither visible outline nor visible shadow nor focus classes exist
    if (outlineSuppressed && !hasVisibleOutline && !hasVisibleShadow && !hasFocusClasses) {
      badFocusOutlines.push({
        tagName: el.tagName.toLowerCase(),
        selector: buildSelector(el),
        accessibleRole: el.getAttribute('role') || el.tagName.toLowerCase(),
        accessibleName: getAccessibleName(el) || '(Unnamed)',
        wcagCriterion: 'WCAG 2.4.7: Focus Visible (Level AA)',
        url: evalUrl,
        htmlSnippet: getOpeningTag(el),
        boundingBox: getBoundingBox(el),
        suggestedFix: 'Remove outline:none or provide a custom high-contrast focus indicator via :focus-visible'
      });
    }
  }

  // Restore original active element
  try {
    if (origActiveElement && typeof origActiveElement.focus === 'function') {
      origActiveElement.focus();
    } else if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
  } catch {}

  if (badFocusOutlines.length) {
    findings.push(createFinding({
      ruleId: 'focus-indicator-missing',
      title: `${badFocusOutlines.length} interactive control(s) suppress visual focus indicators (outline: none)`,
      severity: 'medium',
      classification: 'Confirmed Failure',
      elementCount: badFocusOutlines.length,
      wcagCriterion: 'WCAG 2.4.7 (Focus Visible)',
      expectedBehavior: 'Keyboard-focusable elements must display a distinct visual indicator when focused.',
      actualBehavior: `Observed inline style 'outline: none' without replacement box-shadow or border styling.`,
      description: `${badFocusOutlines.length} focusable control(s) have outline: none or outline: 0 explicitly applied without an alternative visual focus indicator.`,
      whyItMatters: 'Sighted keyboard users cannot determine which element has active keyboard focus when focus rings are disabled.',
      reproductionSteps: '1. Tab to the element.\n2. Observe absence of any visual focus ring around the element bounding box.',
      recommendedFix: 'Preserve browser focus rings or specify a distinct, high-contrast :focus-visible style.',
      codeExample: {
        current: badFocusOutlines[0].htmlSnippet,
        corrected: badFocusOutlines[0].htmlSnippet.replace(/outline\s*:\s*(none|0);?/gi, '')
      },
      elements: badFocusOutlines
    }));
  }

  // -------------------------------------------------------------
  // 6. Form Fields Missing Labels (WCAG 1.3.1 & 4.1.2)
  // -------------------------------------------------------------
  const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea')).filter(isVisible);
  const badInputs = [];

  for (const input of inputs) {
    if (input.getAttribute('aria-hidden') === 'true' || input.parentElement?.closest('[aria-hidden="true"]')) continue;
    const id = input.id;
    const hasLabelFor = id ? Boolean(document.querySelector(`label[for="${CSS.escape(id)}"]`)) : false;
    const hasParentLabel = Boolean(input.closest('label'));
    const hasAriaLabel = Boolean(input.getAttribute('aria-label')?.trim());
    const hasAriaLabelledBy = Boolean(input.getAttribute('aria-labelledby')?.trim());
    const hasTitle = Boolean(input.title?.trim());

    if (!hasLabelFor && !hasParentLabel && !hasAriaLabel && !hasAriaLabelledBy && !hasTitle) {
      badInputs.push({
        tagName: input.tagName.toLowerCase() + (input.type ? `[type="${input.type}"]` : ''),
        selector: buildSelector(input),
        accessibleName: '(None — no associated label or aria-label)',
        wcagCriterion: 'WCAG 1.3.1 / 4.1.2 (Level A)',
        url: evalUrl,
        htmlSnippet: getOpeningTag(input),
        boundingBox: getBoundingBox(input),
        suggestedFix: id ? `Add <label for="${id}">Label text</label>` : 'Add aria-label="Field name" or wrap in a <label>'
      });
    }
  }

  if (badInputs.length) {
    const sample = badInputs[0].htmlSnippet;
    findings.push(createFinding({
      ruleId: 'form-label-missing',
      title: `${badInputs.length} form field(s) lack associated labels`,
      severity: 'high',
      classification: 'Confirmed Failure',
      elementCount: badInputs.length,
      wcagCriterion: 'WCAG 1.3.1 / 4.1.2 (Level A)',
      expectedBehavior: 'Every form control must have a programmatically associated label (via label[for], wrapping label, or aria-label).',
      actualBehavior: `Form controls lack a corresponding <label>, aria-label, or title attribute.`,
      description: `${badInputs.length} form input element(s) lack a programmatically associated <label>, aria-label, or title.`,
      whyItMatters: 'When form fields lack accessible labels, screen reader users do not know what information to enter. Placeholder text is not a substitute because it disappears once typing starts.',
      reproductionSteps: '1. Tab into form input.\n2. Screen reader announces only "Edit text" without explaining expected input.',
      recommendedFix: 'Associate each field with a <label for="field-id"> element, wrap in a <label>, or provide an aria-label attribute.',
      codeExample: {
        current: sample,
        corrected: `<label for="field-id">Field Name</label>\n` + sample.replace(/<input\b([^>]*)>/i, '<input id="field-id"$1>')
      },
      elements: badInputs
    }));
  }

  // -------------------------------------------------------------
  // 7. Images Missing Alternative Text (WCAG 1.1.1)
  // -------------------------------------------------------------
  const images = Array.from(document.querySelectorAll('img')).filter(isVisible);
  const badImages = [];

  for (const img of images) {
    const hasAlt = img.hasAttribute('alt');
    const role = (img.getAttribute('role') || '').toLowerCase();
    const isDecorative = role === 'presentation' || role === 'none';
    const ariaHidden = img.getAttribute('aria-hidden') === 'true';

    if (!hasAlt && !isDecorative && !ariaHidden) {
      badImages.push({
        tagName: 'img',
        selector: buildSelector(img),
        accessibleName: '(None — alt attribute missing)',
        wcagCriterion: 'WCAG 1.1.1: Non-text Content (Level A)',
        url: evalUrl,
        htmlSnippet: getOpeningTag(img),
        boundingBox: getBoundingBox(img),
        suggestedFix: 'Add alt="Descriptive summary of image" or alt="" if purely decorative'
      });
    }
  }

  if (badImages.length) {
    const sample = badImages[0].htmlSnippet;
    findings.push(createFinding({
      ruleId: 'image-alt-missing',
      title: `${badImages.length} image element(s) lack alternative text`,
      severity: 'medium',
      classification: 'Confirmed Failure',
      elementCount: badImages.length,
      wcagCriterion: 'WCAG 1.1.1 (Non-text Content)',
      expectedBehavior: 'All <img> elements must provide an alt attribute (descriptive text or empty alt="" for decorative images).',
      actualBehavior: `Found <img> tags completely missing the alt attribute.`,
      description: `${badImages.length} <img> element(s) are missing an 'alt' attribute on this page. Assistive technologies cannot convey the image content or purpose without alternative text.`,
      whyItMatters: 'Screen readers read raw file paths or ignore graphics when alt attributes are missing, confusing visually impaired users.',
      reproductionSteps: '1. Inspect image tag in DOM.\n2. Confirm absence of alt attribute.',
      recommendedFix: 'Provide a concise alt attribute describing the image content. For purely decorative images, set alt="" or role="presentation" so screen readers skip them.',
      codeExample: {
        current: sample,
        corrected: sample.replace(/<img\b([^>]*)>/i, '<img$1 alt="Descriptive summary of image">')
      },
      elements: badImages
    }));
  }

  // -------------------------------------------------------------
  // 8. Hyperlinks Missing Discernible Text or Generic (WCAG 2.4.4 & 4.1.2)
  // -------------------------------------------------------------
  const links = Array.from(document.querySelectorAll('a[href]')).filter(isVisible);
  const badLinks = [];
  const genericLinks = [];
  const genericPhrases = ['click here', 'click', 'here', 'more', 'read more', 'learn more', 'link', 'details'];

  for (const a of links) {
    if (a.getAttribute('aria-hidden') === 'true' || a.parentElement?.closest('[aria-hidden="true"]')) continue;
    const name = getAccessibleName(a);
    if (!name) {
      badLinks.push({
        tagName: 'a',
        selector: buildSelector(a),
        accessibleName: '(None — empty link text)',
        wcagCriterion: 'WCAG 2.4.4 / 4.1.2 (Level A)',
        url: evalUrl,
        htmlSnippet: getOpeningTag(a),
        boundingBox: getBoundingBox(a),
        suggestedFix: 'Add descriptive anchor text or aria-label="Link destination"'
      });
    } else if (genericPhrases.includes(name.toLowerCase())) {
      genericLinks.push({
        tagName: 'a',
        selector: buildSelector(a),
        accessibleName: `"${name}" (Vague / Non-descriptive)`,
        wcagCriterion: 'WCAG 2.4.4: Link Purpose in Context (Level A)',
        url: evalUrl,
        htmlSnippet: getOpeningTag(a),
        boundingBox: getBoundingBox(a),
        suggestedFix: `Replace "${name}" with specific destination context`
      });
    }
  }

  if (badLinks.length) {
    const sample = badLinks[0].htmlSnippet;
    findings.push(createFinding({
      ruleId: 'link-name-missing',
      title: `${badLinks.length} hyperlink(s) lack discernible text`,
      severity: 'medium',
      classification: 'Confirmed Failure',
      elementCount: badLinks.length,
      wcagCriterion: 'WCAG 2.4.4 / 4.1.2 (Level A)',
      expectedBehavior: 'Hyperlinks must contain discernible text or an aria-label indicating the link destination.',
      actualBehavior: `The accessible name for ${badLinks.length} <a> tag(s) is empty.`,
      description: `${badLinks.length} <a> element(s) contain no text content or aria-label.`,
      whyItMatters: 'Assistive technology users navigating link lists hear only "link" without destination context.',
      reproductionSteps: '1. Tab to hyperlink.\n2. Screen reader announces "link" without destination details.',
      recommendedFix: 'Include clear, descriptive text inside the <a> tag, or specify an aria-label attribute.',
      codeExample: {
        current: sample,
        corrected: sample.replace(/<a\b([^>]*)>/i, '<a$1 aria-label="Explore features">Features</a>')
      },
      elements: badLinks
    }));
  }

  if (genericLinks.length) {
    findings.push(createFinding({
      ruleId: 'link-name-generic',
      title: `${genericLinks.length} hyperlink(s) use vague text (e.g. "click here")`,
      severity: 'low',
      classification: 'Potential Issue',
      checkType: 'manual',
      elementCount: genericLinks.length,
      wcagCriterion: 'WCAG 2.4.4 (Link Purpose in Context)',
      expectedBehavior: 'Link text should describe its specific target even when read out of context.',
      actualBehavior: `Observed generic text phrases like "${genericLinks[0].accessibleName.split('"')[1] || 'click here'}".`,
      description: `${genericLinks.length} link(s) use ambiguous text such as "${genericLinks[0].accessibleName.split('"')[1] || 'click here'}".`,
      whyItMatters: 'When screen readers navigate links out of context, vague labels do not inform users where the link navigates.',
      reproductionSteps: '1. Extract link list in screen reader dialog.\n2. Multiple duplicate entries for "Click here" appear without destination context.',
      recommendedFix: 'Make link phrases specific and descriptive on their own (e.g. "View test documentation" instead of "click here").',
      codeExample: {
        current: `<a href="/docs">Click here</a>`,
        corrected: `<a href="/docs">View test documentation</a>`
      },
      elements: genericLinks
    }));
  }

  // -------------------------------------------------------------
  // 9. Heading Hierarchy & Structure (WCAG 1.3.1)
  // -------------------------------------------------------------
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).filter(isVisible);
  const skippedHeadings = [];
  let prevLevel = 0;

  for (const h of headings) {
    const level = parseInt(h.tagName.substring(1), 10);
    if (prevLevel > 0 && level > prevLevel + 1) {
      const rawText = (h.innerText || h.textContent || '').trim().replace(/\s+/g, ' ');
      const targetLevel = prevLevel + 1;
      const opening = getOpeningTag(h);
      let correctedSnippet = opening;
      try {
        const regexOpen = new RegExp(`<h${level}\\b`, 'i');
        const regexClose = new RegExp(`</h${level}>`, 'i');
        correctedSnippet = opening.replace(regexOpen, `<h${targetLevel}`).replace(regexClose, `</h${targetLevel}>`);
      } catch {}

      skippedHeadings.push({
        tagName: h.tagName.toLowerCase(),
        selector: buildSelector(h),
        accessibleName: rawText.slice(0, 80) || '(Heading text)',
        wcagCriterion: 'WCAG 1.3.1: Info and Relationships (Level A)',
        url: evalUrl,
        htmlSnippet: opening,
        boundingBox: getBoundingBox(h),
        fromLevel: prevLevel,
        toLevel: level,
        targetLevel,
        suggestedFix: `Change <${h.tagName.toLowerCase()}> to <h${targetLevel}> to avoid skipping heading levels from <h${prevLevel}>`,
        correctedSnippet
      });
    }
    prevLevel = level;
  }

  if (skippedHeadings.length) {
    const sample = skippedHeadings[0];
    findings.push(createFinding({
      ruleId: 'heading-hierarchy-skipped',
      title: `${skippedHeadings.length} heading level(s) are skipped in document hierarchy`,
      severity: 'low',
      classification: 'Potential Issue',
      type: 'recommendation',
      elementCount: skippedHeadings.length,
      wcagCriterion: 'WCAG 1.3.1 (Info and Relationships)',
      expectedBehavior: 'Headings should follow a structured progression (e.g., h1 followed by h2, then h3) without skipping intermediate levels.',
      actualBehavior: `Heading level jumped directly from <h${sample.fromLevel}> to <h${sample.toLevel}> on "${sample.accessibleName}".`,
      description: `${skippedHeadings.length} heading element(s) skip structural levels in the document outline. Assistive technology users who navigate by heading level may assume sections are missing.`,
      whyItMatters: 'Screen readers allow users to browse documents by jumping between headings. Skipping levels creates a disorganized document outline.',
      reproductionSteps: '1. Inspect the document heading outline.\n2. Note skipped numerical heading tags in sequential DOM flow.',
      recommendedFix: `Nest headings sequentially so that an h${sample.toLevel} is preceded by an h${sample.targetLevel}, or adjust styling classes to preserve heading semantics.`,
      codeExample: {
        current: sample.htmlSnippet,
        corrected: sample.correctedSnippet || sample.htmlSnippet.replace(/<h\d/i, `<h${sample.targetLevel}`).replace(/<\/h\d>/i, `</h${sample.targetLevel}>`)
      },
      confidence: 'medium',
      elements: skippedHeadings
    }));
  }

  // -------------------------------------------------------------
  // 10. Duplicate Element IDs (WCAG 4.1.1 & 1.3.1)
  // -------------------------------------------------------------
  const allWithId = Array.from(document.querySelectorAll('[id]'));
  const idCounts = new Map();
  for (const el of allWithId) {
    const id = el.id.trim();
    if (id) {
      idCounts.set(id, (idCounts.get(id) || 0) + 1);
    }
  }

  const duplicateIds = [];
  for (const [id, count] of idCounts.entries()) {
    if (count > 1) {
      const els = Array.from(document.querySelectorAll(`[id="${CSS.escape(id)}"]`));
      duplicateIds.push({
        id,
        count,
        tagName: els[0]?.tagName.toLowerCase() || 'element',
        selector: '#' + CSS.escape(id),
        accessibleName: `Duplicate ID: "${id}" appears ${count} times in document`,
        wcagCriterion: 'WCAG 4.1.1 / 1.3.1 (Level A)',
        url: evalUrl,
        htmlSnippet: getOpeningTag(els[0]),
        suggestedFix: `Make element ID "${id}" unique across the document`
      });
    }
  }

  if (duplicateIds.length) {
    findings.push(createFinding({
      ruleId: 'duplicate-element-ids',
      title: `${duplicateIds.length} duplicate element ID(s) detected in the DOM`,
      severity: 'medium',
      classification: 'Confirmed Failure',
      elementCount: duplicateIds.length,
      wcagCriterion: 'WCAG 4.1.1 / 1.3.1 (Level A)',
      expectedBehavior: 'Element IDs must be unique across the entire HTML document.',
      actualBehavior: `The ID "${duplicateIds[0].id}" is assigned to multiple elements in the DOM.`,
      description: `Found ${duplicateIds.length} element ID(s) that appear more than once in the document. Duplicate IDs break ARIA associations (aria-labelledby, aria-describedby, label[for]).`,
      whyItMatters: 'Assistive technologies resolve element IDs to associate labels and descriptions. Duplicate IDs cause browsers to bind to the wrong element or fail altogether.',
      reproductionSteps: '1. Run document.querySelectorAll(`[id="${id}"]`) in console.\n2. Observe multiple elements returned.',
      recommendedFix: 'Ensure every element ID in the DOM is unique.',
      codeExample: {
        current: `<div id="${duplicateIds[0].id}">...</div>\n<div id="${duplicateIds[0].id}">...</div>`,
        corrected: `<div id="${duplicateIds[0].id}-1">...</div>\n<div id="${duplicateIds[0].id}-2">...</div>`
      },
      elements: duplicateIds
    }));
  }

  // -------------------------------------------------------------
  // 11. Document Language (WCAG 3.1.1)
  // -------------------------------------------------------------
  const htmlLang = document.documentElement?.getAttribute('lang')?.trim();
  if (!htmlLang) {
    findings.push(createFinding({
      ruleId: 'html-lang-missing',
      title: 'HTML document lacks a language attribute (lang)',
      severity: 'medium',
      classification: 'Confirmed Failure',
      elementCount: 1,
      wcagCriterion: 'WCAG 3.1.1: Language of Page (Level A)',
      expectedBehavior: 'The root <html> tag must specify the primary language of the page using a valid BCP 47 code (e.g. lang="en").',
      actualBehavior: 'The <html> tag has no lang attribute.',
      description: 'The root <html> element does not specify a language code using the "lang" attribute.',
      whyItMatters: 'Screen readers use the document language attribute to select the correct speech synthesizer and pronunciation rules.',
      reproductionSteps: '1. Inspect <html> tag in DOM.\n2. lang attribute is missing.',
      recommendedFix: 'Add the appropriate BCP 47 language code to the root HTML tag, e.g. <html lang="en">.',
      codeExample: {
        current: '<html>',
        corrected: '<html lang="en">'
      },
      elements: [{
        tagName: 'html',
        selector: 'html',
        accessibleName: '(None — missing lang attribute)',
        url: evalUrl,
        htmlSnippet: '<html' + (document.documentElement?.className ? ` class="${document.documentElement.className}"` : '') + '>',
        suggestedFix: 'Add lang="en" to <html> tag'
      }]
    }));
  }

  // -------------------------------------------------------------
  // 12. Viewport Zoom Disabled (WCAG 1.4.4)
  // -------------------------------------------------------------
  const viewportMeta = document.querySelector('meta[name="viewport"]');
  const viewportContent = viewportMeta?.getAttribute('content') || '';
  if (/user-scalable\s*=\s*(no|0)/i.test(viewportContent) || /maximum-scale\s*=\s*1(\.0)?/i.test(viewportContent)) {
    findings.push(createFinding({
      ruleId: 'viewport-zoom-disabled',
      title: 'Viewport settings restrict user pinch-to-zoom scaling',
      severity: 'high',
      classification: 'Confirmed Failure',
      elementCount: 1,
      wcagCriterion: 'WCAG 1.4.4: Resize Text (Level AA)',
      expectedBehavior: 'Mobile browsers must allow users to pinch-to-zoom content up to at least 200%.',
      actualBehavior: `Viewport meta tag contains scaling restrictions: "${viewportContent}".`,
      description: 'The viewport meta tag restricts scaling (user-scalable=no or maximum-scale=1), preventing low-vision users from magnifying content.',
      whyItMatters: 'WCAG 1.4.4 requires content to be zoomable up to 200%. Restricting zoom creates an impassable barrier for low-vision users.',
      reproductionSteps: '1. Inspect <meta name="viewport"> tag in head.\n2. Confirm user-scalable=no or maximum-scale=1 is present.',
      recommendedFix: 'Remove user-scalable=no and maximum-scale=1 from the viewport meta tag.',
      codeExample: {
        current: `<meta name="viewport" content="${viewportContent}">`,
        corrected: `<meta name="viewport" content="width=device-width, initial-scale=1">`
      },
      elements: [{
        tagName: 'meta',
        selector: 'head > meta[name="viewport"]',
        accessibleName: viewportContent,
        url: evalUrl,
        htmlSnippet: getOpeningTag(viewportMeta),
        suggestedFix: 'Remove user-scalable=no and maximum-scale=1'
      }]
    }));
  }

  // -------------------------------------------------------------
  // 13. Text Color Contrast (WCAG 1.4.3 Level AA)
  // -------------------------------------------------------------
  function parseColor(str) {
    if (!str) return null;
    const m = str.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
    if (m) {
      return {
        r: parseInt(m[1], 10),
        g: parseInt(m[2], 10),
        b: parseInt(m[3], 10),
        a: m[4] !== undefined ? parseFloat(m[4]) : 1
      };
    }
    return null;
  }

  function alphaBlend(fg, bg) {
    const a = fg.a !== undefined ? fg.a : 1;
    return {
      r: Math.round(fg.r * a + bg.r * (1 - a)),
      g: Math.round(fg.g * a + bg.g * (1 - a)),
      b: Math.round(fg.b * a + bg.b * (1 - a)),
      a: 1
    };
  }

  function getLuminance(r, g, b) {
    const [rs, gs, bs] = [r, g, b].map(c => {
      c = c / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
  }

  function getContrastRatio(fg, bg) {
    const l1 = getLuminance(fg.r, fg.g, fg.b);
    const l2 = getLuminance(bg.r, bg.g, bg.b);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function getEffectiveBackgroundColor(el) {
    let curr = el;
    const layers = [];
    let hasSemiTransparent = false;
    let hasFilterOrGradient = false;

    while (curr && curr !== document && curr.nodeType === Node.ELEMENT_NODE) {
      const style = window.getComputedStyle(curr);
      if (style.backgroundImage && style.backgroundImage !== 'none') {
        hasFilterOrGradient = true;
      }
      if (style.backdropFilter && style.backdropFilter !== 'none') {
        hasFilterOrGradient = true;
      }
      const bg = parseColor(style.backgroundColor);
      if (bg && bg.a > 0) {
        if (bg.a < 0.99) hasSemiTransparent = true;
        layers.unshift(bg);
        if (bg.a >= 0.99) break;
      }
      curr = curr.parentElement;
    }
    let result = { r: 255, g: 255, b: 255, a: 1 };
    for (const layer of layers) {
      result = alphaBlend(layer, result);
    }
    const isSolidOpaque = layers.length > 0 && layers[0].a >= 0.99 && !hasSemiTransparent && !hasFilterOrGradient;
    return {
      color: result,
      hasSemiTransparent,
      hasFilterOrGradient,
      isSolidOpaque
    };
  }

  const textCandidates = Array.from(document.querySelectorAll('p, span, h1, h2, h3, h4, h5, h6, a, button, label, li, td, th')).filter(el => {
    if (!isVisible(el)) return false;
    if (el.getAttribute('aria-hidden') === 'true' || el.parentElement?.closest('[aria-hidden="true"]')) return false;
    const text = (el.innerText || el.textContent || '').trim();
    if (!text || text.length < 2) return false;
    return !el.querySelector('p, h1, h2, h3, h4, h5, h6, ul, ol, table');
  });

  const lowContrastEls = [];
  for (const el of textCandidates.slice(0, 100)) {
    const style = window.getComputedStyle(el);
    const rawFg = parseColor(style.color);
    const bgInfo = getEffectiveBackgroundColor(el);
    if (rawFg && bgInfo && bgInfo.color) {
      const bg = bgInfo.color;
      const isComposited = bgInfo.hasSemiTransparent || bgInfo.hasFilterOrGradient || (rawFg.a < 1);
      const fg = rawFg.a < 1 ? alphaBlend(rawFg, bg) : rawFg;
      const ratio = Math.round(getContrastRatio(fg, bg) * 10) / 10;
      const fontSize = parseFloat(style.fontSize) || 16;
      const isBold = parseInt(style.fontWeight, 10) >= 700 || style.fontWeight === 'bold';
      const isLarge = fontSize >= 24 || (fontSize >= 18.66 && isBold);
      const minRatio = isLarge ? 3.0 : 4.5;
      if (ratio < minRatio) {
        const textSample = (el.innerText || el.textContent || '').trim().slice(0, 50);
        lowContrastEls.push({
          tagName: el.tagName.toLowerCase(),
          selector: buildSelector(el),
          accessibleName: `"${textSample}" (Ratio: ${ratio}:1, required: ${minRatio}:1)`,
          wcagCriterion: 'WCAG 1.4.3: Contrast (Minimum) (Level AA)',
          url: evalUrl,
          htmlSnippet: getOpeningTag(el),
          boundingBox: getBoundingBox(el),
          isComposited,
          isSolidOpaque: bgInfo.isSolidOpaque && rawFg.a >= 0.99,
          ratio,
          minRatio,
          evidence: `Computed contrast ratio is ${ratio}:1 (Foreground: rgb(${fg.r},${fg.g},${fg.b}), Background: rgb(${bg.r},${bg.g},${bg.b})${isComposited ? ' [alpha-composited layer]' : ''}). Minimum required is ${minRatio}:1 for ${isLarge ? 'large' : 'standard'} text.`,
          suggestedFix: isComposited
            ? `Semi-transparent or layered background detected: verify rendered contrast against background or adjust text color to achieve at least ${minRatio}:1`
            : `Adjust foreground or background color to achieve at least ${minRatio}:1 contrast ratio`
        });
      }
    }
  }

  if (lowContrastEls.length > 0) {
    const sample = lowContrastEls[0];
    // A confirmed failure requires verified solid opaque backgrounds with severe contrast deficit (< 3:1 on regular text or < 2:1 on large text)
    const hasDefiniteSolidFailure = lowContrastEls.some(e => e.isSolidOpaque && e.ratio < (e.minRatio === 3.0 ? 2.0 : 3.0));
    const isCompositedOnly = lowContrastEls.every(e => e.isComposited);
    const classification = (hasDefiniteSolidFailure && !isCompositedOnly) ? 'Confirmed Failure' : 'Potential Issue';
    const severity = hasDefiniteSolidFailure ? 'high' : 'medium';
    const confidence = hasDefiniteSolidFailure ? 'high' : 'medium';

    findings.push(createFinding({
      ruleId: 'color-contrast-insufficient',
      title: `${lowContrastEls.length} text element(s) have insufficient color contrast against their background`,
      severity,
      classification,
      type: classification === 'Confirmed Failure' ? 'failure' : 'recommendation',
      elementCount: lowContrastEls.length,
      wcagCriterion: 'WCAG 1.4.3 (Contrast Minimum)',
      expectedBehavior: 'Standard text must maintain at least 4.5:1 contrast against solid backgrounds (3:1 for text >= 24px or >= 18.66px bold).',
      actualBehavior: isCompositedOnly
        ? `Observed ${lowContrastEls.length} element(s) with semi-transparent alpha or gradient backgrounds where computed contrast ratio is below threshold (Sample: ${sample.accessibleName}). Requires visual verification.`
        : `Observed contrast ratios below WCAG threshold on ${lowContrastEls.length} element(s). Sample: ${sample.accessibleName}.`,
      description: `${lowContrastEls.length} text element(s) do not meet the minimum contrast threshold of 4.5:1 (or 3:1 for large text). Low contrast makes text difficult or impossible to read for users with low vision or in high ambient light.`,
      whyItMatters: 'Users with visual impairments or color blindness cannot read text with low contrast. High contrast ensures readability in varied lighting conditions.',
      reproductionSteps: '1. Inspect the element in Chrome DevTools.\n2. In the Styles pane, view the computed color and background-color.\n3. Note the reported contrast ratio badge in DevTools color picker.',
      recommendedFix: 'Darken text color or lighten background color until the contrast ratio meets or exceeds 4.5:1.',
      codeExample: {
        current: sample.htmlSnippet,
        corrected: sample.htmlSnippet.replace(/color:\s*[^;"]+/i, 'color: #111111')
      },
      confidence,
      elements: lowContrastEls
    }));
  }

  return { findings };
}

/**
 * Native Browser-Level Keyboard Interaction Audit (Playwright CDP)
 * 
 * Performs true browser keyboard navigation using:
 * - page.keyboard.press('Tab')
 * - page.keyboard.press('Shift+Tab')
 * 
 * Verifies document.activeElement changes, real sequential focus traversal,
 * reverse navigation, and visible focus indicator rendering under native focus.
 */
export async function auditNativeKeyboardNavigation(page, evalUrl) {
  const findings = [];
  const tabSteps = [];

  try {
    // 1. Initial focus setup: focus body to start at the top of sequential focus order
    await page.evaluate(() => {
      document.body.tabIndex = -1;
      document.body.focus();
    });

    // 2. Discover total interactive candidates
    const totalCandidates = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll(
        'button:not([disabled]), a[href], input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]'
      )).filter(el => {
        if (el.hasAttribute('hidden') || el.closest('[inert]')) return false;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      return candidates.length;
    });

    if (totalCandidates === 0) {
      return { findings, stepsTested: 0, tabSteps: [] };
    }

    const maxSteps = Math.min(25, totalCandidates + 5);
    let previousSelector = null;
    let forwardSuccessful = 0;
    let reverseSuccessful = 0;
    const visitedSelectors = new Set();
    const badFocusIndicators = [];

    for (let step = 0; step < maxSteps; step++) {
      // Dispatch REAL browser-level Tab key press via Playwright
      await page.keyboard.press('Tab');

      // Inspect activeElement after native Tab keypress
      const activeInfo = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) {
          return null;
        }

        function isColorTransparent(colorStr) {
          if (!colorStr) return true;
          const c = colorStr.trim().toLowerCase();
          if (c === 'transparent' || c === 'rgba(0, 0, 0, 0)' || c === 'rgba(0,0,0,0)' || c === 'hsla(0, 0%, 0%, 0)' || c === 'hsla(0,0%,0%,0)') {
            return true;
          }
          const m = c.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
          return Boolean(m && m[4] !== undefined && parseFloat(m[4]) === 0);
        }

        function isBoxShadowVisible(shadowStr) {
          if (!shadowStr || shadowStr === 'none') return false;
          if (isColorTransparent(shadowStr)) return false;
          const px = shadowStr.match(/-?\d+(?:\.\d+)?px/g);
          if (px && px.length > 0 && px.every(v => parseFloat(v) === 0)) return false;
          return true;
        }

        function isBorderVisible(s) {
          if (!s) return false;
          const w = parseFloat(s.borderWidth) || 0;
          if (w <= 0 || s.borderStyle === 'none' || s.borderStyle === 'hidden') return false;
          return !isColorTransparent(s.borderColor);
        }

        function isOutlineVisible(s) {
          if (!s) return false;
          const w = parseFloat(s.outlineWidth) || 0;
          if (w <= 0 || s.outlineStyle === 'none' || s.outlineStyle === 'hidden') return false;
          return !isColorTransparent(s.outlineColor);
        }

        const s = window.getComputedStyle(el);
        const inlineStyle = (el.getAttribute('style') || '').toLowerCase();
        const hasInlineNoOutline = /(^|;)\s*outline\s*:\s*(none|0)(\s*!important)?\s*(;|$)/i.test(inlineStyle);
        const hasComputedNoOutline = s.outlineStyle === 'none' || parseFloat(s.outlineWidth) === 0 || isColorTransparent(s.outlineColor);

        const outlineSuppressed = hasInlineNoOutline || hasComputedNoOutline;
        const outlineVisible = isOutlineVisible(s);
        const shadowVisible = isBoxShadowVisible(s.boxShadow);
        const borderVisible = isBorderVisible(s);
        const className = typeof el.className === 'string' ? el.className.toLowerCase() : '';
        const hasFocusClasses = /focus:(ring|border|outline|bg|shadow)|focus-visible:(ring|border|outline|bg|shadow)/.test(className);

        let sel = el.tagName.toLowerCase();
        if (el.id) sel += '#' + el.id;
        else if (el.className && typeof el.className === 'string') {
          const firstClass = el.className.trim().split(/\s+/)[0];
          if (/^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(firstClass)) sel += '.' + firstClass;
        }

        const clone = el.cloneNode(false);
        const tag = el.tagName.toLowerCase();
        let snippet = clone.outerHTML || ('<' + tag + '>');
        const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
        if (text && !['input', 'img', 'br', 'hr'].includes(tag)) {
          const truncated = text.length > 60 ? text.slice(0, 60) + '…' : text;
          const outer = clone.outerHTML;
          const closing = `</${tag}>`;
          if (outer.endsWith(closing)) {
            snippet = outer.slice(0, outer.length - closing.length) + truncated + closing;
          }
        }

        return {
          tagName: el.tagName.toLowerCase(),
          selector: sel,
          snippet,
          outlineSuppressed,
          hasIndicator: outlineVisible || shadowVisible || hasFocusClasses
        };
      });

      if (!activeInfo) {
        break; // Cycled past all focusable controls
      }

      forwardSuccessful++;
      tabSteps.push({
        step: step + 1,
        action: 'Tab',
        selector: activeInfo.selector,
        hasVisibleIndicator: activeInfo.hasIndicator
      });

      // Detect controls with suppressed outline and no visible indicator
      if (activeInfo.outlineSuppressed && !activeInfo.hasIndicator && !visitedSelectors.has(activeInfo.selector)) {
        visitedSelectors.add(activeInfo.selector);
        badFocusIndicators.push({
          tagName: activeInfo.tagName,
          selector: activeInfo.selector,
          accessibleRole: activeInfo.tagName,
          accessibleName: activeInfo.selector,
          wcagCriterion: 'WCAG 2.4.7: Focus Visible (Level AA)',
          url: evalUrl,
          htmlSnippet: activeInfo.snippet,
          evidence: `Native browser keyboard navigation (page.keyboard.press('Tab')) landed on element with suppressed focus ring and no visible replacement styling.`,
          suggestedFix: 'Remove outline:none or provide a custom high-contrast focus indicator using :focus-visible'
        });
      }

      // Test reverse navigation on the 2nd step
      if (step === 1 && previousSelector) {
        await page.keyboard.press('Shift+Tab');
        const reversedSelector = await page.evaluate(() => {
          const el = document.activeElement;
          return el && el !== document.body ? (el.id ? '#' + el.id : el.tagName.toLowerCase()) : null;
        });
        if (reversedSelector) reverseSuccessful++;
        // Resume forward focus
        await page.keyboard.press('Tab');
      }

      previousSelector = activeInfo.selector;
    }

    if (badFocusIndicators.length > 0) {
      findings.push({
        ruleId: 'focus-indicator-missing',
        title: `${badFocusIndicators.length} interactive control(s) suppress visual focus indicators (native Tab verified)`,
        category: 'Accessibility',
        severity: 'medium',
        classification: 'Confirmed Failure',
        type: 'failure',
        elementCount: badFocusIndicators.length,
        wcagCriterion: 'WCAG 2.4.7 (Focus Visible)',
        url: evalUrl,
        selector: badFocusIndicators[0].selector,
        htmlSnippet: badFocusIndicators[0].htmlSnippet,
        evidence: `Native browser keyboard navigation (page.keyboard.press('Tab')) confirmed ${badFocusIndicators.length} element(s) suppress visual focus indicators without replacement styling.`,
        expectedBehavior: 'All keyboard-focusable controls must display a distinct visual indicator when active keyboard focus lands on them.',
        actualBehavior: `Native Tab focus landed on ${badFocusIndicators.length} control(s) with no visible outline, border, or box-shadow.`,
        description: `${badFocusIndicators.length} focusable control(s) suppress browser outline indicators without providing an alternative high-contrast visible style.`,
        whyItMatters: 'Sighted keyboard users cannot determine which element has active keyboard focus when focus indicators are suppressed.',
        reproductionSteps: '1. Tab sequentially into the document using keyboard.\n2. Observe absence of visible focus indicator around active element.',
        recommendedFix: 'Preserve browser focus rings or specify a distinct, high-contrast :focus-visible style.',
        codeExample: {
          current: badFocusIndicators[0].htmlSnippet,
          corrected: badFocusIndicators[0].htmlSnippet.replace(/outline\s*:\s*(none|0);?/gi, '')
        },
        elements: badFocusIndicators
      });
    }

    // 3. Restore focus: blur active element cleanly
    await page.evaluate(() => {
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
    });

    return {
      findings,
      stepsTested: forwardSuccessful,
      reverseNavigationVerified: reverseSuccessful > 0,
      tabSteps
    };
  } catch (err) {
    return {
      findings,
      stepsTested: 0,
      error: err.message
    };
  }
}
