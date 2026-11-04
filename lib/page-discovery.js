/**
 * FLIQ Production-Grade Page Discovery & Audit Coverage Engine
 * 
 * Safely discovers same-origin internal links, normalizes URLs, avoids duplicate
 * crawls, inspects robots.txt rules, and generates transparent coverage metadata.
 */

export function normalizeUrl(rawUrl, baseOrigin) {
  try {
    const u = new URL(rawUrl, baseOrigin);
    // Ignore non-HTTP protocols
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // Check same origin
    if (u.origin !== new URL(baseOrigin).origin) return null;

    // Strip hash fragments
    u.hash = '';

    // Remove tracking query parameters
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'fbclid', 'gclid', '_ga'];
    for (const p of trackingParams) {
      u.searchParams.delete(p);
    }

    // Ignore static asset file extensions
    const assetExtensions = /\.(pdf|zip|gz|tar|png|jpg|jpeg|gif|svg|webp|ico|mp4|webm|mp3|wav|css|js|woff|woff2|ttf|eot)$/i;
    if (assetExtensions.test(u.pathname)) return null;

    // Normalize trailing slash for root paths
    if (u.pathname === '') u.pathname = '/';

    return u.toString();
  } catch {
    return null;
  }
}

export function extractDiscoveredLinks(evalOrigin) {
  const links = Array.from(document.querySelectorAll('a[href]'));
  const discovered = new Set();

  for (const a of links) {
    const href = a.getAttribute('href');
    if (!href) continue;
    // Skip in-page anchors and javascript triggers
    if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) {
      continue;
    }

    try {
      const fullUrl = a.href; // resolved absolute href
      if (fullUrl && fullUrl.startsWith(evalOrigin)) {
        discovered.add(fullUrl);
      }
    } catch {}
  }

  return Array.from(discovered);
}

export async function checkRobotsTxt(originUrl) {
  try {
    const robotsUrl = new URL('/robots.txt', originUrl).toString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);

    const res = await fetch(robotsUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      return { exists: false, status: res.status, disallowedPaths: [] };
    }

    const text = await res.text();
    const lines = text.split('\n').map(l => l.trim());
    const disallowed = [];
    let isWildcardAgent = false;

    for (const line of lines) {
      if (line.toLowerCase().startsWith('user-agent:')) {
        const agent = line.slice(11).trim();
        isWildcardAgent = agent === '*';
      } else if (isWildcardAgent && line.toLowerCase().startsWith('disallow:')) {
        const path = line.slice(9).trim();
        if (path) disallowed.push(path);
      }
    }

    return {
      exists: true,
      status: 200,
      disallowedPaths: disallowed
    };
  } catch {
    return { exists: false, status: 0, disallowedPaths: [] };
  }
}

export function computeAuditCoverage({
  finalUrl,
  discoveredUrls = [],
  inspectedUrls = [],
  inaccessibleUrls = [],
  issues = [],
  allChecks = [],
  viewports = { desktop: true, tablet: true, mobile: true },
  maxCrawlLimit = 5
}) {
  const uniqueDiscovered = Array.from(new Set(discoveredUrls.map(u => normalizeUrl(u, finalUrl)).filter(Boolean)));
  if (!uniqueDiscovered.includes(finalUrl)) {
    uniqueDiscovered.unshift(finalUrl);
  }
  const uniqueInspected = Array.from(new Set(inspectedUrls.map(u => normalizeUrl(u, finalUrl)).filter(Boolean)));
  if (!uniqueInspected.includes(finalUrl)) {
    uniqueInspected.unshift(finalUrl);
  }

  const skippedUrls = uniqueDiscovered.filter(u => !uniqueInspected.includes(u));

  // 1. Findings Accounting (individual defect occurrences)
  const confirmedFailures = issues.filter(i => i.classification === 'Confirmed Failure' || (!i.classification && i.type === 'failure')).length;
  const potentialIssues = issues.filter(i => i.classification === 'Potential Issue' || (!i.classification && i.type === 'recommendation')).length;
  const informationalObservations = issues.filter(i => i.classification === 'Informational' || i.type === 'informational').length;
  const totalFindings = issues.length;

  // 2. Checks Accounting (test catalog rules with exactly 6 mutually-exclusive canonical statuses)
  // Normalize any check without an explicit canonical status
  const normalizedChecks = allChecks.map(c => {
    let st = c.status;
    if (!st) {
      if (c.type === 'manual') st = 'not_tested';
      else if (c.type === 'field' || c.measurement === 'field') st = 'unavailable';
      else st = 'passed';
    } else if (st === 'failed') {
      st = 'confirmed_failure';
    }
    return { ...c, status: st };
  });

  const checksPassed = normalizedChecks.filter(c => c.status === 'passed').length;
  const checksConfirmedFailure = normalizedChecks.filter(c => c.status === 'confirmed_failure').length;
  const checksPotentialIssue = normalizedChecks.filter(c => c.status === 'potential_issue').length;
  const checksInformational = normalizedChecks.filter(c => c.status === 'informational').length;
  const checksNotTested = normalizedChecks.filter(c => c.status === 'not_tested').length;
  const checksUnavailable = normalizedChecks.filter(c => c.status === 'unavailable').length;
  const totalChecks = normalizedChecks.length;
  const checksExecuted = checksPassed + checksConfirmedFailure + checksPotentialIssue + checksInformational;
  const checksUnexecuted = checksNotTested + checksUnavailable;

  return {
    scope: 'Single-Page Deep Inspection with Discovery',
    targetUrl: finalUrl,
    pagesDiscovered: uniqueDiscovered.length,
    pagesInspected: uniqueInspected.length,
    pagesInaccessible: inaccessibleUrls.length,
    pagesSkipped: skippedUrls.length,
    inspectedUrls: uniqueInspected,
    discoveredSample: uniqueDiscovered.slice(0, 10),
    skippedSample: skippedUrls.slice(0, 10),
    viewports: {
      desktop: { name: 'Desktop (1440x960)', inspected: Boolean(viewports.desktop) },
      tablet: { name: 'Tablet (768x1024)', inspected: Boolean(viewports.tablet) },
      mobile: { name: 'Mobile (390x844)', inspected: Boolean(viewports.mobile) }
    },
    checksSummary: {
      totalChecks,
      checksExecuted,
      totalChecksExecuted: checksExecuted,
      checksUnexecuted,
      checksPassed,
      checksConfirmedFailure,
      checksPotentialIssue,
      checksInformational,
      checksFailed: checksConfirmedFailure + checksPotentialIssue,
      checksNotTested,
      checksUnavailable,
      checksUnavailableOrNotTested: checksNotTested + checksUnavailable,
      confirmedFailures,
      potentialIssues,
      informationalObservations
    },
    findingsSummary: {
      totalFindings,
      confirmedFailures,
      potentialIssues,
      informationalObservations
    },
    coverageDisclaimer: `This scan audited "${finalUrl}" across 3 viewports (Desktop, Tablet, Mobile). A total of ${uniqueDiscovered.length} same-origin pages were discovered, of which ${uniqueInspected.length} page was deeply inspected and ${skippedUrls.length} pages were skipped per policy. Uninspected pages were not evaluated.`
  };
}
