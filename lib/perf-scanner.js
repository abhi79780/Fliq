/**
 * FLIQ Production-Grade Performance Scanner
 * 
 * Accurately extracts real in-browser Core Web Vitals (FCP, LCP, CLS)
 * and W3C Navigation Timing API metrics (TTFB, DOMContentLoaded, Load Duration, Transfer Weight).
 * 
 * Strict Accuracy Standards:
 * - Does NOT conflate Navigation Timing with Core Web Vitals.
 * - Explicitly documents whether each metric is Lab-measured or Field-measured.
 * - Reports INP as a field-only metric (unavailable in synthetic lab page loads).
 * - Distinguishes unavailable metrics from passing metrics (never assigns artificial passes).
 */

export const PERF_CHECKS = [
  { id: 'perf-fcp', name: 'First Contentful Paint (FCP)', type: 'automated', measurement: 'lab', standard: 'Core Web Vitals (Lab Measured)', summary: 'Time until first DOM text or graphic content renders (Good: <= 1.8s)' },
  { id: 'perf-lcp', name: 'Largest Contentful Paint (LCP)', type: 'automated', measurement: 'lab', standard: 'Core Web Vitals (Lab Measured)', summary: 'Render time of largest above-the-fold content block (Good: <= 2.5s)' },
  { id: 'perf-cls', name: 'Cumulative Layout Shift (CLS)', type: 'automated', measurement: 'lab', standard: 'Core Web Vitals (Lab Measured)', summary: 'Measures visual stability and unexpected layout movement (Good: <= 0.1)' },
  { id: 'perf-inp', name: 'Interaction to Next Paint (INP)', type: 'field', measurement: 'field', standard: 'Core Web Vitals (Field Metric)', summary: 'Measures interaction responsiveness via real user input (CrUX). Not measurable in synthetic lab page-load scans.' },
  { id: 'perf-ttfb', name: 'Time to First Byte (TTFB)', type: 'automated', measurement: 'lab', standard: 'W3C Navigation Timing API (Lab Measured)', summary: 'Server latency before receiving first response byte (Good: <= 800ms)' },
  { id: 'perf-load', name: 'Complete page load duration', type: 'automated', measurement: 'lab', standard: 'W3C Navigation Timing API (Lab Measured)', summary: 'Time required to load full document and deferred assets' },
  { id: 'perf-weight', name: 'Total page resource transfer weight', type: 'automated', measurement: 'lab', standard: 'W3C Resource Timing API (Lab Measured)', summary: 'Total compressed network bytes transferred across assets' },
  { id: 'perf-slow-assets', name: 'Slow or heavy asset bottlenecks', type: 'automated', measurement: 'lab', standard: 'W3C Resource Timing API (Lab Measured)', summary: 'Detects individual assets exceeding transfer size or duration thresholds' }
];

