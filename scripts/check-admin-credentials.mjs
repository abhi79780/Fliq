/**
 * FLIQ – Firebase Admin credential diagnostic script
 * Run with:  node scripts/check-admin-credentials.mjs
 *
 * This script checks which credential path will be used when server.js starts
 * and verifies that it can successfully reach the Firebase Admin SDK.
 * It does NOT start the HTTP server or touch any scan data.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Load .env the same way server.js does
try { process.loadEnvFile(path.join(root, '.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }

const EXPECTED_PROJECT = 'fliq-61989';
const sep = '─'.repeat(60);

console.log(sep);
console.log('FLIQ Firebase Admin Credential Check');
console.log(sep);

// ── 1. Environment variables ────────────────────────────────────────────────
console.log('\n[1] Environment variables');
const envChecks = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_WEB_API_KEY',
  'FIREBASE_AUTH_DOMAIN',
  'FIREBASE_MESSAGING_SENDER_ID',
  'FIREBASE_APP_ID',
  'FIREBASE_SERVICE_ACCOUNT_JSON',
  'GOOGLE_APPLICATION_CREDENTIALS',
];
for (const key of envChecks) {
  const val = process.env[key];
  if (!val) {
    console.log(`  ✗  ${key}: (not set)`);
  } else if (key === 'FIREBASE_SERVICE_ACCOUNT_JSON') {
    console.log(`  ✓  ${key}: (set, ${val.length} chars)`);
  } else {
    console.log(`  ✓  ${key}: ${val}`);
  }
}

// ── 2. Project-ID check ─────────────────────────────────────────────────────
console.log('\n[2] Project ID check');
const configuredProject = process.env.FIREBASE_PROJECT_ID?.trim();
if (!configuredProject) {
  console.log('  ✗  FIREBASE_PROJECT_ID is not set – add it to .env');
} else if (configuredProject !== EXPECTED_PROJECT) {
  console.log(`  ✗  FIREBASE_PROJECT_ID is "${configuredProject}" but must be "${EXPECTED_PROJECT}"`);
} else {
  console.log(`  ✓  FIREBASE_PROJECT_ID = ${configuredProject}`);
}

// ── 3. Which credential path will server.js use? ────────────────────────────
console.log('\n[3] Credential path selection (same logic as server.js)');
let credentialMode = 'none';
let serviceAccountJson = null;
let adcFilePath = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  credentialMode = 'service-account-env';
  console.log('  → Will use: FIREBASE_SERVICE_ACCOUNT_JSON (inline JSON in env var)');
  try {
    serviceAccountJson = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    console.log(`     project_id:    ${serviceAccountJson.project_id}`);
    console.log(`     client_email:  ${serviceAccountJson.client_email}`);
    console.log(`     has private_key: ${Boolean(serviceAccountJson.private_key)}`);
  } catch {
    console.log('  ✗  FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
  const credPath = path.resolve(root, process.env.GOOGLE_APPLICATION_CREDENTIALS.trim());
  console.log(`  → Will use: GOOGLE_APPLICATION_CREDENTIALS = ${credPath}`);
  try {
    const raw = JSON.parse(await fs.readFile(credPath, 'utf8'));
    console.log(`     type: ${raw.type}`);
    if (raw.type === 'service_account') {
      credentialMode = 'service-account-file';
      serviceAccountJson = raw;
      console.log(`     project_id:    ${raw.project_id}`);
      console.log(`     client_email:  ${raw.client_email}`);
      console.log(`     has private_key: ${Boolean(raw.private_key)}`);
    } else if (raw.type === 'authorized_user') {
      credentialMode = 'adc-file';
      adcFilePath = credPath;
      console.log('     (authorized_user – ADC file from gcloud auth application-default login)');
      console.log(`     client_id:  ${raw.client_id}`);
    } else {
      credentialMode = 'adc-file';
      adcFilePath = credPath;
      console.log(`     (type="${raw.type}" – will be handled by Application Default Credentials)`);
    }
  } catch (e) {
    console.log(`  ✗  Could not read credential file: ${e.message}`);
  }
} else {
  credentialMode = 'adc-implicit';
  console.log('  → Will use: Application Default Credentials (implicit)');
  console.log('     (no FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS set)');

  // Show the default ADC file path
  const home = process.env.APPDATA || process.env.HOME || '~';
  const defaultADCPath = path.join(home, 'gcloud', 'application_default_credentials.json');
  const altADCPath = path.join(
    process.env.LOCALAPPDATA || path.join(home, '.config'),
    'gcloud',
    'application_default_credentials.json'
  );
  for (const p of [defaultADCPath, altADCPath]) {
    try {
      await fs.access(p);
      console.log(`     ADC file found: ${p}`);
      const raw = JSON.parse(await fs.readFile(p, 'utf8'));
      console.log(`     type: ${raw.type}`);
    } catch {
      // not found
    }
  }
}

// ── 4. Validate service-account field constraints ───────────────────────────
if (serviceAccountJson) {
  console.log('\n[4] Service-account credential validation');
  const issues = [];
  if (serviceAccountJson.type !== 'service_account') issues.push(`type must be "service_account", got "${serviceAccountJson.type}"`);
  if (!serviceAccountJson.project_id) issues.push('missing project_id');
  if (!serviceAccountJson.client_email) issues.push('missing client_email');
  if (!serviceAccountJson.private_key) issues.push('missing private_key');
  if (serviceAccountJson.project_id !== EXPECTED_PROJECT) issues.push(`project_id "${serviceAccountJson.project_id}" ≠ "${EXPECTED_PROJECT}"`);
  if (issues.length) {
    for (const i of issues) console.log(`  ✗  ${i}`);
  } else {
    console.log('  ✓  Service-account JSON is structurally valid');
  }
}

// ── 5. Live Firebase Admin SDK test ─────────────────────────────────────────
console.log('\n[5] Live Firebase Admin SDK test');
try {
  const { initializeApp, cert, applicationDefault, getApps, deleteApp } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');

  // Clean up any pre-existing test app
  const existing = getApps().find(a => a.name === '__fliq_diag__');
  if (existing) await deleteApp(existing);

  let app;
  if (serviceAccountJson) {
    app = initializeApp({ projectId: EXPECTED_PROJECT, credential: cert(serviceAccountJson) }, '__fliq_diag__');
  } else {
    app = initializeApp({ projectId: EXPECTED_PROJECT, credential: applicationDefault() }, '__fliq_diag__');
  }

  // Try to get an access token – this is the cheapest way to verify the credential
  const token = await app.options.credential.getAccessToken();
  console.log(`  ✓  Successfully obtained access token (type: ${token.token_type || 'Bearer'})`);

  // Try listing one Firebase Auth user – verifies the token has firebase.* scope
  try {
    await getAuth(app).listUsers(1);
    console.log('  ✓  Firebase Auth API is reachable and credential is authorised');
  } catch (authErr) {
    if (authErr.code === 'auth/insufficient-permission' || authErr.errorInfo?.code === 'auth/insufficient-permission') {
      console.log('  ⚠  Access token obtained but Firebase Auth responded with permission error.');
      console.log('     The account may lack the Firebase Admin SDK Service Agent role.');
      console.log('     Grant it at: https://console.cloud.google.com/iam-admin/iam?project=fliq-61989');
    } else {
      console.log(`  ✓  Firebase Auth API responded (${authErr.code || authErr.message}) – credential is working`);
    }
  }

  await deleteApp(app);
} catch (e) {
  console.log(`  ✗  Firebase Admin SDK test FAILED: ${e.message}`);
  if (e.message?.includes('Could not load the default credentials')) {
    console.log('\n  ── HOW TO FIX ──────────────────────────────────────────────');
    console.log('  Application Default Credentials are not configured.');
    console.log('  Run the following command (requires Google Cloud CLI):');
    console.log();
    console.log('    gcloud auth application-default login --project=fliq-61989');
    console.log();
    console.log('  If gcloud is not installed, download it from:');
    console.log('    https://cloud.google.com/sdk/docs/install');
    console.log();
    console.log('  Alternatively, download a service-account key from Firebase Console:');
    console.log('    https://console.firebase.google.com/project/fliq-61989/settings/serviceaccounts/adminsdk');
    console.log('  Save it outside the public/ folder and add to .env:');
    console.log('    GOOGLE_APPLICATION_CREDENTIALS=./fliq-61989-firebase-adminsdk.json');
    console.log('  ────────────────────────────────────────────────────────────');
  }
}

console.log('\n' + sep);
console.log('Credential mode selected:', credentialMode);
console.log(sep + '\n');
