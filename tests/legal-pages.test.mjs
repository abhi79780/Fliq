import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const appJsPath = path.resolve('app.js');
const stylesCssPath = path.resolve('styles.css');
const appJsContent = fs.readFileSync(appJsPath, 'utf8');
const stylesCssContent = fs.readFileSync(stylesCssPath, 'utf8');

describe('FLIQ Legal Policies, Support & Footer Verification Suite', () => {

  test('Official support email supportfliq.ai@gmail.com is configured across key files', () => {
    const expectedEmail = 'supportfliq.ai@gmail.com';
    const mailtoLink = 'mailto:supportfliq.ai@gmail.com';

    assert.ok(appJsContent.includes(expectedEmail), 'app.js must contain supportfliq.ai@gmail.com');
    assert.ok(appJsContent.includes(mailtoLink), 'app.js must contain mailto:supportfliq.ai@gmail.com links');
  });

  describe('Footer Structure & Links', () => {
    test('Footer includes structured PRODUCT, COMPANY, and LEGAL groups', () => {
      assert.ok(appJsContent.includes('site-footer'), 'Footer must use site-footer class');
      assert.ok(appJsContent.includes('PRODUCT'), 'Footer must contain PRODUCT group');
      assert.ok(appJsContent.includes('COMPANY'), 'Footer must contain COMPANY group');
      assert.ok(appJsContent.includes('LEGAL'), 'Footer must contain LEGAL group');
    });

    test('Footer contains all required navigation links', () => {
      // PRODUCT links
      assert.ok(appJsContent.includes('href="/features#automated-testing"'), 'Footer must link to automated testing');
      assert.ok(appJsContent.includes('href="/features#ai-analysis"'), 'Footer must link to AI analysis');
      assert.ok(appJsContent.includes('href="/features#test-reports"'), 'Footer must link to test reports');
      assert.ok(appJsContent.includes('href="/pricing"'), 'Footer must link to pricing');
      assert.ok(appJsContent.includes('href="/docs"'), 'Footer must link to documentation');

      // COMPANY links
      assert.ok(appJsContent.includes('href="/about"'), 'Footer must link to about page');
      assert.ok(appJsContent.includes('href="/contact"'), 'Footer must link to contact page');
      assert.ok(appJsContent.includes('href="/blog"'), 'Footer must link to blog');

      // LEGAL links
      assert.ok(appJsContent.includes('href="/privacy-policy"'), 'Footer must link to privacy policy');
      assert.ok(appJsContent.includes('href="/terms-of-service"'), 'Footer must link to terms of service');
      assert.ok(appJsContent.includes('href="/refund-policy"'), 'Footer must link to refund policy');
    });

    test('Footer bottom bar contains copyright and support email', () => {
      assert.ok(appJsContent.includes('© 2026 FLIQ. All rights reserved.'), 'Footer must contain copyright notice');
      assert.ok(appJsContent.includes('Support: <a href="mailto:supportfliq.ai@gmail.com">supportfliq.ai@gmail.com</a>'), 'Footer must display support email');
    });
  });

  describe('Legal Routing & Access Control', () => {
    test('Routes for privacy-policy, terms-of-service, refund-policy, about, and contact are wired in render()', () => {
      assert.ok(appJsContent.includes("path==='/privacy-policy'"), 'Routing must handle /privacy-policy');
      assert.ok(appJsContent.includes("path==='/terms-of-service'"), 'Routing must handle /terms-of-service');
      assert.ok(appJsContent.includes("path==='/refund-policy'"), 'Routing must handle /refund-policy');
      assert.ok(appJsContent.includes("path==='/about'"), 'Routing must handle /about');
      assert.ok(appJsContent.includes("path==='/contact'||path==='/support'"), 'Routing must handle /contact and /support');
    });

    test('Legal pages are not blocked by isProtected (publicly accessible without authentication)', () => {
      // Find isProtected definition in app.js
      const isProtectedMatch = appJsContent.match(/const isProtected\s*=\s*[^;]+;/);
      assert.ok(isProtectedMatch, 'isProtected definition should be found');
      const isProtectedCode = isProtectedMatch[0];

      assert.ok(!isProtectedCode.includes('privacy-policy'), 'privacy-policy should not be protected');
      assert.ok(!isProtectedCode.includes('terms-of-service'), 'terms-of-service should not be protected');
      assert.ok(!isProtectedCode.includes('refund-policy'), 'refund-policy should not be protected');
      assert.ok(!isProtectedCode.includes('about'), 'about should not be protected');
      assert.ok(!isProtectedCode.includes('contact'), 'contact should not be protected');
    });
  });

  describe('Privacy Policy Content & Safeguards', () => {
    test('Privacy Policy specifies registration data, test URLs, diagnostics, and AI inputs', () => {
      assert.ok(appJsContent.includes('function privacyPolicy()'), 'privacyPolicy function must be defined');
      assert.ok(appJsContent.includes('Google OAuth') || appJsContent.includes('Firebase Authentication'), 'Must specify authentication details');
      assert.ok(appJsContent.includes('Submitted Website URLs'), 'Must detail submitted URLs collection');
      assert.ok(appJsContent.includes('Scan Results and Diagnostic Data'), 'Must detail diagnostics & screenshot data');
    });

    test('Privacy Policy explicitly states payment card numbers are never stored on FLIQ servers', () => {
      assert.ok(
        appJsContent.includes('never receive, process, or store credit card numbers') ||
        appJsContent.includes('never collect payment card numbers on our servers'),
        'Must specify payment card processing is handled by Polar and not stored on FLIQ'
      );
    });

    test('Privacy Policy includes data retention limits and trusted sub-processors', () => {
      assert.ok(appJsContent.includes('Retained for 7 days'), 'Free retention: 7 days');
      assert.ok(appJsContent.includes('Retained for 90 days'), 'Creator retention: 90 days');
      assert.ok(appJsContent.includes('Retained for 365 days'), 'Team retention: 365 days');
      assert.ok(appJsContent.includes('Google Cloud') && appJsContent.includes('Polar') && appJsContent.includes('Render') && appJsContent.includes('Groq'), 'Must list sub-processors');
    });

    test('Privacy Policy provides user rights and support contact', () => {
      assert.ok(appJsContent.includes('Your Rights and Choices'), 'Must detail user rights');
      assert.ok(appJsContent.includes('mailto:supportfliq.ai@gmail.com'), 'Must provide clickable support email');
    });
  });

  describe('Terms of Service Content & Restrictions', () => {
    test('Terms of Service requires users to only scan websites they own or are authorized to test', () => {
      assert.ok(appJsContent.includes('function termsOfService()'), 'termsOfService function must be defined');
      assert.ok(
        appJsContent.includes('You must only scan websites that you own or are explicitly authorized to test') ||
        appJsContent.includes('must only scan websites they own or are authorized to test'),
        'Terms of Service must mandate authorized testing only'
      );
    });

    test('Terms of Service prohibits scanning internal or restricted endpoints', () => {
      assert.ok(appJsContent.includes('localhost'), 'Must restrict localhost');
      assert.ok(appJsContent.includes('metadata.google.internal'), 'Must restrict cloud metadata');
    });

    test('Terms of Service states the advisory nature of findings and AI recommendations', () => {
      assert.ok(
        appJsContent.includes('advisory basis') || appJsContent.includes('ADVISORY BASIS'),
        'Terms of Service must note findings are advisory'
      );
      assert.ok(appJsContent.includes('Limitation of Liability'), 'Must include limitation of liability');
    });
  });

  describe('Refund Policy Content & Disclaimers', () => {
    test('Refund Policy prominently states NO REFUNDS — ALL SALES ARE FINAL', () => {
      assert.ok(appJsContent.includes('function refundPolicy()'), 'refundPolicy function must be defined');
      assert.ok(appJsContent.includes('NO REFUNDS — ALL SALES ARE FINAL'), 'Must prominently display all sales are final notice');
    });

    test('Refund Policy explains compute provisioning rationale and unused quota treatment', () => {
      assert.ok(appJsContent.includes('cloud compute capacity') || appJsContent.includes('headless browser'), 'Must explain compute cost rationale');
      assert.ok(appJsContent.includes('Unused scans do not roll over'), 'Must explain scan quotas do not roll over');
    });

    test('Refund Policy addresses cancellation and duplicate charge review within 14 days', () => {
      assert.ok(appJsContent.includes('Settings → Billing'), 'Must explain how to cancel via settings');
      assert.ok(appJsContent.includes('14 calendar days'), 'Must specify 14-day window for duplicate charge reviews');
      assert.ok(appJsContent.includes('mailto:supportfliq.ai@gmail.com'), 'Must provide support email for billing inquiries');
    });

    test('Refund Policy explicitly preserves statutory consumer protection rights', () => {
      assert.ok(
        appJsContent.includes('Statutory Consumer Protection Rights') ||
        appJsContent.includes('consumer protection legislation'),
        'Must include statutory consumer protection rights disclaimer'
      );
    });
  });

  describe('Customer Support & About Pages', () => {
    test('Customer Support page provides email, expected response window, and topic cards', () => {
      assert.ok(appJsContent.includes('function contactPage()'), 'contactPage function must be defined');
      assert.ok(appJsContent.includes('Technical Support') && appJsContent.includes('Billing &amp; Plans'), 'Must include support topic cards');
      assert.ok(appJsContent.includes('24–48 Business Hours'), 'Must specify response window');
    });

    test('About page communicates mission, non-destructive testing, and support contact', () => {
      assert.ok(appJsContent.includes('function aboutPage()'), 'aboutPage function must be defined');
      assert.ok(appJsContent.includes('Non-Destructive Testing Philosophy'), 'Must detail testing philosophy');
      assert.ok(appJsContent.includes('mailto:supportfliq.ai@gmail.com'), 'Must provide support contact on about page');
    });
  });

  describe('Pricing Page Integration', () => {
    test('Pricing page includes customer support box and links to policies', () => {
      assert.ok(appJsContent.includes('pricing-support-box'), 'Pricing page must include pricing-support-box');
      assert.ok(appJsContent.includes('mailto:supportfliq.ai@gmail.com'), 'Pricing page must link to support email');
      assert.ok(appJsContent.includes('href="/terms-of-service"'), 'Pricing support box must link to terms');
      assert.ok(appJsContent.includes('href="/refund-policy"'), 'Pricing support box must link to refund policy');
    });
  });

  describe('CSS Styling & Responsive Layout Rules', () => {
    test('styles.css contains styling for site-footer, legal-page, callout cards, and contact grid', () => {
      assert.ok(stylesCssContent.includes('.site-footer'), 'Must contain .site-footer style rules');
      assert.ok(stylesCssContent.includes('.legal-page'), 'Must contain .legal-page style rules');
      assert.ok(stylesCssContent.includes('.legal-callout-card'), 'Must contain .legal-callout-card style rules');
      assert.ok(stylesCssContent.includes('.contact-cards-grid'), 'Must contain .contact-cards-grid style rules');
      assert.ok(stylesCssContent.includes('.pricing-support-box'), 'Must contain .pricing-support-box style rules');
    });

    test('styles.css contains mobile responsive rules for footer and legal pages', () => {
      assert.ok(stylesCssContent.includes('@media (max-width: 640px)'), 'Must contain 640px mobile media query');
      assert.ok(stylesCssContent.includes('.footer-links-grid'), 'Footer links grid must have responsive rules');
      assert.ok(stylesCssContent.includes('.legal-title'), 'Legal title must adapt responsively');
    });
  });

});