export function extractPerformanceMetrics(evalUrl) {
  const findings = [];

  function createFinding({
    ruleId,
    title,
    severity,
    classification = 'Potential Issue',
    type,
    selector = 'window.performance',
    htmlSnippet = '',
    evidence,
    expectedBehavior,
    actualBehavior,
    description,
    whyItMatters,
    wcagCriterion,
    reproductionSteps,
    recommendedFix,
    codeExample,
    confidence = 'high',
    elementCount = 1
  }) {
    const canonicalClassification = classification;
    const canonicalType = type || (canonicalClassification === 'Confirmed Failure' ? 'failure' : canonicalClassification === 'Informational' ? 'informational' : 'recommendation');
    return {
      ruleId,
      title,
      category: 'Performance',
      severity,
      classification: canonicalClassification,
      type: canonicalType,
      checkType: 'automated',
      elementCount,
      url: evalUrl,
      selector,
      htmlSnippet,
      evidence,
      expectedBehavior,
      actualBehavior,
      description,
      whyItMatters,
      wcagCriterion,
      reproductionSteps,
      recommendedFix,
      codeExample,
      confidence
    };
  }

  // 1. Navigation Timing API
  const navEntries = window.performance?.getEntriesByType?.('navigation') || [];
  const nav = navEntries[0] || {};
  const paintEntries = window.performance?.getEntriesByType?.('paint') || [];

  // First Contentful Paint (FCP)
  const fcpEntry = paintEntries.find(p => p.name === 'first-contentful-paint');
  const fcpMs = fcpEntry ? Math.round(fcpEntry.startTime) : null;

  // Largest Contentful Paint (LCP)
  let lcpMs = null;
  let lcpElementSelector = '';
  try {
    const lcpEntries = window.performance?.getEntriesByType?.('largest-contentful-paint') || [];
    if (lcpEntries.length > 0) {
      const lastLcp = lcpEntries[lcpEntries.length - 1];
      lcpMs = Math.round(lastLcp.renderTime || lastLcp.loadTime || lastLcp.startTime);
      if (lastLcp.element) {
        const el = lastLcp.element;
        lcpElementSelector = el.tagName ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : '')) : '';
      }
    }
  } catch {}

  // Cumulative Layout Shift (CLS)
  let clsValue = null;
  try {
    const observerEntries = [];
    const observer = new PerformanceObserver((list) => {
      observerEntries.push(...list.getEntries());
    });
    observer.observe({ type: 'layout-shift', buffered: true });
    observer.disconnect();

    let sum = 0;
    for (const entry of observerEntries) {
      if (!entry.hadRecentInput) {
        sum += entry.value;
      }
    }
    clsValue = Math.round(sum * 1000) / 1000;
  } catch {
    // If PerformanceObserver buffered layout-shift is unsupported, fallback
    clsValue = null;
  }

  // W3C Navigation Timing metrics
  const domContentLoadedMs = nav.domContentLoadedEventEnd && nav.startTime
    ? Math.round(nav.domContentLoadedEventEnd - nav.startTime)
    : null;

  const loadDurationMs = nav.loadEventEnd && nav.startTime
    ? Math.round(nav.loadEventEnd - nav.startTime)
    : Math.round(performance.now());

  const ttfbMs = nav.responseStart && nav.requestStart
    ? Math.round(nav.responseStart - nav.requestStart)
    : null;

  // 2. Resource Timing API
  const resources = window.performance?.getEntriesByType?.('resource') || [];
  let totalBytes = 0;
  const slowResources = [];
  const heavyResources = [];
  const byType = { script: 0, css: 0, img: 0, font: 0, other: 0 };

  for (const r of resources) {
    const size = r.transferSize || r.encodedBodySize || 0;
    totalBytes += size;
    const duration = r.duration || 0;

    const init = r.initiatorType || 'other';
    if (init === 'script') byType.script += size;
    else if (init === 'css' || init === 'link') byType.css += size;
    else if (init === 'img' || init === 'image') byType.img += size;
    else if (init === 'font') byType.font += size;
    else byType.other += size;

    if (size > 1500000) { // > 1.5MB
      heavyResources.push({
        url: r.name,
        sizeMb: (size / (1024 * 1024)).toFixed(2)
      });
    }

    if (duration > 3500) { // > 3.5s
      slowResources.push({
        url: r.name,
        durationS: (duration / 1000).toFixed(2)
      });
    }
  }

  // --- Core Web Vitals Evaluations ---

  // FCP Check
  if (fcpMs !== null && fcpMs > 3000) {
    findings.push(createFinding({
      ruleId: 'perf-fcp-slow',
      title: `First Contentful Paint is slow (${(fcpMs / 1000).toFixed(2)}s, expected <= 1.8s)`,
      severity: fcpMs > 4000 ? 'high' : 'medium',
      classification: 'Potential Issue',
      type: 'recommendation',
      selector: 'window.performance',
      htmlSnippet: '',
      evidence: `Lab-measured First Contentful Paint (FCP) was ${fcpMs}ms (Core Web Vitals target: <= 1800ms).`,
      expectedBehavior: 'First Contentful Paint should occur within 1.8 seconds on standard broadband.',
      actualBehavior: `The browser took ${(fcpMs / 1000).toFixed(2)}s before the first text or graphic content rendered.`,
      description: 'First Contentful Paint marks the time at which the first text or image is painted. A slow FCP creates the perception that the website is unresponsive.',
      whyItMatters: 'Users begin abandoning websites when content takes more than 2-3 seconds to render.',
      wcagCriterion: 'Core Web Vitals: First Contentful Paint (FCP)',
      reproductionSteps: '1. Open Chrome DevTools -> Performance panel.\n2. Reload page with network throttling.\n3. Measure First Contentful Paint marker.',
      recommendedFix: 'Eliminate render-blocking stylesheets and scripts in <head>, leverage HTTP caching, and optimize server response time (TTFB).',
      codeExample: {
        current: '<script src="/bundle.js"></script>',
        corrected: '<script src="/bundle.js" defer></script>'
      },
      confidence: 'high'
    }));
  }

  // LCP Check
  if (lcpMs !== null && lcpMs > 2500) {
    findings.push(createFinding({
      ruleId: 'perf-lcp-slow',
      title: `Largest Contentful Paint is slow (${(lcpMs / 1000).toFixed(2)}s, target <= 2.5s)`,
      severity: lcpMs > 4000 ? 'high' : 'medium',
      classification: 'Potential Issue',
      type: 'recommendation',
      selector: lcpElementSelector || 'body',
      htmlSnippet: lcpElementSelector ? `<${lcpElementSelector}>` : '',
      evidence: `Lab-measured Largest Contentful Paint (LCP) was ${lcpMs}ms${lcpElementSelector ? ` (identified element: ${lcpElementSelector})` : ''} (Target: <= 2500ms).`,
      expectedBehavior: 'The largest content element within the viewport should render within 2.5 seconds of page load.',
      actualBehavior: `Largest content element took ${(lcpMs / 1000).toFixed(2)}s to complete rendering.`,
      description: 'Largest Contentful Paint measures when the primary content of a page has likely loaded. A slow LCP means users perceive the site as loading sluggishly.',
      whyItMatters: 'LCP is a key Google search ranking signal and user satisfaction metric.',
      wcagCriterion: 'Core Web Vitals: Largest Contentful Paint (LCP)',
      reproductionSteps: '1. In DevTools -> Performance, record page load.\n2. Locate the "LCP" marker on the Timings track.\n3. Inspect the associated element in the summary pane.',
      recommendedFix: 'Preload hero images using <link rel="preload" as="image">, optimize server response time, and avoid heavy JavaScript hydration before hero rendering.',
      codeExample: {
        current: '<!-- Hero image discovered late in DOM -->\n<img src="/hero.jpg">',
        corrected: '<head>\n  <link rel="preload" as="image" href="/hero.webp" fetchpriority="high">\n</head>'
      },
      confidence: 'high'
    }));
  }

  // CLS Check
  if (clsValue !== null && clsValue > 0.1) {
    findings.push(createFinding({
      ruleId: 'perf-cls-high',
      title: `Cumulative Layout Shift (${clsValue}) exceeds recommended threshold (<= 0.1)`,
      severity: clsValue > 0.25 ? 'high' : 'medium',
      classification: 'Potential Issue',
      type: 'recommendation',
      selector: 'document',
      htmlSnippet: '',
      evidence: `Lab-measured Cumulative Layout Shift (CLS) score was ${clsValue} (Core Web Vitals target: <= 0.1).`,
      expectedBehavior: 'Pages should maintain visual stability during loading, with a CLS score of 0.1 or less.',
      actualBehavior: `Cumulative layout score reached ${clsValue}, indicating elements moved position unexpectedly after initial render.`,
      description: 'Layout shifts occur when visible elements change their start position from one rendered frame to the next without user interaction.',
      whyItMatters: 'Unexpected layout shifts cause accidental clicks on wrong links or buttons and cause reading disorientation.',
      wcagCriterion: 'Core Web Vitals: Cumulative Layout Shift (CLS)',
      reproductionSteps: '1. In DevTools -> Performance, record page load.\n2. Inspect the "Layout Shifts" track for red flags showing shifting bounding boxes.',
      recommendedFix: 'Always include width and height attributes on <img> and <video> elements, reserve space for dynamic ads/banners with CSS aspect-ratio, and avoid inserting content above existing content.',
      codeExample: {
        current: '<img src="/banner.jpg">',
        corrected: '<img src="/banner.jpg" width="800" height="400" style="aspect-ratio: 2/1">'
      },
      confidence: 'high'
    }));
  }

  // TTFB Check (Navigation Timing)
  if (ttfbMs !== null && ttfbMs > 1200) {
    findings.push(createFinding({
      ruleId: 'perf-ttfb-slow',
      title: `Server Time to First Byte (TTFB) is slow (${ttfbMs}ms, expected <= 800ms)`,
      severity: ttfbMs > 2000 ? 'high' : 'medium',
      classification: 'Potential Issue',
      type: 'recommendation',
      selector: 'HTTP Connection',
      htmlSnippet: '',
      evidence: `Navigation Timing responseStart - requestStart was ${ttfbMs}ms (Expected: <= 800ms).`,
      expectedBehavior: 'Initial document HTML should begin streaming to the client within 800ms.',
      actualBehavior: `Server took ${ttfbMs}ms to begin returning response bytes.`,
      description: 'Time to First Byte measures the latency between when the browser requests a page and when the first byte of data arrives from the server.',
      whyItMatters: 'A slow TTFB delays all downstream rendering, asset fetching, and paint milestones.',
      wcagCriterion: 'W3C Navigation Timing API (TTFB Metric)',
      reproductionSteps: '1. In DevTools -> Network panel, select the initial HTML document request.\n2. In the "Timing" tab, check the "Waiting for server response (TTFB)" duration.',
      recommendedFix: 'Enable edge caching (CDN), optimize backend database queries, and use HTTP/2 or HTTP/3.',
      codeExample: {
        current: '# Slow un-cached origin response',
        corrected: 'Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400'
      },
      confidence: 'high'
    }));
  }

  // Heavy Resources check - Correlated with actual rendering milestones
  if (heavyResources.length > 0) {
    const hasDemonstratedSlowdown = (fcpMs !== null && fcpMs > 2500) || (lcpMs !== null && lcpMs > 2500) || (loadDurationMs > 4000);
    const classification = hasDemonstratedSlowdown ? 'Potential Issue' : 'Informational';
    const severity = hasDemonstratedSlowdown ? 'medium' : 'low';

    findings.push(createFinding({
      ruleId: 'perf-heavy-assets',
      title: hasDemonstratedSlowdown
        ? `${heavyResources.length} oversized resource(s) (> 1.5 MB) correlate with slow rendering`
        : `${heavyResources.length} large resource(s) (> 1.5 MB) identified (optimization opportunity)`,
      severity,
      classification,
      type: classification === 'Potential Issue' ? 'recommendation' : 'informational',
      elementCount: heavyResources.length,
      selector: 'Resource Timing',
      htmlSnippet: heavyResources[0].url,
      evidence: hasDemonstratedSlowdown
        ? `Observed ${heavyResources.length} asset(s) exceeding 1.5 MB (Sample: ${heavyResources[0].sizeMb} MB) correlating with high render times (LCP: ${lcpMs || '—'}ms, Load: ${loadDurationMs}ms).`
        : `Observed ${heavyResources.length} asset(s) exceeding 1.5 MB (Sample: ${heavyResources[0].sizeMb} MB). However, browser paint metrics remained fast (LCP: ${lcpMs || '—'}ms, FCP: ${fcpMs || '—'}ms). Classified as optimization recommendation without user-experience penalty.`,
      expectedBehavior: 'Individual assets should be compressed or downscaled to remain under 1.5 MB.',
      actualBehavior: hasDemonstratedSlowdown
        ? `${heavyResources.length} large asset(s) contributed to slow page loading.`
        : `${heavyResources.length} asset(s) exceed 1.5 MB but page rendered within standard targets.`,
      description: 'Large image, video, or JavaScript bundle files consume network bandwidth. When page render is fast, compression remains an optimization opportunity.',
      whyItMatters: hasDemonstratedSlowdown
        ? 'Heavy downloads degrade mobile browsing performance and increase bounce rates.'
        : 'Compressing large assets saves server bandwidth and improves performance for data-constrained users.',
      wcagCriterion: 'W3C Resource Timing API Best Practices',
      reproductionSteps: '1. In DevTools -> Network panel, sort requests by "Size".\n2. Inspect the largest transferred resources.',
      recommendedFix: 'Compress images using modern formats (WebP/AVIF), enable Gzip/Brotli on the server, and split large JavaScript bundles.',
      codeExample: {
        current: `<img src="large-image.png"> # ${heavyResources[0].sizeMb} MB`,
        corrected: `<img src="optimized.webp" loading="lazy"> # < 250 KB`
      },
      confidence: 'high'
    }));
  }

  const metrics = {
    measured: true,
    measurementSource: 'W3C Navigation Timing API & PerformanceObserver (Chromium Lab)',
    measuredAt: new Date().toISOString(),
    fcpMs,
    fcpFormatted: fcpMs !== null ? `${(fcpMs / 1000).toFixed(2)}s` : 'Unavailable',
    fcpRating: fcpMs === null ? 'unavailable' : fcpMs <= 1800 ? 'good' : fcpMs <= 3000 ? 'needs-improvement' : 'poor',
    lcpMs,
    lcpFormatted: lcpMs !== null ? `${(lcpMs / 1000).toFixed(2)}s` : 'Unavailable',
    lcpRating: lcpMs === null ? 'unavailable' : lcpMs <= 2500 ? 'good' : lcpMs <= 4000 ? 'needs-improvement' : 'poor',
    lcpElement: lcpElementSelector || null,
    clsValue,
    clsFormatted: clsValue !== null ? String(clsValue) : 'Unavailable',
    clsRating: clsValue === null ? 'unavailable' : clsValue <= 0.1 ? 'good' : clsValue <= 0.25 ? 'needs-improvement' : 'poor',
    inpStatus: 'Unavailable (Field Metric requiring user interaction)',
    domContentLoadedMs,
    domContentLoadedFormatted: domContentLoadedMs !== null ? `${(domContentLoadedMs / 1000).toFixed(2)}s` : '—',
    loadDurationMs,
    loadDurationFormatted: `${(loadDurationMs / 1000).toFixed(2)}s`,
    ttfbMs,
    ttfbFormatted: ttfbMs !== null ? `${ttfbMs}ms` : '—',
    resourceCount: resources.length,
    totalTransferBytes: totalBytes,
    totalTransferFormatted: `${(totalBytes / 1024).toFixed(1)} KB`,
    byType: {
      scriptsKb: Math.round(byType.script / 1024),
      cssKb: Math.round(byType.css / 1024),
      imagesKb: Math.round(byType.img / 1024),
      fontsKb: Math.round(byType.font / 1024),
      otherKb: Math.round(byType.other / 1024)
    }
  };

  return { findings, metrics };
}
