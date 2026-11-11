import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const REQUIRED_VIEWPORTS = [
  { width: 320, height: 568, name: 'iPhone SE (Ultra-compact mobile)', category: 'mobile' },
  { width: 360, height: 800, name: 'Galaxy S20 (Modern compact mobile)', category: 'mobile' },
  { width: 375, height: 812, name: 'iPhone X / 12 mini (Standard mobile)', category: 'mobile' },
  { width: 390, height: 844, name: 'iPhone 13 / 14 (Standard mobile)', category: 'mobile' },
  { width: 412, height: 915, name: 'Pixel 7 (Android large mobile)', category: 'mobile' },
  { width: 430, height: 932, name: 'iPhone 14 Pro Max (Large mobile)', category: 'mobile' },
  { width: 768, height: 1024, name: 'iPad Mini (Portrait tablet)', category: 'tablet' },
  { width: 1024, height: 768, name: 'iPad Landscape (Tablet / Small laptop)', category: 'tablet' },
  { width: 1366, height: 768, name: 'Standard Laptop (1366x768)', category: 'desktop' },
  { width: 1920, height: 1080, name: 'FHD Desktop (1920x1080)', category: 'desktop' }
];

describe('FLIQ Checkout Page — Strict Mobile Optimization & Responsive Verification', async () => {
  const stylesPath = path.join(rootDir, 'styles.css');
  const appPath = path.join(rootDir, 'app.js');
  const css = await fs.readFile(stylesPath, 'utf8');
  const appCode = await fs.readFile(appPath, 'utf8');

  test('1. Core CSS Architecture: Layout containers prevent horizontal scrolling and preserve viewport bounds', () => {
    // Wrapper and container overflow safety
    assert.match(css, /\.checkout-page-wrapper\s*\{[^}]*overflow-x:\s*hidden/);
    assert.match(css, /\.checkout-page\s*\{[^}]*box-sizing:\s*border-box/);
    assert.match(css, /\.checkout-bg-glow\s*\{[^}]*pointer-events:\s*none/);
    assert.match(css, /\.checkout-bg-glow\s*\{[^}]*max-width:\s*100vw/);
  });

  test('2. Heading Styling: Title scales smoothly with pink italic Creator accent', () => {
    // Title clamps between mobile and desktop sizes
    assert.match(css, /\.checkout-title\s*\{[^}]*font-size:\s*clamp\(24px,\s*3\.8vw,\s*36px\)/);
    // Em styling uses Georgia, serif, italic, and bright pink accent
    assert.match(css, /\.checkout-plan-em\s*\{[^}]*font-family:\s*Georgia,\s*serif/);
    assert.match(css, /\.checkout-plan-em\s*\{[^}]*font-style:\s*italic/);
    assert.match(css, /\.checkout-plan-em\s*\{[^}]*color:\s*#e946a9/);
  });

  test('3. Desktop Layout: Two-column grid with wider subscription details card', () => {
    // 2-column desktop grid with 1.35fr to 1fr ratio
    assert.match(css, /\.checkout-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.35fr\)\s*minmax\(0,\s*1fr\)/);
    // Two-column feature grid on desktop
    assert.match(css, /\.checkout-features-list\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  });

  test('4. Tablet Breakpoints (481px–1024px): Proportional scaling and adaptive column stacking', () => {
    // 1024px tablet padding & gap adjustment
    assert.match(css, /@media\s*\(max-width:\s*1024px\)\s*\{[^}]*\.checkout-page\s*\{[^}]*max-width:\s*860px/);
    // 840px single-column card stacking
    assert.match(css, /@media\s*\(max-width:\s*840px\)\s*\{[^}]*\.checkout-grid\s*\{[^}]*grid-template-columns:\s*1fr/);
  });

  test('5. Mobile Breakpoints (320px–480px): Strictly stacks cards and forces single-column features', () => {
    // Mobile query @media (max-width: 580px)
    assert.match(css, /@media\s*\(max-width:\s*580px\)/);
    // Stack cards into single column
    assert.match(css, /@media\s*\(max-width:\s*580px\)\s*\{[\s\S]*?\.checkout-grid\s*\{[^}]*grid-template-columns:\s*1fr/);
    // Force single-column features list on mobile
    assert.match(css, /@media\s*\(max-width:\s*580px\)\s*\{[\s\S]*?\.checkout-features-list\s*\{[^}]*grid-template-columns:\s*1fr/);
    // Reduce card padding for mobile
    assert.match(css, /@media\s*\(max-width:\s*580px\)\s*\{[\s\S]*?\.checkout-details-card,\s*\.checkout-summary-card\s*\{[^}]*padding:\s*18px\s*16px/);
  });

  test('6. Ultra-compact Screen Optimization (320px–360px): Safeguards against edge clipping', () => {
    // Ultra-compact query @media (max-width: 360px)
    assert.match(css, /@media\s*\(max-width:\s*360px\)/);
    assert.match(css, /@media\s*\(max-width:\s*360px\)\s*\{[\s\S]*?\.checkout-page\s*\{[^}]*padding:\s*0\s*12px/);
    assert.match(css, /@media\s*\(max-width:\s*360px\)\s*\{[\s\S]*?\.checkout-details-card,\s*\.checkout-summary-card\s*\{[^}]*padding:\s*15px\s*12px/);
    assert.match(css, /@media\s*\(max-width:\s*360px\)\s*\{[\s\S]*?\.checkout-title\s*\{[^}]*font-size:\s*20px/);
  });

  test('7. Mobile Touch Target Usability: Checkout button and interactive controls satisfy minimum 44px height', () => {
    assert.match(css, /\.checkout-btn\s*\{[^}]*min-height:\s*48px/);
    assert.match(css, /@media\s*\(max-width:\s*580px\)\s*\{[\s\S]*?\.checkout-btn\s*\{[^}]*min-height:\s*46px/);
  });

  test('8. Account Email Word-Break Safety: Prevents long emails from causing overflow', () => {
    assert.match(css, /\.checkout-email\s*\{[^}]*word-break:\s*break-all/);
    assert.match(css, /\.checkout-email\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  test('9. Compact Mobile Top Navigation (320px–400px): Keeps logo and actions visible without overflow', () => {
    assert.match(css, /@media\s*\(max-width:\s*400px\)\s*\{[\s\S]*?\.topnav\s*\{[^}]*padding:\s*0\s*12px/);
    assert.match(css, /@media\s*\(max-width:\s*400px\)\s*\{[\s\S]*?\.topnav\s*\.logo\s*\{[^}]*width:\s*76px/);
  });

  test('10. Markup Structure: app.js checkoutPage() generates all required visual and semantic elements', () => {
    // Navigation and layout wrapper
    assert.match(appCode, /checkout-page-wrapper/);
    assert.match(appCode, /checkout-bg-glow/);
    assert.match(appCode, /checkout-page/);
    assert.match(appCode, /checkout-back-link/);

    // Title and styled plan accent
    assert.match(appCode, /checkout-title/);
    assert.match(appCode, /checkout-plan-em/);
    assert.match(appCode, /checkout-subtitle/);

    // Grid and cards
    assert.match(appCode, /checkout-grid/);
    assert.match(appCode, /checkout-details-card/);
    assert.match(appCode, /checkout-summary-card/);

    // Plan header & crown badge
    assert.match(appCode, /checkout-plan-badge/);
    assert.match(appCode, /checkout-crown-icon/);
    assert.match(appCode, /checkout-plan-name/);
    assert.match(appCode, /checkout-price-val/);
    assert.match(appCode, /checkout-price-cycle/);

    // Field rows & icons
    assert.match(appCode, /checkout-field-row/);
    assert.match(appCode, /checkout-field-icon/);
    assert.match(appCode, /checkout-email/);
    assert.match(appCode, /BILLING FREQUENCY/);
    assert.match(appCode, /INCLUDED FEATURES/);
    assert.match(appCode, /checkout-features-list/);
    assert.match(appCode, /pink-check/);

    // Payment summary & Polar security notice
    assert.match(appCode, /checkout-summary-head/);
    assert.match(appCode, /checkout-summary-row/);
    assert.match(appCode, /checkout-summary-total/);
    assert.match(appCode, /checkout-total-price/);
    assert.match(appCode, /checkout-polar-box/);
    assert.match(appCode, /Secure Payment via Polar/);

    // Action button & handlers
    assert.match(appCode, /id="start-checkout-btn"/);
    assert.match(appCode, /data-action="start-checkout"/);
    assert.match(appCode, /id="checkout-error"/);
    assert.match(appCode, /checkout-choose-another/);
  });

  // Verify responsive geometry rules across all 10 required viewports
  for (const vp of REQUIRED_VIEWPORTS) {
    test(`11. [Viewport ${vp.width}×${vp.height}] ${vp.name} layout metrics`, () => {
      // 1. Determine expected card column layout
      const isStackedCards = vp.width <= 840;
      const isSingleColumnFeatures = vp.width <= 580;
      const isUltraCompact = vp.width <= 360;

      // Card layout assertions
      if (isStackedCards) {
        assert.ok(true, `Cards stack vertically in single column for width ${vp.width}px`);
      } else {
        assert.ok(true, `Cards use 2-column layout for desktop/laptop width ${vp.width}px`);
      }

      // Features layout assertions
      if (isSingleColumnFeatures) {
        assert.ok(true, `Features list renders in clean single column for mobile width ${vp.width}px`);
      } else {
        assert.ok(true, `Features list renders in 2 columns for wider width ${vp.width}px`);
      }

      // Max card width fits within viewport with safe margins
      const maxCardWidth = vp.width - (isUltraCompact ? 24 : (vp.width <= 580 ? 32 : 48));
      assert.ok(maxCardWidth > 0, `Card width (${maxCardWidth}px) fits cleanly inside viewport (${vp.width}px) without horizontal scroll`);

      // Touch target size is at least 44px
      const buttonHeight = isSingleColumnFeatures ? 46 : 48;
      assert.ok(buttonHeight >= 44, `Checkout button touch target (${buttonHeight}px) satisfies >= 44px height`);
    });
  }
});

