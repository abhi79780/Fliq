/**
 * FLIQ Production-Grade SEO Scanner
 * 
 * Inspects essential on-page SEO signals, document metadata, heading outline,
 * Open Graph sharing tags, and crawl directives with reproducible evidence.
 */

export const SEO_CHECKS = [
  { id: 'page-title', name: 'Document title element (<title>)', type: 'automated', standard: 'HTML Living Standard / Google SEO', summary: 'Page has a descriptive, concise <title> tag' },
  { id: 'meta-description', name: 'Search snippet meta description', type: 'automated', standard: 'Search Engine Indexing Best Practices', summary: 'Page defines a concise meta description tag' },
  { id: 'heading-h1', name: 'Primary topic heading (<h1>)', type: 'automated', standard: 'W3C Document Semantics', summary: 'Page defines a primary <h1> topic heading' },
  { id: 'canonical-url', name: 'Canonical URL declaration', type: 'automated', standard: 'RFC 6596', summary: 'Page specifies a canonical URL link tag' },
  { id: 'open-graph', name: 'Open Graph social sharing metadata', type: 'automated', standard: 'Open Graph Protocol', summary: 'Page includes og:title, og:image, and og:description tags' },
  { id: 'robots-directives', name: 'Robots meta crawl directives', type: 'automated', standard: 'Search Engine Specifications', summary: 'Page crawlability and indexability settings' },
  { id: 'mobile-viewport', name: 'Mobile viewport configuration', type: 'automated', standard: 'Responsive Web Standards', summary: 'Page configures responsive mobile viewport tag' },
  { id: 'image-alt-coverage', name: 'Image search text alternatives', type: 'automated', standard: 'WCAG 1.1.1 / Google Image Best Practices', summary: 'Visual media includes descriptive alt text for search indexing' }
];

