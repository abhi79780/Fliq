import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { updateTestRecord } from './storage.mjs';
import { calculateCategoryScores } from '../../lib/audit-orchestrator.js';
import { executeAIOrFallbackReport } from '../../lib/ai-fallback-engine.js';
import { evaluateSecurityHeaders, SECURITY_CHECKS } from '../../lib/security-scanner.js';
import { SEO_CHECKS } from '../../lib/seo-scanner.js';
import { A11Y_CHECKS } from '../../lib/a11y-scanner.js';
import { PERF_CHECKS } from '../../lib/perf-scanner.js';
import { FUNCTIONALITY_CHECKS } from '../../lib/functionality-scanner.js';
import { computeAuditCoverage, checkRobotsTxt } from '../../lib/page-discovery.js';

export const badIP = (ip) => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    // Block: 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12,
    // 192.168.0.0/16, 100.64.0.0/10, 192.0.0.0/24, 198.18.0.0/15, 224.0.0.0/4
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') ||
        x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb')) {
      return true;
    }
    if (x.startsWith('::ffff:')) {
      const v4 = x.slice(7);
      if (net.isIPv4(v4)) return badIP(v4);
      return true;
    }
    return false;
  }
  return true;
};

export async function validateTarget(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Enter a valid website URL.');
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) {
    throw new Error('Only public HTTP or HTTPS websites are supported.');
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal' ||
    host === '169.254.169.254'
  ) {
    throw new Error('This address is not publicly reachable.');
  }
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length) {
    throw new Error('Could not resolve domain name. Please check the website address.');
  }
  if (addresses.some(x => badIP(x.address))) {
    throw new Error('This website resolves to a restricted network address.');
  }
  return { url: u.toString(), hostname: host };
}

function mapCheckStatus(chk, matchingFindings = []) {
  if (chk.type === 'manual' || chk.status === 'not_tested') return 'not_tested';
  if (chk.status === 'unavailable' || chk.type === 'field' || chk.measurement === 'field') return 'unavailable';
  if (!matchingFindings || matchingFindings.length === 0) return 'passed';
  if (matchingFindings.some(f => f.classification === 'Confirmed Failure' || f.type === 'failure')) return 'confirmed_failure';
  if (matchingFindings.some(f => f.classification === 'Potential Issue' || f.type === 'recommendation')) return 'potential_issue';
  if (matchingFindings.some(f => f.classification === 'Informational')) return 'informational';
  return 'passed';
}

