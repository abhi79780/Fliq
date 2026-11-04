# FLIQ

FLIQ is a responsive website QA app with the supplied brand asset, public pages, account and onboarding layouts, dashboard, live Playwright checks, progress, results, screenshots, and report export.

## Run locally

1. Install Node.js 20 or later.
2. Run `npm install`.
3. Install the Playwright Chromium browser with `npx playwright install chromium`.
4. Copy `.env.example` to `.env` only if you are configuring credentials; the server loads `.env` at startup.
5. Start the app with `npm start` and open `http://127.0.0.1:3000`.

Test jobs and screenshots are saved in the ignored `data/` directory. The app rejects local/private target addresses and caps concurrent and daily scans (`FLIQ_MAX_ACTIVE_TESTS`, `FLIQ_DAILY_TEST_LIMIT`). Audit reports feature deterministic rule-based technical explanations and category-specific remediation guidance computed locally without third-party AI dependencies.

With the app running, run the route and interaction suite with `npm test`. The suite checks every route, core controls, the supplied logo loading, report tabs and JSON export, responsive overflow, and private-address rejection. Run `npm run test:scan-ui` to submit `example.com` through the website form, wait for the report, and verify retrieval. `node tests/run-real-scan.mjs` runs the same public test through the API and additionally checks the screenshot endpoint.

## Current integration boundary

Email/password Firebase Auth REST endpoints, password reset, Admin ID-token verification, Firestore user/test writes, and per-user report reads are wired when configured. Set `FIREBASE_WEB_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_MESSAGING_SENDER_ID`, and `FIREBASE_APP_ID` in `.env` from Firebase Console > Project settings > General > Your apps. Configure Admin credentials with `GOOGLE_APPLICATION_CREDENTIALS` or `FIREBASE_SERVICE_ACCOUNT_JSON`; keep that private key on the server only. Enable Google and GitHub in Authentication > Sign-in method, add the local host and deployed host under Authorized domains, and set the Firebase OAuth callback URL in the GitHub OAuth App. Deploy appropriate Firestore indexes and rules. The browser loads the modular Firebase SDK from the official Firebase CDN because this project has no bundler and npm registry access is unavailable in this environment. Report access can be granted by its owner to an existing Firebase account and revoked later; every grant requires an explicit confirmation, and recipients must sign in. Paid subscription processing, team administration, secure API-key management, and cloud screenshot storage are not implemented.

Without Firebase credentials, the app is a **local development preview only**: reports share local storage and no account-level isolation exists. It binds only to `127.0.0.1`. Do not expose this server to the public internet or use it for private website reports until Firebase is configured and the browser worker is isolated with network-level egress controls.

Before deployment, add Firebase Authentication and Admin SDK verification to every API route, store reports by verified UID, add Firestore security rules/indexes, configure OAuth providers and authorized domains, and use an isolated browser worker with egress controls. Also add request-level quotas, concurrency limits per authenticated account, cleanup/retention for screenshots, and operational monitoring. The current URL checks reject private destinations and re-check browser requests, but do not replace network-level egress restrictions in a production browser environment.

Plan amounts are illustrative. No payment processor is connected.

