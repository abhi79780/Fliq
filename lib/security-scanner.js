/**
 * FLIQ Production-Grade Passive Security Scanner
 * 
 * Safely inspects transport layer security, HTTP response security headers,
 * mixed-content risks, and tab-nabbing vulnerabilities without invasive testing.
 */

export const SECURITY_CHECKS = [
  { id: 'sec-https', name: 'Transport Layer Security (HTTPS)', type: 'automated', standard: 'RFC 2818 / PCI-DSS 4.0', summary: 'Website enforces encrypted HTTPS transport' },
  { id: 'sec-hsts', name: 'HTTP Strict Transport Security (HSTS)', type: 'automated', standard: 'RFC 6797', summary: 'Strict-Transport-Security header prevents protocol downgrade' },
  { id: 'sec-csp', name: 'Content Security Policy (CSP)', type: 'automated', standard: 'W3C CSP Level 3', summary: 'Restricts script, frame, and asset injection vectors' },
  { id: 'sec-x-frame-options', name: 'Clickjacking protection (X-Frame-Options)', type: 'automated', standard: 'RFC 7034', summary: 'Prevents iframe framing and clickjacking attacks' },
  { id: 'sec-x-content-type', name: 'MIME-sniffing protection (X-Content-Type-Options)', type: 'automated', standard: 'Fetch Living Standard', summary: 'Enforces nosniff to prevent script execution from non-script MIME types' },
  { id: 'sec-referrer-policy', name: 'Referrer information protection', type: 'automated', standard: 'W3C Referrer Policy', summary: 'Restricts sensitive path leakage via Referer header' },
  { id: 'sec-mixed-content', name: 'Mixed content subresource security', type: 'automated', standard: 'W3C Mixed Content', summary: 'HTTPS pages do not load unencrypted HTTP subresources' },
  { id: 'sec-tab-nabbing', name: 'Reverse tab-nabbing protection', type: 'automated', standard: 'HTML Living Standard', summary: 'External links with target="_blank" specify rel="noopener noreferrer"' }
];

