# FLIQ Multi-Platform Production Deployment Guide

This guide details how to deploy FLIQ across any static frontend provider (**Cloudflare Pages**, **Vercel**, **Netlify**, or custom hosting) paired with an independent **Node.js persistent backend** (Docker container, Google Cloud Run, Railway, Render, Fly.io, or VPS) without modifying application code.

---

## 1. Architecture Overview

FLIQ separates cleanly into two portable tiers:

1. **Static Frontend (SPA)**:
   - Pure HTML, CSS, and ES Modules (`index.html`, `app.js`, `styles.css`, `public/`).
   - Fully decoupled from proprietary hosting APIs.
   - Routes SPA navigation using platform-native rewrite rules (`_redirects` for Cloudflare Pages/Netlify; `vercel.json` for Vercel).
   - Resolves all API requests via centralized `getApiBase()`:
     - When `FLIQ_BACKEND_URL` is set during build, client requests point directly to the remote backend (`https://api.yourdomain.com/api/...`).
     - When unset, requests default to relative same-origin paths (`/api/...`).

2. **Persistent Node.js Backend (`server.js`)**:
   - Standard Node.js >= 20 HTTP server.
   - Hosts real headless browser audits using Playwright and Chromium.
   - Streams live scan progress via Server-Sent Events (SSE).
   - Cryptographically verifies Firebase ID tokens.
   - Stores reports and screenshots locally (configurable via `FLIQ_DATA_DIR`) or syncs with Google Cloud Firestore when connected.
   - Enforces configurable, origin-validated CORS (`FLIQ_ALLOWED_ORIGINS`).
   - Automatically disables test runner routes in production (`NODE_ENV=production`).
   - Provides `/api/health` health checks and graceful shutdown on `SIGTERM` / `SIGINT`.

---

## 2. Environment Variables Reference

### Frontend Build Variables (Client Dashboard)
Set these in your static hosting provider's build environment (Cloudflare Pages, Vercel, or Netlify):

| Variable | Required | Description |
| :--- | :---: | :--- |
| `FLIQ_BACKEND_URL` | **Yes (Decoupled)** | Full HTTPS URL of your deployed backend (e.g. `https://api.fliq.io` or `https://fliq-api.onrender.com`). Leave empty for local or single-host deployments. |
| `FIREBASE_PROJECT_ID` | **Yes** | Firebase project ID (e.g. `fliq-61989`). |
| `FIREBASE_WEB_API_KEY` | **Yes** | Client Web API key for Firebase Authentication. |
| `FIREBASE_AUTH_DOMAIN` | Optional | Firebase auth domain (defaults to `<project>.firebaseapp.com`). |
| `FIREBASE_APP_ID` | **Yes** | Firebase Web App ID. |
| `FIREBASE_MESSAGING_SENDER_ID` | Optional | Firebase Cloud Messaging sender ID. |

> **Security Guarantee**: Frontend build files (`firebase-config.js` and `firebase-config.json`) only receive public client configurations. No private keys, service accounts, or backend secrets are ever bundled into client files.

### Backend Server Variables (Node.js Container / Server)
Set these on your backend container host (Cloud Run, Railway, Render, Fly.io, or VPS):

| Variable | Required | Description |
| :--- | :---: | :--- |
| `NODE_ENV` | **Yes** | Set to `production`. Automatically disables all internal test routes with 404 and enforces strict CORS. |
| `PORT` | Optional | HTTP port to bind (default: `3000`). Cloud providers like Cloud Run, Render, and Railway set this automatically. |
| `HOST` | Optional | Host interface to bind (default: `0.0.0.0`). |
| `FLIQ_ALLOWED_ORIGINS` | **Yes** | Comma-separated list of allowed frontend origins (e.g. `https://my-frontend.pages.dev,*.pages.dev,https://fliq.vercel.app,https://fliq.io`). |
| `FLIQ_DATA_DIR` | Optional | Path for persistent test database and screenshots (default: `./data`). Point to a persistent volume mount (e.g. `/data` or `/mnt/storage`). |
| `FIREBASE_PROJECT_ID` | **Yes** | Firebase project ID for token verification and Firestore. |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | **Recommended** | Full inline JSON string of your Firebase service account private key. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Alternative | Filepath to service account JSON key on the backend disk (kept outside public directories). |
| `GROQ_API_KEY` | Optional | API key for AI summary enhancements. If unset, deterministic rule-based analysis functions automatically. |
| `FLIQ_RUN_SUITES_ON_START` | Optional | Set to `false` in production (prevents test suites from auto-running on server boot). |

---

## 3. Backend Deployment

### Option A: Docker Container (Google Cloud Run / Railway / Fly.io / Render / AWS ECS)

The project includes a production-ready `Dockerfile` based on `node:20-bookworm-slim` with all system libraries required for headless Chromium.

1. **Build and test the Docker container locally**:
   ```bash
   docker build -t fliq-backend .
   docker run -p 3000:3000 -e NODE_ENV=production -e FIREBASE_PROJECT_ID=fliq-61989 fliq-backend
   ```

2. **Deploy to Google Cloud Run**:
   ```bash
   gcloud run deploy fliq-backend \
     --source . \
     --platform managed \
     --region us-central1 \
     --allow-unauthenticated \
     --set-env-vars NODE_ENV=production,FIREBASE_PROJECT_ID=fliq-61989,FLIQ_RUN_SUITES_ON_START=false,FLIQ_ALLOWED_ORIGINS="https://your-frontend.pages.dev,*.pages.dev"
   ```

