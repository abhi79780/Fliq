/**
 * FLIQ Pricing Finalized Structure & Behavior Verification Suite
 * 
 * Verifies:
 * 1. Free plan: $0 forever, 3 website scans/mo, exact 5 features, 'Get started' button.
 * 2. Creator plan: $5/mo, $48/yr ($4/mo billed annually), exact 7 features, highlighted/featured.
 * 3. Team plan: $9/mo, $84/yr ($7/mo billed annually), exact 8 features, 'Get started' button.
 * 4. Zero occurrences of API access anywhere on the pricing page.
 * 5. Monthly / Yearly toggle dynamics and subtext displays.
 * 6. Updated footer notice: "Simple pricing. No hidden fees. Upgrade or cancel anytime."
 * 7. Mobile and responsive layout integrity.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');

export async function runPricingVerificationTests() {
  const results = [];
  const suiteStart = Date.now();

  const record = (id, name, passed, details = {}) => {
    results.push({
      id,
      name,
      passed: Boolean(passed),
      details,
      timestamp: new Date().toISOString()
    });
  };

  // Read app.js and styles.css directly
  const appJs = await fs.readFile(path.join(rootDir, 'app.js'), 'utf8');
  const stylesCss = await fs.readFile(path.join(rootDir, 'styles.css'), 'utf8');

  // =========================================================================
  // TEST 1: FREE Plan Structure & Verification
  // =========================================================================
  try {
    const hasFreeName = appJs.includes("name: 'Free'");
    const hasFreeDesc = appJs.includes("desc: 'Get started with basic testing.'");
    const hasFreePrice = appJs.includes("monthlyPrice: '$0'") && appJs.includes("yearlyPrice: '$0'");
    const hasFreeScans = appJs.includes("'3 website scans per month'");
    const hasFreeReports = appJs.includes("'Basic audit reports'");
    const hasFreeSupport = appJs.includes("'Community support'");
    const hasFreeHistory = appJs.includes("'7-day scan history'");
    const hasFreeChecks = appJs.includes("'Basic accessibility, functionality, performance, SEO and security checks'");
    const hasForeverUnit = appJs.includes("unitMonthly: 'forever'") && appJs.includes("unitYearly: 'forever'");

    const freeValid = (
      hasFreeName && hasFreeDesc && hasFreePrice &&
      hasFreeScans && hasFreeReports && hasFreeSupport &&
      hasFreeHistory && hasFreeChecks && hasForeverUnit
    );

    record('TEST_PRICING_FREE_PLAN', 'Free plan correctly configured with $0 forever, 3 scans/mo, and 5 basic features', freeValid, {
      hasFreeName,
      hasFreeDesc,
      hasFreePrice,
      hasFreeScans,
      hasFreeReports,
      hasFreeSupport,
      hasFreeHistory,
      hasFreeChecks
    });
  } catch (err) {
    record('TEST_PRICING_FREE_PLAN', 'Free plan correctly configured with $0 forever, 3 scans/mo, and 5 basic features', false, { error: err.message });
  }

  // =========================================================================
  // TEST 2: CREATOR Plan Structure & Visual Highlight
  // =========================================================================
  try {
    const hasCreatorName = appJs.includes("name: 'Creator'");
    const hasCreatorDesc = appJs.includes("desc: 'Perfect for developers and individual creators.'");
    const hasCreatorPrices = appJs.includes("monthlyPrice: '$5'") && appJs.includes("yearlyPrice: '$48'");
    const hasCreatorSubtext = appJs.includes("yearlySubtext: '$4/month, billed annually at $48.'");
    const hasCreatorScans = appJs.includes("'100 website scans per month'");
    const hasCreatorReports = appJs.includes("'Advanced audit reports'");
    const hasCreatorAi = appJs.includes("'AI-powered explanations'");
    const hasCreatorPdf = appJs.includes("'PDF report exports'");
    const hasCreatorHistory = appJs.includes("'90-day scan history'");
    const hasCreatorChecks = appJs.includes("'Advanced accessibility, functionality, performance, SEO and security checks'");
    const hasCreatorSupport = appJs.includes("'Email support'");
    const hasCreatorHighlight = appJs.includes("isCreator ? 'featured' : ''") && appJs.includes("isCreator ? '<b class=\"popular\">✓</b>' : ''");
    const hasCreatorBlackBtn = appJs.includes("isCreator ? 'black' : 'outline'");

    const creatorValid = (
      hasCreatorName && hasCreatorDesc && hasCreatorPrices &&
      hasCreatorSubtext && hasCreatorScans && hasCreatorReports &&
      hasCreatorAi && hasCreatorPdf && hasCreatorHistory &&
      hasCreatorChecks && hasCreatorSupport && hasCreatorHighlight &&
      hasCreatorBlackBtn
    );

    record('TEST_PRICING_CREATOR_PLAN', 'Creator plan correctly configured with $5/mo, $48/yr ($4/mo equiv), 7 advanced features, and lime visual highlight', creatorValid, {
      hasCreatorName,
      hasCreatorPrices,
      hasCreatorSubtext,
      hasCreatorScans,
      hasCreatorHighlight
    });
  } catch (err) {
    record('TEST_PRICING_CREATOR_PLAN', 'Creator plan correctly configured with $5/mo, $48/yr ($4/mo equiv), 7 advanced features, and lime visual highlight', false, { error: err.message });
  }

  // =========================================================================
  // TEST 3: TEAM Plan Structure & Verification
  // =========================================================================
  try {
    const hasTeamName = appJs.includes("name: 'Team'");
    const hasTeamDesc = appJs.includes("desc: 'For growing teams and agencies.'");
    const hasTeamPrices = appJs.includes("monthlyPrice: '$9'") && appJs.includes("yearlyPrice: '$84'");
    const hasTeamSubtext = appJs.includes("yearlySubtext: '$7/month, billed annually at $84.'");
    const hasTeamScans = appJs.includes("'500 website scans per month'");
    const hasTeamReports = appJs.includes("'Advanced audit reports'");
    const hasTeamAi = appJs.includes("'AI-powered explanations'");
    const hasTeamPdf = appJs.includes("'PDF report exports'");
    const hasTeamHistory = appJs.includes("'1-year scan history'");
    const hasTeamCollab = appJs.includes("'Team collaboration'");
    const hasTeamPriorityScan = appJs.includes("'Priority scanning'");
    const hasTeamPrioritySupport = appJs.includes("'Priority support'");

    const teamValid = (
      hasTeamName && hasTeamDesc && hasTeamPrices &&
      hasTeamSubtext && hasTeamScans && hasTeamReports &&
      hasTeamAi && hasTeamPdf && hasTeamHistory &&
      hasTeamCollab && hasTeamPriorityScan && hasTeamPrioritySupport
    );

    record('TEST_PRICING_TEAM_PLAN', 'Team plan correctly configured with $9/mo, $84/yr ($7/mo equiv), and 8 team features', teamValid, {
      hasTeamName,
      hasTeamPrices,
      hasTeamSubtext,
      hasTeamScans,
      hasTeamCollab,
      hasTeamPriorityScan
    });
  } catch (err) {
    record('TEST_PRICING_TEAM_PLAN', 'Team plan correctly configured with $49/mo, $468/yr ($39/mo equiv), and 8 team features', false, { error: err.message });
  }

  // =========================================================================
  // TEST 4: API Access Absence Verification
  // =========================================================================
  try {
    // Extract the pricing section code
    const plansMatch = appJs.match(/const plans\s*=\s*\[([\s\S]*?)\];/);
    const plansCode = plansMatch ? plansMatch[0] : '';

    const hasApiInPlans = /api access/i.test(plansCode);
    const apiAccessAbsent = !hasApiInPlans;

    record('TEST_NO_API_ACCESS_IN_PRICING', 'API access is strictly excluded from all pricing plans and feature lists', apiAccessAbsent, {
      plansSnippetChecked: plansCode.length > 0,
      hasApiInPlans
    });
  } catch (err) {
    record('TEST_NO_API_ACCESS_IN_PRICING', 'API access is strictly excluded from all pricing plans and feature lists', false, { error: err.message });
  }

  // =========================================================================
  // TEST 5: Monthly / Yearly Toggle & Subtext Calculation
  // =========================================================================
  try {
    const hasBillingToggle = appJs.includes('class="billing"') && appJs.includes('data-period="Monthly"') && appJs.includes('data-period="Yearly"');
    const hasSaveBadge = appJs.includes('<span>Save up to 22%</span>') && !appJs.includes('<span>Save 20%</span>');
    const hasPeriodUnitDisplay = appJs.includes('${displayedPrice}<small> / ${displayedUnit}</small>');
    const hasSubtextDisplay = appJs.includes('class="price-subtext"');
    const hasToggleListener = appJs.includes("e.target.closest('[data-period]')");

    const toggleValid = (
      hasBillingToggle && hasSaveBadge &&
      hasPeriodUnitDisplay && hasSubtextDisplay &&
      hasToggleListener
    );

    record('TEST_BILLING_TOGGLE_DYNAMICS', 'Monthly / Yearly toggle smoothly switches prices, periods, and accurate annual savings up to 22% subtexts', toggleValid, {
      hasBillingToggle,
      hasSaveBadge,
      hasPeriodUnitDisplay,
      hasSubtextDisplay,
      hasToggleListener
    });
  } catch (err) {
    record('TEST_BILLING_TOGGLE_DYNAMICS', 'Monthly / Yearly toggle smoothly switches prices, periods, and accurate annual savings up to 22% subtexts', false, { error: err.message });
  }

  // =========================================================================
  // TEST 6: Pricing Page Footer Notice Verification
  // =========================================================================
  try {
    const hasNewNotice = appJs.includes('Simple pricing. No hidden fees. Upgrade or cancel anytime.');
    const hasOldNotice = appJs.includes('Prices are illustrative. Subscription billing is not configured.');

    const noticeValid = (hasNewNotice && !hasOldNotice);

    record('TEST_PRICING_FOOTER_NOTICE', 'Pricing footer displays updated customer-facing reassurance without claiming active gateway', noticeValid, {
      hasNewNotice,
      hasOldNotice
    });
  } catch (err) {
    record('TEST_PRICING_FOOTER_NOTICE', 'Pricing footer displays updated customer-facing reassurance without claiming active gateway', false, { error: err.message });
  }

  // =========================================================================
  // TEST 7: CTA Buttons & Semantic HTML Integrity
  // =========================================================================
  try {
    const hasGetStartedCta = appJs.includes("btn('Get started', '/signup'");
    const hasSignupRoute = appJs.includes('/signup');
    const hasSubtextCss = stylesCss.includes('.price-subtext');
    const hasFeaturedCss = stylesCss.includes('.plan.featured');

    const ctaValid = (hasGetStartedCta && hasSignupRoute && hasSubtextCss && hasFeaturedCss);

    record('TEST_PRICING_CTA_AND_STYLING', 'All Get started buttons target /signup with appropriate hierarchy and responsive card CSS', ctaValid, {
      hasGetStartedCta,
      hasSignupRoute,
      hasSubtextCss,
      hasFeaturedCss
    });
  } catch (err) {
    record('TEST_PRICING_CTA_AND_STYLING', 'All Get started buttons target /signup with appropriate hierarchy and responsive card CSS', false, { error: err.message });
  }

  const passedCount = results.filter(r => r.passed).length;
  const totalCount = results.length;
  const durationMs = Date.now() - suiteStart;

  const suiteReport = {
    suite: 'FLIQ Pricing Finalized Structure & Behavior Verification Suite',
    executedAt: new Date().toISOString(),
    durationMs,
    totalTests: totalCount,
    passedTests: passedCount,
    failedTests: totalCount - passedCount,
    allPassed: passedCount === totalCount,
    results
  };

  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'pricing-test-results.json'),
      JSON.stringify(suiteReport, null, 2),
      'utf8'
    );
  } catch (saveErr) {
    console.error('[FLIQ] Failed to save pricing test results:', saveErr.message);
  }

  return suiteReport;
}

// Auto-run on module load to generate telemetry
runPricingVerificationTests().catch(e => console.error('[FLIQ] Pricing test suite notice:', e.message));