export function evaluateSecurityHeaders(arg1, arg2 = {}) {
  let url = '';
  let headers = {};
  if (typeof arg1 === 'string') {
    url = arg1;
    headers = arg2 || {};
  } else if (typeof arg2 === 'string') {
    url = arg2;
    headers = arg1 || {};
  } else {
    url = 'https://localhost';
    headers = arg1 || {};
  }

  const findings = [];
  let isHttps = true;
  let parsedUrl = null;
  try {
    parsedUrl = new URL(url);
    isHttps = parsedUrl.protocol === 'https:';
  } catch {
    isHttps = url.startsWith('https:');
  }

  function createFinding({
    ruleId,
    title,
    severity,
    classification = 'Confirmed Failure',
    type,
    selector = 'HTTP Response Headers',
    htmlSnippet = '',
    actualBehavior,
    expectedBehavior,
    description,
    whyItMatters,
    standard,
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
      category: 'Security',
      severity,
      classification: canonicalClassification,
      type: canonicalType,
      checkType: 'automated',
      elementCount: 1,
      url,
      selector,
      htmlSnippet,
      evidence: actualBehavior,
      expectedBehavior,
      actualBehavior,
      description,
      whyItMatters,
      wcagCriterion: standard || 'Web Security Architecture Best Practices',
      reproductionSteps,
      recommendedFix,
      codeExample,
      confidence
    };
  }

  // 1. HTTPS Protocol (Confirmed Failure)
  if (!isHttps) {
    findings.push(createFinding({
      ruleId: 'sec-https-missing',
      title: 'Website is served over unencrypted HTTP protocol',
      severity: 'high',
      classification: 'Confirmed Failure',
      actualBehavior: `The website URL protocol is "${parsedUrl ? parsedUrl.protocol : 'http:'}". Data is transmitted in plaintext.`,
      expectedBehavior: 'All production websites must enforce HTTPS encryption using TLS 1.2 or 1.3.',
      description: 'The website was requested over plaintext HTTP. Any intermediary network device can eavesdrop on or manipulate page content and user data.',
      whyItMatters: 'Plaintext HTTP exposes user sessions, logins, and form submissions to interception and man-in-the-middle (MITM) attacks.',
      standard: 'RFC 2818 (HTTP Over TLS)',
      reproductionSteps: '1. Check the URL protocol in the browser address bar.\n2. Note absence of lock icon and "Not secure" indicator.',
      recommendedFix: 'Obtain a TLS certificate (e.g. Let\'s Encrypt) and redirect all HTTP traffic to HTTPS via 301 Permanent Redirect.',
      codeExample: {
        current: `http://${parsedUrl ? parsedUrl.hostname : 'example.com'}/`,
        corrected: `https://${parsedUrl ? parsedUrl.hostname : 'example.com'}/`
      }
    }));
  }

  // Normalize header keys to lowercase and safely extract string values
  const h = {};
  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (Array.isArray(v)) {
        h[k.toLowerCase()] = v.join(', ');
      } else {
        h[k.toLowerCase()] = String(v ?? '');
      }
    }
  }

  // 2. Strict-Transport-Security (HSTS) - Defense-in-depth hardening recommendation
  if (isHttps && !h['strict-transport-security']) {
    findings.push(createFinding({
      ruleId: 'sec-hsts-missing',
      title: 'Missing HTTP Strict Transport Security (HSTS) hardening header',
      severity: 'low',
      classification: 'Potential Issue',
      actualBehavior: 'The Strict-Transport-Security header was not returned by the server.',
      expectedBehavior: 'HTTPS websites should return "Strict-Transport-Security: max-age=31536000; includeSubDomains".',
      description: 'HSTS is a defense-in-depth hardening header that instructs browsers to always connect via HTTPS, protecting against SSL-stripping on untrusted networks.',
      whyItMatters: 'While HTTPS transport is active, HSTS prevents future protocol downgrade attacks on subsequent visits before redirects occur.',
      standard: 'RFC 6797 (HSTS)',
      reproductionSteps: '1. In DevTools -> Network, inspect the initial document response headers.\n2. Note absence of Strict-Transport-Security.',
      recommendedFix: 'Configure your web server or reverse proxy to include Strict-Transport-Security with a max-age of at least 1 year (31536000 seconds).',
      codeExample: {
        current: '# Headers missing Strict-Transport-Security',
        corrected: 'Strict-Transport-Security: max-age=31536000; includeSubDomains; preload'
      }
    }));
  }

  // 3. Content-Security-Policy (CSP) - Hardening policy recommendation
  // Note: Content-Security-Policy-Report-Only does NOT enforce protection.
  const enforcedCsp = (h['content-security-policy'] || '').trim();
  const reportOnlyCsp = (h['content-security-policy-report-only'] || '').trim();
  const hasEnforcedCsp = Boolean(enforcedCsp);
  const hasReportOnlyCsp = Boolean(reportOnlyCsp);

  if (!hasEnforcedCsp) {
    findings.push(createFinding({
      ruleId: 'sec-csp-missing',
      title: hasReportOnlyCsp
        ? 'Content-Security-Policy is set to Report-Only (not enforced)'
        : 'Missing Content-Security-Policy (CSP) response header',
      severity: 'low',
      classification: 'Potential Issue',
      actualBehavior: hasReportOnlyCsp
        ? 'A Content-Security-Policy-Report-Only header was found, but no enforced Content-Security-Policy exists. Browsers log violations without blocking unauthorized content.'
        : 'No Content-Security-Policy header returned in HTTP response.',
      expectedBehavior: 'Web applications should declare an enforced Content-Security-Policy restricting authorized sources for scripts, styles, and frames.',
      description: 'A Content Security Policy is a defense-in-depth mechanism restricting script and asset execution origins, mitigating potential cross-site scripting (XSS) risks.',
      whyItMatters: 'Without an enforced CSP, an application that suffers an injection defect has no browser-level secondary guardrails against unauthorized script execution. Report-Only policies monitor without protecting users.',
      standard: 'W3C Content Security Policy Level 3',
      reproductionSteps: '1. Inspect document response headers in DevTools.\n2. Observe absence of enforced Content-Security-Policy.',
      recommendedFix: 'Deploy an enforced Content-Security-Policy header tailored to your application resources (e.g. script-src \'self\').',
      codeExample: {
        current: hasReportOnlyCsp ? `Content-Security-Policy-Report-Only: ${reportOnlyCsp}` : '# Headers missing Content-Security-Policy',
        corrected: "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:;"
      }
    }));
  }

  // 4. X-Frame-Options & Enforced CSP frame-ancestors (Clickjacking defense)
  // Check if enforced CSP defines frame-ancestors
  const frameAncestorsMatch = enforcedCsp.match(/frame-ancestors\s+([^;]+)/i);
  let hasEnforcedFrameAncestors = false;
  if (frameAncestorsMatch) {
    const directiveValue = frameAncestorsMatch[1].trim();
    // Directive must not be wild-card '*' (which explicitly permits framing anywhere)
    hasEnforcedFrameAncestors = directiveValue !== '*' && directiveValue.length > 0;
  }

  const rawXfo = (h['x-frame-options'] || '').trim().toLowerCase();
  // Valid X-Frame-Options are DENY or SAMEORIGIN (comma-separated duplicate values handled)
  const xfoValues = rawXfo.split(',').map(s => s.trim());
  const hasValidXfo = xfoValues.some(val => val === 'deny' || val === 'sameorigin');

  if (!hasEnforcedFrameAncestors && !hasValidXfo) {
    const isReportOnlyAncestors = /frame-ancestors/i.test(reportOnlyCsp);
    findings.push(createFinding({
      ruleId: 'sec-x-frame-options-missing',
      title: isReportOnlyAncestors
        ? 'Framing protection (frame-ancestors) is only present in Report-Only CSP'
        : 'Missing framing protection header (enforced CSP frame-ancestors or X-Frame-Options)',
      severity: 'low',
      classification: 'Potential Issue',
      actualBehavior: isReportOnlyAncestors
        ? 'The frame-ancestors directive is defined in Content-Security-Policy-Report-Only, which does not block embedding in external iframes.'
        : rawXfo
          ? `The X-Frame-Options value "${rawXfo}" is invalid or obsolete (expected DENY or SAMEORIGIN).`
          : 'Neither an enforced CSP frame-ancestors directive nor a valid X-Frame-Options header was detected.',
      expectedBehavior: 'Websites must specify enforced CSP frame-ancestors (\'none\' or \'self\') or X-Frame-Options (DENY or SAMEORIGIN) to prevent clickjacking embedding.',
      description: 'Framing restrictions instruct browsers whether a page can be rendered inside an <iframe>, mitigating clickjacking risks on authenticated interfaces.',
      whyItMatters: 'If this page contains sensitive actions or user authentication, third-party sites could frame it in a transparent clickjacking overlay.',
      standard: 'W3C CSP Level 3 / RFC 7034 (X-Frame-Options)',
      reproductionSteps: '1. Test embedding the website into an external <iframe>.\n2. The browser allows framing without blocking.',
      recommendedFix: 'Add "frame-ancestors \'self\'" to your enforced Content-Security-Policy header or send "X-Frame-Options: SAMEORIGIN".',
      codeExample: {
        current: rawXfo ? `X-Frame-Options: ${rawXfo}` : isReportOnlyAncestors ? `Content-Security-Policy-Report-Only: ${reportOnlyCsp}` : '# Framing protection missing',
        corrected: "Content-Security-Policy: default-src 'self'; frame-ancestors 'self';"
      }
    }));
  }

  // 5. X-Content-Type-Options
  const rawXcto = (h['x-content-type-options'] || '').toLowerCase();
  const hasNosniff = rawXcto.includes('nosniff');
  if (!hasNosniff) {
    findings.push(createFinding({
      ruleId: 'sec-x-content-type-options-missing',
      title: 'Missing or misconfigured X-Content-Type-Options: nosniff header',
      severity: 'low',
      classification: 'Potential Issue',
      actualBehavior: `Header value is "${h['x-content-type-options'] || 'absent'}".`,
      expectedBehavior: 'HTTP responses should include "X-Content-Type-Options: nosniff".',
      description: 'X-Content-Type-Options prevents browsers from MIME-sniffing responses away from the declared Content-Type, mitigating attacks where non-executable files are treated as scripts.',
      whyItMatters: 'MIME confusion attacks can cause browsers to execute user-uploaded images or text files as executable JavaScript.',
      standard: 'Fetch Living Standard',
      reproductionSteps: '1. Inspect HTTP response headers.\n2. Confirm X-Content-Type-Options: nosniff is missing.',
      recommendedFix: 'Configure your web server to return X-Content-Type-Options: nosniff on all responses.',
      codeExample: {
        current: '# Headers missing X-Content-Type-Options',
        corrected: 'X-Content-Type-Options: nosniff'
      }
    }));
  }

  // 6. Referrer-Policy
  if (!h['referrer-policy']) {
    findings.push(createFinding({
      ruleId: 'sec-referrer-policy-missing',
      title: 'Referrer-Policy header is not explicitly declared',
      severity: 'low',
      classification: 'Informational',
      actualBehavior: 'No Referrer-Policy header found in HTTP response.',
      expectedBehavior: 'Web applications should declare "Referrer-Policy: strict-origin-when-cross-origin" or "no-referrer".',
      description: 'The Referrer-Policy header governs how much referrer information (URL paths and parameters) is sent when navigating to external origins.',
      whyItMatters: 'URL query parameters containing sensitive tokens or IDs can be inadvertently leaked to external analytics or linked websites.',
      standard: 'W3C Referrer Policy',
      reproductionSteps: '1. Inspect document response headers for Referrer-Policy.',
      recommendedFix: 'Add Referrer-Policy: strict-origin-when-cross-origin to response headers.',
      codeExample: {
        current: '# Headers missing Referrer-Policy',
        corrected: 'Referrer-Policy: strict-origin-when-cross-origin'
      }
    }));
  }

  const headerStatus = {
    https: isHttps,
    hsts: Boolean(h['strict-transport-security']),
    csp: hasEnforcedCsp,
    cspReportOnly: hasReportOnlyCsp,
    xFrameOptions: Boolean(hasEnforcedFrameAncestors || hasValidXfo),
    xContentTypeOptions: hasNosniff,
    referrerPolicy: Boolean(h['referrer-policy'])
  };

  return { findings, headerStatus };
}