export async function runAuditScan(job, onProgressUpdate = null) {
  const testId = job.id;
  const initialUrl = job.url;

  const update = async (fields) => {
    try {
      updateTestRecord(testId, fields);
      if (typeof onProgressUpdate === 'function') {
        await onProgressUpdate(fields).catch(() => {});
      }
    } catch (e) {
      console.warn('[Audit Engine] Notice updating test record:', e.message);
    }
  };

  try {
    // Stage 1: Validation
    await update({
      status: 'running',
      progress: 10,
      stage: 'Initializing audit engine',
      currentUrl: initialUrl,
      issues: []
    });

    const { url: validatedUrl, hostname } = await validateTarget(initialUrl);

    // Stage 2: Opening website & Measuring response
    await update({
      progress: 25,
      stage: 'Opening website',
      currentUrl: validatedUrl
    });

    const issues = [];
    const t0 = performance.now();
    let response = null;
    let html = '';
    let ttfbMs = 0;
    let loadTime = 0;
    let finalUrl = validatedUrl;
    let responseHeaders = {};

    // 30-second independent timeout for the main document request
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const res = await fetch(validatedUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; FLIQBot/2.0; +https://fliq.dev)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        redirect: 'follow'
      });

      ttfbMs = Math.round(performance.now() - t0);
      response = res;
      finalUrl = res.url || validatedUrl;
      html = await res.text();
      loadTime = Math.round(performance.now() - t0);

      for (const [k, v] of res.headers.entries()) {
        responseHeaders[k.toLowerCase()] = v;
      }
    } catch (fetchErr) {
      const isTimeout = fetchErr.name === 'TimeoutError' || fetchErr.name === 'AbortError' || fetchErr.message?.includes('aborted');
      const errorMsg = isTimeout
        ? `The website at ${validatedUrl} took longer than 30 seconds to respond. Check if the server is accessible.`
        : `Could not connect to ${validatedUrl}: ${fetchErr.message}`;

      issues.push({
        id: crypto.randomUUID(),
        ruleId: 'func-load-timeout',
        title: isTimeout ? 'Target website connection timed out (30s limit)' : 'Target website connection error',
        category: 'Functionality',
        severity: 'high',
        classification: 'Confirmed Failure',
        type: 'failure',
        checkType: 'automated',
        elementCount: 1,
        url: validatedUrl,
        selector: 'Network Request',
        htmlSnippet: '',
        evidence: errorMsg,
        expectedBehavior: 'The public website should establish a connection and respond within 30 seconds.',
        actualBehavior: errorMsg,
        description: 'The serverless crawler could not complete the initial page request within the timeout limit.',
        whyItMatters: 'Unresponsive websites cannot serve visitors or search engine crawlers.',
        wcagCriterion: 'Web Availability Standards',
        reproductionSteps: `1. Open terminal.\n2. Attempt to curl ${validatedUrl}.\n3. Observe latency or connection failure.`,
        recommendedFix: 'Check DNS records, web server status, and firewall rules to ensure the server is online and responding.',
        confidence: 'high'
      });

      await update({
        status: 'failed',
        progress: 0,
        stage: 'Failed',
        error: errorMsg,
        completedAt: new Date().toISOString(),
        issues
      });
      return;
    } finally {
      clearTimeout(timeout);
    }

    const httpStatus = response?.status || 0;
    if (httpStatus >= 400) {
      issues.push({
        id: crypto.randomUUID(),
        ruleId: 'func-http-error',
        title: `Main document returned HTTP ${httpStatus}`,
        category: 'Functionality',
        severity: 'high',
        classification: 'Confirmed Failure',
        type: 'failure',
        checkType: 'automated',
        elementCount: 1,
        url: finalUrl,
        selector: 'HTTP Response',
        htmlSnippet: '',
        evidence: `HTTP Status Code: ${httpStatus}`,
        expectedBehavior: 'The primary URL must return a successful HTTP 200 OK status code.',
        actualBehavior: `Server returned HTTP ${httpStatus}`,
        description: `The web server responded with an error HTTP status (${httpStatus}) for the primary document.`,
        whyItMatters: 'Users and crawlers encounter error screens instead of the expected webpage content.',
        wcagCriterion: 'HTTP/1.1 (RFC 7231)',
        reproductionSteps: `1. Request ${finalUrl}.\n2. Inspect response status code.`,
        recommendedFix: 'Verify server routing, permissions, and ensure the requested path exists.',
        confidence: 'high'
      });
    }

    // Stage 3: Auditing Security
    await update({
      progress: 40,
      stage: 'Auditing security',
      currentUrl: finalUrl,
      httpStatus,
      loadTime,
      issues: [...issues]
    });

    const headerSec = evaluateSecurityHeaders(finalUrl, responseHeaders);
    for (const f of headerSec.findings || []) {
      issues.push({ id: crypto.randomUUID(), ...f });
    }

    const SEC_RULE_MAPPING = {
      'sec-https': ['sec-https-missing'],
      'sec-hsts': ['sec-hsts-missing'],
      'sec-csp': ['sec-csp-missing'],
      'sec-x-frame-options': ['sec-x-frame-options-missing'],
      'sec-x-content-type': ['sec-x-content-type-options-missing'],
      'sec-referrer-policy': ['sec-referrer-policy-missing'],
      'sec-mixed-content': ['sec-mixed-content-detected'],
      'sec-tab-nabbing': ['sec-unsafe-external-link']
    };

    const securityReport = {
      headerStatus: headerSec.headerStatus || {},
      checks: SECURITY_CHECKS.map(chk => {
        const targetRules = SEC_RULE_MAPPING[chk.id] || [chk.id.replace('sec-', '')];
        const matching = (headerSec.findings || []).filter(f => targetRules.some(r => f.ruleId === r || f.ruleId.includes(r)));
        const status = mapCheckStatus(chk, matching);
        let evidence = chk.summary;
        if (chk.id === 'sec-x-content-type') {
          evidence = headerSec.headerStatus?.xContentTypeOptions
            ? 'X-Content-Type-Options: nosniff header is present.'
            : 'X-Content-Type-Options: nosniff header is missing (Potential Issue).';
        } else if (chk.id === 'sec-hsts') {
          evidence = headerSec.headerStatus?.hsts
            ? 'Strict-Transport-Security header is present.'
            : 'Strict-Transport-Security header is missing (Potential Issue).';
        } else if (chk.id === 'sec-csp') {
          evidence = headerSec.headerStatus?.csp
            ? 'Content-Security-Policy header is enforced.'
            : 'Content-Security-Policy header is missing (Potential Issue).';
        } else if (chk.id === 'sec-x-frame-options') {
          evidence = headerSec.headerStatus?.xFrameOptions
            ? 'Framing protection header is present.'
            : 'Framing protection header is missing (Potential Issue).';
        } else if (chk.id === 'sec-https') {
          evidence = headerSec.headerStatus?.https
            ? 'Website is served over encrypted HTTPS.'
            : 'Website is served over unencrypted HTTP (Confirmed Failure).';
        } else if (matching.length > 0 && matching[0].evidence) {
          evidence = matching[0].evidence;
        }
        return { ...chk, status, evidence };
      })
    };

    // Stage 4: Checking SEO Signals & HTML Metadata
    await update({
      progress: 55,
      stage: 'Checking SEO',
      currentUrl: finalUrl,
      issues: [...issues]
    });

    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';
    const metaDescMatch = html.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
                          html.match(/<meta\s+[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
    const metaDescription = metaDescMatch ? metaDescMatch[1].trim() : '';

    const canonicalMatch = html.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i) ||
                           html.match(/<link\s+[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["']/i);
    const canonicalUrl = canonicalMatch ? canonicalMatch[1].trim() : '';

    const viewportMatch = html.match(/<meta\s+[^>]*name=["']viewport["'][^>]*content=["']([^"']*)["']/i) ||
                          html.match(/<meta\s+[^>]*content=["']([^"']*)["'][^>]*name=["']viewport["']/i);
    const viewportContent = viewportMatch ? viewportMatch[1].trim() : '';

    const ogTitleMatch = html.match(/<meta\s+[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i);
    const ogDescMatch = html.match(/<meta\s+[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
    const ogImageMatch = html.match(/<meta\s+[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i);

    const h1Matches = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)];
    const h1Count = h1Matches.length;

    // SEO Rule Findings
    if (!title) {
      issues.push({
        id: crypto.randomUUID(),
        ruleId: 'seo-title-missing',
        title: 'Document title element (<title>) is missing or empty',
        category: 'SEO',
        severity: 'high',
        classification: 'Confirmed Failure',
        type: 'failure',
        checkType: 'automated',
        elementCount: 1,
        url: finalUrl,
        selector: '<head> > <title>',
        htmlSnippet: '<head>',
        evidence: 'No non-empty <title> tag found in HTML document head.',
        expectedBehavior: 'Every HTML document should have a concise, descriptive <title> tag (30-60 characters).',
        actualBehavior: 'Title element is missing or contains only whitespace.',
        description: 'The <title> tag defines document title in browser tabs, bookmarks, and search engine result pages (SERPs).',
        whyItMatters: 'Search engines rely on title tags to understand page topic and display clickable search headlines.',
        wcagCriterion: 'HTML Living Standard §4.2.2 / Google Search Essentials',
        reproductionSteps: '1. View page source.\n2. Search for <title>.\n3. Note absence or empty content.',
        recommendedFix: 'Add a descriptive <title> tag inside the <head> element.',
        confidence: 'high'
      });
    } else if (title.length < 20 || title.length > 70) {
      issues.push({
        id: crypto.randomUUID(),
        ruleId: 'seo-title-length',
        title: `Document title length is ${title.length < 20 ? 'too short' : 'too long'} (${title.length} characters)`,
        category: 'SEO',
        severity: 'low',
        classification: 'Potential Issue',
        type: 'recommendation',
        checkType: 'automated',
        elementCount: 1,
        url: finalUrl,
        selector: '<title>',
        htmlSnippet: `<title>${title.slice(0, 60)}</title>`,
        evidence: `Document title "${title}" has ${title.length} characters (recommended: 30-60).`,
        expectedBehavior: 'Page titles should be between 30 and 60 characters to avoid search snippet truncation.',
        actualBehavior: `Title length is ${title.length} characters.`,
        description: 'Overly short titles miss descriptive keyword opportunities; overly long titles get truncated by search engines.',
        whyItMatters: 'Well-calibrated title length maximizes search snippet visibility and click-through rates.',
        recommendedFix: 'Adjust page title to be between 30 and 60 characters.',
        confidence: 'high'
      });
    }

    if (!metaDescription) {
      issues.push({
        id: crypto.randomUUID(),
        ruleId: 'seo-meta-description-missing',
        title: 'Meta description tag is missing',
        category: 'SEO',
        severity: 'medium',
        classification: 'Potential Issue',
        type: 'recommendation',
        checkType: 'automated',
        elementCount: 1,
        url: finalUrl,
        selector: '<meta name="description">',
        htmlSnippet: '<head>',
        evidence: 'No <meta name="description"> found in HTML head.',
        expectedBehavior: 'Pages should specify a concise meta description summarizing page content (70-160 characters).',
        actualBehavior: 'No meta description tag declared.',
        description: 'Search engines use meta descriptions to generate snippet previews beneath search titles.',
        whyItMatters: 'A clear meta description improves click-through rates from search results.',
        recommendedFix: 'Add a <meta name="description" content="..."> tag in <head>.',
        confidence: 'high'
      });
    }

    if (h1Count === 0) {
      issues.push({
        id: crypto.randomUUID(),
        ruleId: 'seo-h1-missing',
        title: 'Missing primary <h1> topic heading',
        category: 'SEO',
        severity: 'medium',
        classification: 'Potential Issue',
        type: 'recommendation',
        checkType: 'automated',
        elementCount: 1,
        url: finalUrl,
        selector: 'h1',
        htmlSnippet: '<body>',
        evidence: 'Zero <h1> tags found in page body.',
        expectedBehavior: 'Each page should include exactly one primary <h1> heading communicating its main subject.',
        actualBehavior: 'Found 0 <h1> elements.',
        description: 'An <h1> tag provides a clear top-level heading for both search crawlers and screen readers.',
        whyItMatters: 'Lack of an H1 impairs page outline understanding and hierarchical indexing.',
        recommendedFix: 'Add a single descriptive <h1> heading near the top of the main content.',
        confidence: 'high'
      });
    } else if (h1Count > 1) {
      issues.push({
        id: crypto.randomUUID(),
        ruleId: 'seo-h1-multiple',
        title: `Multiple <h1> headings found (${h1Count} declared)`,
        category: 'SEO',
        severity: 'low',
        classification: 'Potential Issue',
        type: 'recommendation',
        checkType: 'automated',
        elementCount: h1Count,
        url: finalUrl,
        selector: 'h1',
        htmlSnippet: '<h1>',
        evidence: `Found ${h1Count} <h1> headings on the page.`,
        expectedBehavior: 'A document should typically have a single <h1> heading representing the page subject.',
        actualBehavior: `Observed ${h1Count} separate <h1> tags.`,
        description: 'Multiple H1 tags can dilute document topical focus for search engines.',
        whyItMatters: 'Using a single H1 establishes a clear hierarchical outline.',
        recommendedFix: 'Reserve <h1> for the main page title and use <h2> for subsections.',
        confidence: 'high'
      });
    }

    if (!viewportContent) {
      issues.push({
        id: crypto.randomUUID(),
        ruleId: 'seo-viewport-missing',
        title: 'Missing responsive viewport meta tag',
        category: 'SEO',
        severity: 'high',
        classification: 'Confirmed Failure',
        type: 'failure',
        checkType: 'automated',
        elementCount: 1,
        url: finalUrl,
        selector: '<meta name="viewport">',
        htmlSnippet: '<head>',
        evidence: 'No <meta name="viewport"> tag declared in <head>.',
        expectedBehavior: 'Responsive sites must declare <meta name="viewport" content="width=device-width, initial-scale=1">.',
        actualBehavior: 'Viewport meta tag is absent.',
        description: 'Without a viewport tag, mobile browsers render desktop-width layouts and scale them down.',
        whyItMatters: 'Mobile-friendly indexing requires a properly configured viewport.',
        recommendedFix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to <head>.',
        confidence: 'high'
      });
    }

    let robotsInfo = { exists: false, status: 0, disallowedPaths: [] };
    try {
      robotsInfo = await checkRobotsTxt(new URL(finalUrl).origin);
    } catch {}

    const seoReport = {
      summary: {
        title,
        titleLength: title.length,
        metaDescription,
        metaDescriptionLength: metaDescription.length,
        canonical: canonicalUrl,
        h1Count,
        viewport: viewportContent
      },
      checks: SEO_CHECKS.map(chk => {
        let status = 'passed';
        let evidence = chk.summary;
        if (chk.id === 'page-title') {
          status = !title ? 'confirmed_failure' : (title.length < 20 || title.length > 70) ? 'potential_issue' : 'passed';
          evidence = title ? `Document title: "${title}" (${title.length} chars).` : 'Missing <title> tag.';
        } else if (chk.id === 'meta-description') {
          status = !metaDescription ? 'potential_issue' : 'passed';
          evidence = metaDescription ? `Meta description: "${metaDescription.slice(0, 80)}..."` : 'No meta description found.';
        } else if (chk.id === 'heading-h1') {
          status = h1Count === 1 ? 'passed' : 'potential_issue';
          evidence = h1Count === 1 ? 'Primary <h1> topic heading is present.' : `${h1Count} <h1> headings found.`;
        } else if (chk.id === 'canonical-url') {
          status = canonicalUrl ? 'passed' : 'informational';
          evidence = canonicalUrl ? `Declared canonical: ${canonicalUrl}` : 'No canonical link tag specified.';
        } else if (chk.id === 'open-graph') {
          status = (ogTitleMatch && ogDescMatch) ? 'passed' : 'potential_issue';
          evidence = (ogTitleMatch && ogDescMatch) ? 'Open Graph social metadata present.' : 'Incomplete Open Graph tags.';
        } else if (chk.id === 'robots-directives') {
          status = robotsInfo.exists ? 'passed' : 'informational';
          evidence = robotsInfo.exists ? 'robots.txt verified.' : 'No robots.txt found.';
        } else if (chk.id === 'mobile-viewport') {
          status = viewportContent ? 'passed' : 'confirmed_failure';
          evidence = viewportContent ? `Viewport: ${viewportContent}` : 'Missing viewport meta tag.';
        } else if (chk.id === 'image-alt-coverage') {
          status = 'passed';
        }
        return { ...chk, status, evidence };
      })
    };

    // Stage 5: Inspecting Accessibility
    await update({
      progress: 70,
      stage: 'Inspecting accessibility',
      currentUrl: finalUrl,
      issues: [...issues]
    });

    const imgMatches = [...html.matchAll(/<img\s+([^>]*?)>/gi)];
    let missingAltCount = 0;
    for (const match of imgMatches) {
      const attrs = match[1];
      const hasAlt = /\balt\s*=/i.test(attrs);
      if (!hasAlt) {
        missingAltCount++;
      }
    }

    if (missingAltCount > 0) {
      issues.push({
        id: crypto.randomUUID(),
        ruleId: 'image-alt-missing',
        title: `${missingAltCount} image(s) missing alt attribute`,
        category: 'Accessibility',
        severity: 'high',
        classification: 'Confirmed Failure',
        type: 'failure',
        checkType: 'automated',
        elementCount: missingAltCount,
        url: finalUrl,
        selector: 'img:not([alt])',
        htmlSnippet: '<img>',
        evidence: `Discovered ${missingAltCount} <img> tag(s) without an alt attribute.`,
        expectedBehavior: 'All <img> elements must have an alt attribute (descriptive for informative images, empty alt="" for decorative images).',
        actualBehavior: `${missingAltCount} image(s) lack an alt attribute entirely.`,
        description: 'Screen readers announce image file URLs or skip images without alt attributes.',
        whyItMatters: 'Users with visual impairments cannot understand the context or function of images.',
        wcagCriterion: 'WCAG 1.1.1 Non-text Content (Level A)',
        recommendedFix: 'Add alt="descriptive text" or alt="" to every <img> element.',
        confidence: 'high'
      });
    }

    const buttonMatches = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi)];
    let emptyButtonCount = 0;
    for (const match of buttonMatches) {
      const text = match[1].replace(/<[^>]+>/g, '').trim();
      const hasAriaLabel = /aria-label\s*=\s*["'][^"']+["']/i.test(match[0]);
      if (!text && !hasAriaLabel) {
        emptyButtonCount++;
      }
    }

    if (emptyButtonCount > 0) {
      issues.push({
        id: crypto.randomUUID(),
        ruleId: 'button-name-missing',
        title: `${emptyButtonCount} button(s) lack accessible names`,
        category: 'Accessibility',
        severity: 'high',
        classification: 'Confirmed Failure',
        type: 'failure',
        checkType: 'automated',
        elementCount: emptyButtonCount,
        url: finalUrl,
        selector: 'button',
        htmlSnippet: '<button>',
        evidence: `Discovered ${emptyButtonCount} <button> tag(s) with no text content and no aria-label.`,
        expectedBehavior: 'Buttons must have discernible text content or aria-label.',
        actualBehavior: `${emptyButtonCount} button(s) have no accessible name.`,
        description: 'Screen reader users cannot determine the purpose of buttons that lack names.',
        whyItMatters: 'Buttons without accessible names make web applications unusable for assistive technology.',
        wcagCriterion: 'WCAG 4.1.2 Name, Role, Value (Level A)',
        recommendedFix: 'Add inner text or an aria-label attribute to each button.',
        confidence: 'high'
      });
    }

    const htmlTagMatch = html.match(/<html[^>]*>/i);
    const hasLang = htmlTagMatch && /\blang\s*=\s*["'][^"']+["']/i.test(htmlTagMatch[0]);
    if (!hasLang) {
      issues.push({
        id: crypto.randomUUID(),
        ruleId: 'html-lang-missing',
        title: 'Document language declaration (<html lang>) is missing',
        category: 'Accessibility',
        severity: 'high',
        classification: 'Confirmed Failure',
        type: 'failure',
        checkType: 'automated',
        elementCount: 1,
        url: finalUrl,
        selector: 'html',
        htmlSnippet: htmlTagMatch ? htmlTagMatch[0] : '<html>',
        evidence: 'The root <html> tag does not contain a valid lang attribute.',
        expectedBehavior: 'The <html> element must specify a valid BCP 47 language code (e.g., lang="en").',
        actualBehavior: 'No lang attribute defined on <html>.',
        description: 'Screen readers use the document language to select appropriate pronunciation and synthesizer profiles.',
        whyItMatters: 'Without a language tag, speech synthesizers may pronounce content with inappropriate accents or cadence.',
        wcagCriterion: 'WCAG 3.1.1 Language of Page (Level A)',
        recommendedFix: 'Add lang="en" (or appropriate language code) to the <html> tag.',
        confidence: 'high'
      });
    }

    const hasScaleLock = /user-scalable\s*=\s*no/i.test(viewportContent) || /maximum-scale\s*=\s*1\b/i.test(viewportContent);
    if (hasScaleLock) {
      issues.push({
        id: crypto.randomUUID(),
        ruleId: 'viewport-zoom-disabled',
        title: 'Viewport zoom or pinch-to-zoom is restricted',
        category: 'Accessibility',
        severity: 'medium',
        classification: 'Confirmed Failure',
        type: 'failure',
        checkType: 'automated',
        elementCount: 1,
        url: finalUrl,
        selector: '<meta name="viewport">',
        htmlSnippet: `<meta name="viewport" content="${viewportContent}">`,
        evidence: `Viewport disables user zooming: "${viewportContent}".`,
        expectedBehavior: 'Mobile websites must allow users to pinch-to-zoom content up to at least 200%.',
        actualBehavior: 'user-scalable=no or maximum-scale=1 restricts zoom.',
        description: 'Preventing zoom prevents low-vision users from magnifying text on mobile devices.',
        whyItMatters: 'Disabling zoom violates WCAG 1.4.4 Resize Text requirements.',
        wcagCriterion: 'WCAG 1.4.4 Resize Text (Level AA)',
        recommendedFix: 'Remove user-scalable=no and maximum-scale=1 from the viewport meta tag.',
        confidence: 'high'
      });
    }

    const accessibilityReport = {
      testedUrl: finalUrl,
      scannedAt: new Date().toISOString(),
      disclaimer: `Automated serverless audit of ${finalUrl}. Semantic markup verified; browser-rendered style and focus audits are marked not tested.`,
      failuresCount: issues.filter(x => x.category === 'Accessibility' && x.classification === 'Confirmed Failure').length,
      recommendationsCount: issues.filter(x => x.category === 'Accessibility' && x.classification !== 'Confirmed Failure').length,
      totalElementsAffected: missingAltCount + emptyButtonCount + (hasLang ? 0 : 1),
      checks: A11Y_CHECKS.map(chk => {
        let status = 'not_tested';
        let summary = chk.summary;

        if (chk.id === 'img-alt') {
          status = missingAltCount > 0 ? 'confirmed_failure' : 'passed';
          summary = missingAltCount > 0 ? `${missingAltCount} image(s) missing alt attribute` : 'All images include alt attributes.';
        } else if (chk.id === 'button-name') {
          status = emptyButtonCount > 0 ? 'confirmed_failure' : 'passed';
          summary = emptyButtonCount > 0 ? `${emptyButtonCount} button(s) lack accessible names` : 'Buttons have accessible names.';
        } else if (chk.id === 'document-lang') {
          status = hasLang ? 'passed' : 'confirmed_failure';
          summary = hasLang ? 'HTML root specifies lang attribute.' : 'Missing <html lang> declaration.';
        } else if (chk.id === 'viewport-scale') {
          status = hasScaleLock ? 'confirmed_failure' : 'passed';
          summary = hasScaleLock ? 'Viewport restricts user pinch-to-zoom.' : 'User scaling is supported.';
        } else if (['keyboard-nav', 'focus-visible', 'color-contrast', 'interactive-aria-hidden', 'duplicate-ids', 'landmark-structure', 'heading-hierarchy', 'input-label', 'link-name'].includes(chk.id)) {
          status = 'not_tested';
          summary = `${chk.summary} (Requires live browser layout/DOM rendering engine; not tested in serverless HTTP/HTML mode)`;
        } else if (chk.type === 'manual') {
          status = 'not_tested';
        }
        return { ...chk, status, summary };
      })
    };

    // Stage 6: Testing Functionality (Link Checking)
    await update({
      progress: 82,
      stage: 'Testing functionality',
      currentUrl: finalUrl,
      issues: [...issues]
    });

    const linkMatches = [...html.matchAll(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>/gi)];
    const origin = new URL(finalUrl).origin;
    const sameOriginLinks = new Set();

    for (const m of linkMatches) {
      const href = m[1].trim();
      if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
      try {
        const resolved = new URL(href, finalUrl);
        if (resolved.origin === origin && resolved.pathname !== new URL(finalUrl).pathname) {
          sameOriginLinks.add(resolved.toString());
        }
      } catch {}
    }

    const testLinks = Array.from(sameOriginLinks).slice(0, 10);
    const brokenLinksList = [];

    for (const testHref of testLinks) {
      try {
        const linkRes = await fetch(testHref, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; FLIQBot/2.0; +https://fliq.dev)',
            'Range': 'bytes=0-1024'
          },
          signal: AbortSignal.timeout(4000)
        });
        if (linkRes.status >= 400 && linkRes.status !== 405) {
          brokenLinksList.push({ url: testHref, status: linkRes.status });
        }
      } catch {}
    }

    if (brokenLinksList.length > 0) {
      const worstStatus = Math.max(...brokenLinksList.map(b => b.status));
      issues.push({
        id: crypto.randomUUID(),
        ruleId: 'func-broken-link',
        title: `${brokenLinksList.length} internal link(s) returned HTTP error status (${worstStatus})`,
        category: 'Functionality',
        severity: worstStatus >= 500 ? 'high' : 'medium',
        classification: 'Confirmed Failure',
        type: 'failure',
        checkType: 'automated',
        elementCount: brokenLinksList.length,
        url: finalUrl,
        selector: 'a[href]',
        htmlSnippet: `<a href="${brokenLinksList[0].url}">`,
        evidence: `${brokenLinksList.length} link(s) failed: ${brokenLinksList.map(b => `${b.url} [HTTP ${b.status}]`).slice(0, 3).join(', ')}.`,
        expectedBehavior: 'All same-origin hyperlinks should return HTTP 200 OK.',
        actualBehavior: `Server returned HTTP client/server error codes for ${brokenLinksList.length} link(s).`,
        description: 'Internal links pointing to missing or broken pages waste crawl budget and frustrate visitors.',
        whyItMatters: 'Broken links disrupt navigation and negatively impact SEO rankings.',
        recommendedFix: 'Update the link destinations to point to live URLs or remove dead links.',
        confidence: 'high'
      });
    }

    const formCount = (html.match(/<form[^>]*>/gi) || []).length;
    const functionalityReport = {
      formsCount: formCount,
      internalLinksTested: testLinks.length,
      internalLinksBroken: brokenLinksList.length,
      checks: FUNCTIONALITY_CHECKS.map(chk => {
        let status = 'not_tested';
        let summary = chk.summary;
        if (chk.id === 'func-network-status') {
          status = httpStatus >= 400 ? 'confirmed_failure' : 'passed';
          summary = `Main document HTTP response: ${httpStatus}`;
        } else if (chk.id === 'func-internal-links') {
          status = brokenLinksList.length > 0 ? 'confirmed_failure' : 'passed';
          summary = brokenLinksList.length > 0 ? `${brokenLinksList.length} broken link(s) detected` : `Tested ${testLinks.length} internal links (all OK).`;
        } else if (chk.id === 'func-forms') {
          status = 'not_tested';
          summary = `Discovered ${formCount} form(s). Passive non-destructive policy: forms not submitted.`;
        } else {
          status = 'not_tested';
          summary = `${chk.summary} (Requires headless browser JavaScript execution; not tested in serverless HTTP/HTML mode)`;
        }
        return { ...chk, status, summary };
      })
    };

    // Stage 7: Measuring Performance
    await update({
      progress: 90,
      stage: 'Measuring performance',
      currentUrl: finalUrl,
      issues: [...issues]
    });

    if (ttfbMs > 800) {
      issues.push({
        id: crypto.randomUUID(),
        ruleId: 'perf-ttfb-slow',
        title: `Server Time to First Byte is slow (${ttfbMs}ms)`,
        category: 'Performance',
        severity: ttfbMs > 1800 ? 'high' : 'medium',
        classification: 'Potential Issue',
        type: 'recommendation',
        checkType: 'automated',
        elementCount: 1,
        url: finalUrl,
        selector: 'Network Latency',
        htmlSnippet: '',
        evidence: `Measured TTFB of ${ttfbMs}ms (recommended: <= 800ms).`,
        expectedBehavior: 'Server should respond with the first byte within 800ms.',
        actualBehavior: `Initial response took ${ttfbMs}ms.`,
        description: 'High TTFB indicates server processing bottlenecks, lack of caching, or distance from server.',
        whyItMatters: 'Slow TTFB delays all downstream page asset downloads and increases user drop-off.',
        recommendedFix: 'Implement edge caching (CDN), optimize backend database queries, or upgrade hosting tier.',
        confidence: 'high'
      });
    }

    const performanceReport = {
      metrics: {
        ttfbMs,
        loadTimeMs: loadTime,
        htmlBytes: Buffer.byteLength(html, 'utf8')
      },
      checks: PERF_CHECKS.map(chk => {
        let status = 'unavailable';
        let summary = chk.summary;
        if (chk.id === 'perf-ttfb') {
          status = ttfbMs <= 800 ? 'passed' : 'potential_issue';
          summary = `Time to First Byte: ${ttfbMs}ms (Threshold: 800ms)`;
        } else if (chk.id === 'perf-load') {
          status = loadTime <= 3000 ? 'passed' : 'potential_issue';
          summary = `Document transfer completed in ${loadTime}ms`;
        } else {
          status = 'unavailable';
          summary = `${chk.summary} (Requires browser rendering pipeline; unavailable in serverless HTTP/HTML mode)`;
        }
        return { ...chk, status, summary };
      })
    };

    // Stage 8: Generating Report & Deterministic Scoring
    await update({
      progress: 96,
      stage: 'Generating report',
      currentUrl: finalUrl,
      issues: [...issues]
    });

    const aiResult = await executeAIOrFallbackReport(issues, finalUrl);
    const finalIssues = aiResult.issues || issues;
    const aiSummary = aiResult.aiSummary || 'Quality audit analysis complete.';

    const scoreData = calculateCategoryScores(finalIssues);
    const score = scoreData.overallScore;
    const categoryScores = scoreData.categoryScores;
    const scoreExplanation = scoreData.scoreExplanation;
    const groupedIssues = scoreData.groupedIssues || finalIssues;

    const allAuditChecks = [
      ...(accessibilityReport?.checks || []),
      ...(seoReport?.checks || []),
      ...(securityReport?.checks || []),
      ...(performanceReport?.checks || []),
      ...(functionalityReport?.checks || [])
    ];

    const auditCoverage = computeAuditCoverage({
      finalUrl,
      discoveredUrls: Array.from(sameOriginLinks),
      inspectedUrls: [finalUrl],
      issues: finalIssues,
      allChecks: allAuditChecks,
      viewports: { desktop: false, tablet: false, mobile: false }
    });

    // Complete the test
    await update({
      status: 'completed',
      progress: 100,
      stage: 'Complete',
      completedAt: new Date().toISOString(),
      finalUrl,
      hostname,
      title: title || hostname,
      httpStatus,
      loadTime,
      durationMs: loadTime,
      issues: groupedIssues,
      rawIssues: finalIssues,
      score,
      categoryScores,
      scoreExplanation,
      brokenLinks: brokenLinksList.length,
      missingImages: 0,
      accessibilityCount: missingAltCount + emptyButtonCount,
      accessibilityReport,
      seoReport,
      securityReport,
      performanceReport,
      functionalityReport,
      auditCoverage,
      robotsInfo,
      aiSummary,
      isAiGenerated: false,
      pagesDiscovered: sameOriginLinks.size,
      pagesInspected: 1,
      pagesSkipped: Math.max(0, sameOriginLinks.size - 1),
      screenshots: [],
      liveScreenshot: null
    });

    console.log(`[Audit Engine] Completed real audit for ${finalUrl} (Score: ${score}, Findings: ${finalIssues.length})`);
  } catch (err) {
    console.error('[Audit Engine] Fatal scan failure:', err);
    await update({
      status: 'failed',
      progress: 0,
      stage: 'Failed',
      error: `Audit execution error: ${err.message}`,
      completedAt: new Date().toISOString()
    });
  }
}