3. **Deploy to Railway / Render / Fly.io**:
   - Connect the Git repository.
   - The platform will automatically detect `Dockerfile` or `package.json`.
   - Set the environment variables listed in Section 2.
   - For Render/Railway with `package.json`:
     - **Build Command**: `npm ci --only=production && npx playwright install --with-deps chromium && npm run build`
     - **Start Command**: `node server.js`

### Option B: Linux VM (Ubuntu 22.04+ / Debian 12) with PM2 or systemd

1. **Install Node.js 20 LTS**:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

2. **Clone & Install Dependencies**:
   ```bash
   git clone <repo-url> /opt/fliq
   cd /opt/fliq
   npm ci --only=production
   npx playwright install --with-deps chromium
   npm run build
   ```

3. **Start with PM2**:
   ```bash
   npm install -g pm2
   NODE_ENV=production pm2 start server.js --name "fliq-api"
   pm2 save
   pm2 startup
   ```

---

## 4. Frontend Deployment (Static Hosting)

The static frontend can be deployed to any provider. To switch providers, configure your repository with the new provider and provide `FLIQ_BACKEND_URL`—no code changes needed.

### A. Cloudflare Pages (Exclusive Frontend Hosting)

FLIQ is hosted on Cloudflare Pages using native Single-Page Application (SPA) routing:
- **Build Output Directory**: `.` (Root)
- **Native SPA Fallback**: Automatically served via `200.html` and `index.html` (no looping 200 rewrite rules in `_redirects`).
- **Configuration**: Managed via `wrangler.jsonc` with `pages_build_output_dir: "."`.

#### 1. Cloudflare Dashboard Setup (Git-Integrated Deployment)
1. Go to **Cloudflare Dashboard** $\rightarrow$ **Workers & Pages** $\rightarrow$ **Create application** $\rightarrow$ select the **Pages** tab (do **NOT** select Workers) $\rightarrow$ **Connect to Git**.
2. Select your repository.
3. Configure Build Settings:
   - **Framework preset**: `None`
   - **Build command**: `npm run build`
   - **Build output directory**: `.`
4. Add Environment Variables (under **Settings** $\rightarrow$ **Environment variables**):
   - `FLIQ_BACKEND_URL`: `https://your-backend-api.com` (leave blank if running same-origin)
   - `FIREBASE_PROJECT_ID`: `fliq-61989`
   - `FIREBASE_WEB_API_KEY`: `<client-web-api-key>`
   - `FIREBASE_AUTH_DOMAIN`: `fliq-61989.firebaseapp.com`
   - `FIREBASE_APP_ID`: `1:638791431564:web:84087d00b1a87a0829d2a9`
5. Click **Save and Deploy**.

#### 2. Manual CLI Deployment via Wrangler Pages
If deploying directly from your local terminal or CI/CD without Git integration:
```bash
# Step 1: Run the build to generate 200.html, configs, and assets
npm run build

# Step 2: Deploy to Cloudflare Pages (use `pages deploy`, never `wrangler deploy`)
npx wrangler pages deploy . --project-name fliq
```

### B. Vercel
1. Go to Vercel Dashboard $\rightarrow$ **Add New Project** $\rightarrow$ Import your Git repository.
2. Configure Build Settings:
   - **Build command**: `npm run build`
   - **Output directory**: `.` (Root)
3. Add Environment Variables (`FLIQ_BACKEND_URL`, `FIREBASE_*`).
4. Click **Deploy**. Vercel uses `vercel.json` for SPA rewrites.

### C. Netlify
1. Go to Netlify Dashboard $\rightarrow$ **Add new site** $\rightarrow$ **Import an existing project**.
2. Configure Build Settings:
   - **Build command**: `npm run build`
   - **Publish directory**: `.` (Root)
3. Add Environment Variables (`FLIQ_BACKEND_URL`, `FIREBASE_*`).
4. Click **Deploy**. Netlify uses `_redirects`.

---

## 5. Post-Deployment Verification Checklist

Run these checks against your deployed backend and frontend:

1. **Backend Health Check**:
   ```bash
   curl -i https://your-backend-domain.com/api/health
   ```
   *Expected*: `HTTP/1.1 200 OK`, JSON body contains `ok: true`, `playwrightConfigured: true`, `firebaseConfigured: true`.

2. **Verify Test Endpoints are Inaccessible**:
   ```bash
   curl -i https://your-backend-domain.com/api/demo-workflow-tests
   ```
   *Expected*: `HTTP/1.1 404 Not Found`.

3. **Verify CORS Isolation**:
   ```bash
   curl -I -H "Origin: https://malicious-site.com" https://your-backend-domain.com/api/tests
   ```
   *Expected*: Response contains no `access-control-allow-origin` header matching the unauthorized origin.

4. **Verify Direct SPA Routing**:
   Visit `https://your-frontend-domain.com/dashboard/settings` and refresh the browser.
   *Expected*: Page renders without 404 errors.

5. **Verify Live Audit & Screenshot Streaming**:
   Open `/dashboard/new-test`, submit `https://example.com`, and verify:
   - Real-time progress updates stream via SSE (`/api/tests/:id/events`).
   - Audit completes and renders the final score cards and tabs.
   - Desktop and mobile screenshots load correctly from `/api/screenshots/:id-desktop.png`.