/**
 * In-browser security checks (Mixed content & unsafe external links)
 */
export function evaluateDOMSecurity(evalUrl) {
  const findings = [];
  const u = new URL(evalUrl);
  const isHttps = u.protocol === 'https:';

  // 1. Mixed Content (HTTP subresources on HTTPS page)
  if (isHttps) {
    const mixedElements = Array.from(document.querySelectorAll(
      'script[src^="http:"], link[rel="stylesheet"][href^="http:"], img[src^="http:"], iframe[src^="http:"]'
    ));

    if (mixedElements.length > 0) {
      const sample = mixedElements[0].outerHTML || '<script src="http://...">';
      findings.push({
        ruleId: 'sec-mixed-content-detected',
        title: `${mixedElements.length} insecure mixed-content resource(s) loaded over HTTP`,
        category: 'Security',
        severity: 'high',
        classification: 'Confirmed Failure',
        type: 'failure',
        checkType: 'automated',
        elementCount: mixedElements.length,
        url: evalUrl,
        selector: mixedElements[0].tagName.toLowerCase(),
        htmlSnippet: sample,
        evidence: `Page is served over HTTPS but loads ${mixedElements.length} subresource(s) over plaintext HTTP: ${mixedElements[0].src || mixedElements[0].href}.`,
        expectedBehavior: 'HTTPS pages must only load encrypted HTTPS subresources to maintain security integrity.',
        actualBehavior: `Observed insecure HTTP subresource URLs: ${mixedElements.map(e => e.src || e.href).slice(0, 3).join(', ')}.`,
        description: 'Mixed content occurs when an initial HTML document is loaded over a secure HTTPS connection, but other subresources (such as images, scripts, or stylesheets) are loaded over plaintext HTTP.',
        whyItMatters: 'Browsers block mixed content or allow MITM attackers to tamper with the unencrypted subresources, compromising page security.',
        wcagCriterion: 'W3C Mixed Content Specification',
        reproductionSteps: '1. Open browser console on HTTPS page.\n2. Observe mixed content warnings / blocked resource errors.',
        recommendedFix: 'Update all asset URLs to use HTTPS or protocol-relative paths.',
        codeExample: {
          current: sample,
          corrected: sample.replace(/http:\/\//gi, 'https://')
        },
        confidence: 'high'
      });
    }
  }

  // 2. Unsafe External Links (Reverse Tab-nabbing: target="_blank" without rel="noopener noreferrer")
  const externalLinks = Array.from(document.querySelectorAll('a[href^="http"][target="_blank"]')).filter(a => {
    try {
      const targetHost = new URL(a.href).hostname;
      return targetHost !== u.hostname;
    } catch {
      return false;
    }
  });

  const unsafeLinks = externalLinks.filter(a => {
    const rel = (a.getAttribute('rel') || '').toLowerCase();
    const hasNoopener = rel.includes('noopener');
    const hasNoreferrer = rel.includes('noreferrer');
    return !hasNoopener && !hasNoreferrer;
  });

  if (unsafeLinks.length > 0) {
    const sample = unsafeLinks[0].outerHTML || '<a href="..." target="_blank">';
    findings.push({
      ruleId: 'sec-unsafe-external-link',
      title: `${unsafeLinks.length} external link(s) with target="_blank" lack rel="noopener noreferrer"`,
      category: 'Security',
      severity: 'low',
      classification: 'Potential Issue',
      type: 'recommendation',
      checkType: 'automated',
      elementCount: unsafeLinks.length,
      url: evalUrl,
      selector: 'a[target="_blank"]',
      htmlSnippet: sample,
      evidence: `Found ${unsafeLinks.length} external link(s) opening in new tabs without rel="noopener" or rel="noreferrer".`,
      expectedBehavior: 'External links opening in new browser tabs must include rel="noopener noreferrer" to prevent window.opener access.',
      actualBehavior: `The rel attribute is "${unsafeLinks[0].getAttribute('rel') || '(none)'}".`,
      description: 'When an external link opens in a new tab via target="_blank" without rel="noopener", the target page gains window.opener access and could theoretically navigate the original tab to a phishing clone.',
      whyItMatters: 'Reverse tab-nabbing allows hostile destination sites to silently redirect the referring tab to a malicious login page.',
      wcagCriterion: 'HTML Living Standard §4.5.1',
      reproductionSteps: '1. Inspect external <a> links with target="_blank".\n2. Note absence of rel="noopener noreferrer".',
      recommendedFix: 'Add rel="noopener noreferrer" to all external links that use target="_blank".',
      codeExample: {
        current: sample,
        corrected: sample.replace(/target="_blank"/i, 'target="_blank" rel="noopener noreferrer"')
      },
      confidence: 'medium'
    });
  }

  return { findings };
}
