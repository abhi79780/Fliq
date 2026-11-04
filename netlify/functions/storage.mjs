import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// In-memory cached database
let cachedTests = null;
let cachedTestsTimestamp = 0;
let hasLoggedMissingDataWarning = false;

function parseTestsPayload(raw) {
  if (!raw) return null;
  let text = '';
  if (Buffer.isBuffer(raw)) {
    if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
      try {
        text = zlib.gunzipSync(raw).toString('utf8');
      } catch {
        text = raw.toString('utf8');
      }
    } else {
      text = raw.toString('utf8');
    }
  } else if (typeof raw === 'string') {
    text = raw.trim();
  }
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {}
  return null;
}

export function getAllTests(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedTests && (now - cachedTestsTimestamp < 5000)) {
    return cachedTests;
  }

  // 1. Read from /tmp/tests.json if it exists (latest runtime writes)
  const tmpPath = path.join('/tmp', 'tests.json');
  try {
    if (fs.existsSync(tmpPath)) {
      const raw = fs.readFileSync(tmpPath, 'utf8');
      const parsed = parseTestsPayload(raw);
      if (parsed && parsed.length > 0) {
        cachedTests = parsed;
        cachedTestsTimestamp = now;
        return parsed;
      }
    }
  } catch {}

  // 2. Read from environment variables if seed data present
  if (process.env.FLIQ_SEED_TESTS_JSON) {
    const parsed = parseTestsPayload(process.env.FLIQ_SEED_TESTS_JSON);
    if (parsed && parsed.length > 0) {
      cachedTests = parsed;
      cachedTestsTimestamp = now;
      return parsed;
    }
  }

  if (process.env.FLIQ_SEED_TESTS_BASE64) {
    try {
      const buf = Buffer.from(process.env.FLIQ_SEED_TESTS_BASE64, 'base64');
      const parsed = parseTestsPayload(buf);
      if (parsed && parsed.length > 0) {
        cachedTests = parsed;
        cachedTestsTimestamp = now;
        return parsed;
      }
    } catch {}
  }

  // 3. Candidate filesystem locations
  const base = process.env.LAMBDA_TASK_ROOT || process.cwd();
  const candidatePaths = [
    path.join(base, 'tests.json'),
    path.join(base, 'netlify', 'functions', 'tests.json'),
    path.join(base, 'data', 'tests.json'),
    path.join(base, 'netlify', 'functions', 'data', 'tests.json'),
    path.join(process.cwd(), 'tests.json'),
    path.join(process.cwd(), 'netlify', 'functions', 'tests.json'),
    path.join(process.cwd(), 'data', 'tests.json'),
    path.join('/var/task', 'tests.json'),
    path.join('/var/task', 'netlify', 'functions', 'tests.json'),
    path.join('/var/task', 'data', 'tests.json')
  ];

  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p);
        const parsed = parseTestsPayload(raw);
        if (parsed && parsed.length > 0) {
          cachedTests = parsed;
          cachedTestsTimestamp = now;
          return parsed;
        }
      }
    } catch {}
  }

  if (!hasLoggedMissingDataWarning) {
    console.warn('[Storage] No preexisting test records found in package bundle or env.');
    hasLoggedMissingDataWarning = true;
  }

  return cachedTests || [];
}

export function saveTestRecord(testRecord) {
  const list = [...getAllTests(true)];
  const idx = list.findIndex(t => t.id === testRecord.id);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...testRecord };
  } else {
    list.unshift(testRecord);
  }

  cachedTests = list;
  cachedTestsTimestamp = Date.now();

  // Persist to /tmp/tests.json so concurrent function instances on this container share data
  try {
    fs.writeFileSync(path.join('/tmp', 'tests.json'), JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {
    // Non-fatal if /tmp not writable in test environments
  }

  return list;
}

export function updateTestRecord(testId, fields) {
  const list = [...getAllTests(true)];
  const idx = list.findIndex(t => t.id === testId);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...fields };
    cachedTests = list;
    cachedTestsTimestamp = Date.now();
    try {
      fs.writeFileSync(path.join('/tmp', 'tests.json'), JSON.stringify(list, null, 2), 'utf8');
    } catch {}
    return list[idx];
  }
  return null;
}

export function getTestById(testId) {
  const list = getAllTests();
  return list.find(t => t.id === testId) || null;
}

export function getScreenshotBuffer(filename) {
  const safeName = path.basename(filename);
  const envKey = 'FLIQ_SCREENSHOT_' + safeName.replace(/[^a-zA-Z0-9]/g, '_');
  if (process.env[envKey]) {
    try {
      return Buffer.from(process.env[envKey], 'base64');
    } catch {}
  }

  const base = process.env.LAMBDA_TASK_ROOT || process.cwd();
  const candidatePaths = [
    path.join('/tmp', safeName),
    path.join(base, 'netlify', 'functions', 'data', safeName),
    path.join(base, 'data', safeName),
    path.join(base, safeName),
    path.join(process.cwd(), 'netlify', 'functions', 'data', safeName),
    path.join(process.cwd(), 'data', safeName),
    path.join('/var/task', 'netlify', 'functions', 'data', safeName),
    path.join('/var/task', 'data', safeName)
  ];

  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        return fs.readFileSync(p);
      }
    } catch {}
  }
  return null;
}

export function getRecordOwnerId(record) {
  if (!record || typeof record !== 'object') return null;
  const val = record.owner || record.userId || record.uid;
  return typeof val === 'string' && val.trim() ? val.trim() : null;
}

export function isUserAuthorizedForRecord(record, userUid) {
  if (!record || !userUid) return false;
  const ownerId = getRecordOwnerId(record);
  if (ownerId && ownerId === userUid) {
    return true;
  }
  if (Array.isArray(record.sharedWithUids) && record.sharedWithUids.includes(userUid)) {
    return true;
  }
  return false;
}