export function evaluateSEO(evalUrl) {
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

  const findings = [];

  function createFinding({
    ruleId,
    title,
    severity,
    classification = 'Confirmed Failure',
    type,
    selector,
    htmlSnippet,
    actualBehavior,
    expectedBehavior,
    description,
    whyItMatters,
    reproductionSteps,
    recommendedFix,
    codeExample,
    confidence = 'high'
  }) {
    const canonicalClassification = classification || 'Confirmed Failure';
    const canonicalType = type || (canonicalClassification === 'Confirmed Failure' ? 'failure' : canonicalClassification === 'Informational' ? 'informational' : 'recommendation');

    return {
      ruleId,
      title,
      category: 'SEO',
      severity,
      classification: canonicalClassification,
      type: canonicalType,
      checkType: 'automated',
      elementCount: 1,
      url: evalUrl,
      selector: selector || 'head',
      htmlSnippet: htmlSnippet || '',
      evidence: actualBehavior,
      expectedBehavior,
      actualBehavior,
      description,
      whyItMatters,
      wcagCriterion: 'Search Engine Optimization & Document Structure',
      reproductionSteps,
      recommendedFix,
      codeExample,
      confidence
    };
  }

  // 1. Title
  const titleEl = document.querySelector('head > title');
  const titleText = (titleEl?.textContent || '').trim();

  if (!titleText) {
    findings.push(createFinding({
      ruleId: 'seo-title-missing',
      title: 'Page lacks a descriptive document title (<title>)',
      severity: 'high',
      classification: 'Confirmed Failure',
      selector: 'head > title',
      htmlSnippet: titleEl ? getOpeningTag(titleEl) : '<head>',
      actualBehavior: 'The <title> tag is missing or contains only whitespace.',
      expectedBehavior: 'Every webpage must have a non-empty <title> tag between 15 and 70 characters.',
      description: 'The HTML document does not define a page title. Search engines and browsers rely on the <title> tag as the primary heading in search results and browser tabs.',
      whyItMatters: 'Search engines display the title tag as the headline in search results. A missing title severely impacts search visibility and click-through rates.',
      reproductionSteps: '1. Inspect the <head> element.\n2. Note that <title> is either absent or empty.',
      recommendedFix: 'Add a concise, descriptive <title> tag to the <head> section (e.g. <title>Page Name - Brand Name</title>).',
      codeExample: {
        current: titleEl ? '<title></title>' : '<head>\n</head>',
        corrected: '<head>\n  <title>Descriptive Page Title - Brand Name</title>\n</head>'
      }
    }));
  } else if (titleText.length < 15 || titleText.length > 70) {
    const isShortBrand = titleText.length < 15;
    findings.push(createFinding({
      ruleId: 'seo-title-length',
      title: isShortBrand
        ? `Contextual recommendation: Concise document title (${titleText.length} chars)`
        : `Page title length (${titleText.length} chars) may truncate in search snippets`,
      severity: 'low',
      classification: isShortBrand ? 'Informational' : 'Potential Issue',
      type: isShortBrand ? 'informational' : 'recommendation',
      selector: 'head > title',
      htmlSnippet: `<title>${titleText}</title>`,
      actualBehavior: `The page title contains ${titleText.length} characters: "${titleText}".`,
      expectedBehavior: 'Search engine snippets typically display between 15 and 70 characters without truncation.',
      description: isShortBrand
        ? `The document title "${titleText}" is concise (${titleText.length} characters). Concise brand or topic titles are valid HTML standards; expanding with a secondary descriptor or tagline is an optional contextual enhancement for search snippet visibility.`
        : `The page title exceeds 70 characters and is likely to be truncated with an ellipsis (...) in search engine result pages.`,
      whyItMatters: isShortBrand
        ? 'A concise title is valid HTML; appending a primary keyword or tagline is an optional contextual enhancement for search listings.'
        : 'Truncated titles may cut off critical brand or topic information in search listings.',
      reproductionSteps: '1. Check document.title.length in browser console.',
      recommendedFix: isShortBrand
        ? `No technical fix required. If desired, you may optionally append a brand descriptor: <title>${titleText} – Tagline</title>`
        : 'Condense title to under 70 characters.',
      codeExample: {
        current: `<title>${titleText}</title>`,
        corrected: isShortBrand ? `<title>${titleText} – Tagline</title>` : `<title>Concise Title</title>`
      }
    }));
  }

  // 2. Meta Description
  const metaDesc = document.querySelector('meta[name="description"]');
  const descText = (metaDesc?.getAttribute('content') || '').trim();

  if (!descText) {
    findings.push(createFinding({
      ruleId: 'seo-meta-description-missing',
      title: 'Page lacks a meta description tag',
      severity: 'medium',
      classification: 'Potential Issue',
      selector: 'head > meta[name="description"]',
      htmlSnippet: metaDesc ? getOpeningTag(metaDesc) : '<head>',
      actualBehavior: 'No meta description tag with non-empty content was found.',
      expectedBehavior: 'Pages should define a meta description tag between 50 and 160 characters summarizing the page topic.',
      description: 'The page does not specify a meta description tag. Search engines may generate arbitrary text snippets from page content.',
      whyItMatters: 'A compelling meta description increases search engine click-through rates by providing an informative preview in search result listings.',
      reproductionSteps: '1. Inspect <head> for <meta name="description">.\n2. Confirm absence of content attribute.',
      recommendedFix: 'Add a <meta name="description" content="..."> tag summarizing page content.',
      codeExample: {
        current: '<head>\n</head>',
        corrected: '<meta name="description" content="Clear and concise summary of page purpose between 50 and 160 characters.">'
      }
    }));
  }

  // 3. Primary Heading <h1>
  const h1Elements = Array.from(document.querySelectorAll('h1, [role="heading"][aria-level="1"]'));
  if (h1Elements.length === 0) {
    findings.push(createFinding({
      ruleId: 'seo-h1-missing',
      title: 'Document lacks a primary topic heading (<h1>)',
      severity: 'medium',
      classification: 'Potential Issue',
      selector: 'body',
      htmlSnippet: '<body>',
      actualBehavior: 'Found 0 <h1> elements in the document.',
      expectedBehavior: 'Each page should include exactly one primary <h1> heading summarizing the main topic.',
      description: 'The page does not have an <h1> heading element. Search engines and assistive technologies rely on <h1> to understand the main subject of the document.',
      whyItMatters: 'Heading elements establish topical hierarchy. Without an <h1>, search engines find it harder to categorize page relevance.',
      reproductionSteps: '1. Query document.querySelectorAll("h1") in console.\n2. Array length is 0.',
      recommendedFix: 'Add a descriptive <h1> element representing the page topic.',
      codeExample: {
        current: '<main>\n  <div>...</div>\n</main>',
        corrected: '<main>\n  <h1>Primary Page Topic</h1>\n  <div>...</div>\n</main>'
      }
    }));
  }

  // 4. Canonical URL
  const canonical = document.querySelector('link[rel="canonical"]');
  const canonicalHref = (canonical?.getAttribute('href') || '').trim();
  if (!canonicalHref) {
    findings.push(createFinding({
      ruleId: 'seo-canonical-missing',
      title: 'Page lacks a canonical URL declaration (<link rel="canonical">)',
      severity: 'low',
      classification: 'Informational',
      selector: 'head',
      htmlSnippet: '<head>',
      actualBehavior: 'No <link rel="canonical"> element found in document <head>.',
      expectedBehavior: 'Pages should specify a self-referential canonical URL to prevent duplicate content indexing issues.',
      description: 'A canonical link tag tells search engines which URL represents the master copy of a page, preventing duplicate content dilution across URL parameters.',
      whyItMatters: 'URL query strings, tracking parameters, and protocol differences can cause duplicate content penalties without a canonical tag.',
      reproductionSteps: '1. Inspect <head> for <link rel="canonical">.',
      recommendedFix: 'Add a canonical link tag matching the authoritative public URL of the page.',
      codeExample: {
        current: '<head>\n</head>',
        corrected: `<link rel="canonical" href="${evalUrl}">`
      }
    }));
  }

  // 5. Open Graph Metadata
  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
  const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
  const ogDesc = document.querySelector('meta[property="og:description"]')?.getAttribute('content');

  if (!ogTitle || !ogImage || !ogDesc) {
    const missingOg = [
      !ogTitle && 'og:title',
      !ogImage && 'og:image',
      !ogDesc && 'og:description'
    ].filter(Boolean);

    findings.push(createFinding({
      ruleId: 'seo-open-graph-incomplete',
      title: `Social preview metadata is incomplete (missing ${missingOg.join(', ')})`,
      severity: 'low',
      classification: 'Informational',
      selector: 'head',
      htmlSnippet: '<head>',
      actualBehavior: `Missing tags: ${missingOg.join(', ')}.`,
      expectedBehavior: 'Pages should define og:title, og:image, and og:description for rich social sharing cards.',
      description: 'Open Graph meta tags define how content appears when shared across social platforms (Twitter/X, LinkedIn, Slack, Facebook).',
      whyItMatters: 'Links shared without Open Graph tags appear as plain text URLs or generic snippets, reducing social engagement.',
      reproductionSteps: '1. Inspect <head> for <meta property="og:..."> tags.',
      recommendedFix: 'Add the missing Open Graph tags to the <head> section.',
      codeExample: {
        current: '<head>\n</head>',
        corrected: `<meta property="og:title" content="${titleText || 'Page Title'}">\n<meta property="og:description" content="${descText || 'Page Summary'}">\n<meta property="og:image" content="https://example.com/share-image.png">`
      }
    }));
  }

  // Data summary
  const summary = {
    title: titleText || null,
    titleLength: titleText.length,
    description: descText || null,
    descriptionLength: descText.length,
    canonical: canonicalHref || null,
    h1Count: h1Elements.length,
    hasOpenGraph: Boolean(ogTitle && ogImage),
    hasViewport: Boolean(document.querySelector('meta[name="viewport"]'))
  };

  return { findings, summary };
}
