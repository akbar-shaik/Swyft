const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

// Auto-load .env file if present
const envFilePath = path.join(__dirname, '.env');
if (fs.existsSync(envFilePath)) {
  try {
    const envContent = fs.readFileSync(envFilePath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const idx = trimmed.indexOf('=');
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (key && !process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch (e) {
    console.warn('Failed to parse .env file:', e.message);
  }
}

const app = express();
const PORT = process.env.PORT || 5050;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://ios.akbr.in').replace(/\/$/, '');
const AUTH_SECRET = process.env.AUTH_SECRET || process.env.HMAC_SECRET || 'cloudipa-secure-auth-secret-key-salt-2026';
const HMAC_SECRET = process.env.HMAC_SECRET || AUTH_SECRET;
const API_AUTH_TOKEN = process.env.API_AUTH_TOKEN || '';
let SERVER_GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
let SERVER_GITHUB_REPO = process.env.GITHUB_REPO || 'akbar-shaik/CloudIPAAA';

// Telegram Bot & User Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '1858623580:AAFiBK43EXj0e2cGkiXZL1ui-DCxtdjlR_A';
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID || '672766342';
const ALLOWED_CREDENTIAL_1 = process.env.ALLOWED_CREDENTIAL_1 || 'user_Akbar84';

// Strict input validation rules
const REPO_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_INPUT_REGEX = /^[A-Za-z0-9_.\- ]{1,100}$/;
const ALLOWED_RUNNERS = new Set(['macos-15', 'macos-14']);
const ALLOWED_CONFIGS = new Set(['Release', 'Debug']);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const UPLOADS_DIR = '/tmp/cloudipa-uploads';
const BUILDS_DIR = '/var/www/cloudipa/builds';
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(BUILDS_DIR)) fs.mkdirSync(BUILDS_DIR, { recursive: true });

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1024 MB (1 GB)
});

// Memory registries
const jobs = new Map();
const otpStore = new Map(); // key -> { otp, expiresAt, attempts, telegramUserId }

// --- Token & Auth Helpers ---
function signToken(payload, ttlMs = 12 * 60 * 60 * 1000) {
  const data = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  // Allow API key via header for automation / CLI
  const clientApiKey = req.headers['x-api-key'] || req.query.apiKey;
  if (API_AUTH_TOKEN && clientApiKey === API_AUTH_TOKEN) {
    return next();
  }

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Please enter credentials.' });
  }

  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired session token. Please re-authenticate.' });
  }

  req.user = payload;
  next();
}

// Helper: Zip Slip safe extraction
function extractZipSafely(zipBufferOrPath, destDir) {
  const resolvedDest = path.resolve(destDir);
  const zip = typeof zipBufferOrPath === 'string' ? new AdmZip(zipBufferOrPath) : new AdmZip(zipBufferOrPath);
  for (const entry of zip.getEntries()) {
    const targetPath = path.resolve(resolvedDest, entry.entryName);
    if (!targetPath.startsWith(resolvedDest + path.sep) && targetPath !== resolvedDest) {
      throw new Error(`Unsafe zip entry path rejected (Zip Slip attempt): ${entry.entryName}`);
    }
  }
  zip.extractAllTo(resolvedDest, true);
}

// Helper: HMAC Signature for temporary download URLs
function generateHmacSignature(requestId, expires) {
  return crypto.createHmac('sha256', HMAC_SECRET).update(`${requestId}:${expires}`).digest('hex');
}

// Helper: Telemetry Activity Recorder
function recordActivity(job, level, stage, message, detail = '', progressPct = null) {
  if (typeof progressPct === 'number') {
    job.progressPct = Math.min(100, Math.max(0, progressPct));
  }
  job.stage = stage;
  job.message = message;
  job.activities.push({
    time: new Date().toISOString(),
    level, // 'info' | 'warn' | 'error' | 'success'
    stage,
    message,
    detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
  });
}

// TTL Eviction task running every 15 minutes
setInterval(() => {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;

  // Evict stale memory jobs
  for (const [id, job] of jobs.entries()) {
    if (job.startTime && (now - job.startTime > ONE_HOUR)) {
      jobs.delete(id);
    }
  }

  // Evict stale OTPs
  for (const [key, item] of otpStore.entries()) {
    if (item.expiresAt && now > item.expiresAt) {
      otpStore.delete(key);
    }
  }

  // Clean stale uploads
  try {
    const uploadFiles = fs.readdirSync(UPLOADS_DIR);
    for (const f of uploadFiles) {
      const fullPath = path.join(UPLOADS_DIR, f);
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > ONE_HOUR) {
        fs.unlinkSync(fullPath);
      }
    }
  } catch (err) {
    console.error('Eviction error in UPLOADS_DIR:', err.message);
  }

  // Clean stale builds
  try {
    const buildDirs = fs.readdirSync(BUILDS_DIR);
    for (const d of buildDirs) {
      const fullPath = path.join(BUILDS_DIR, d);
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > ONE_HOUR) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      }
    }
  } catch (err) {
    console.error('Eviction error in BUILDS_DIR:', err.message);
  }
}, 15 * 60 * 1000);

// --- Public Endpoints ---

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    activeJobs: jobs.size,
    timestamp: new Date().toISOString(),
  });
});

// POST /api/auth/send-otp
// Accepts { username } OR { telegramUserId, botToken }
app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { username, telegramUserId, botToken } = req.body || {};

    let targetTelegramId = telegramUserId || TELEGRAM_USER_ID;
    let targetBotToken = botToken || TELEGRAM_BOT_TOKEN;
    let storeKey = '';

    if (username !== undefined) {
      // Credential 1 check: Must strictly match ALLOWED_CREDENTIAL_1 ('user_Akbar84' case sensitive)
      if (username !== ALLOWED_CREDENTIAL_1) {
        return res.status(401).json({ error: 'Invalid Access Credential. Access Denied.' });
      }
      storeKey = username;
    } else if (telegramUserId) {
      storeKey = String(telegramUserId);
    } else {
      return res.status(400).json({ error: 'Credential 1 is required.' });
    }

    if (!/^\d{5,15}$/.test(String(targetTelegramId || '')) || !/^\d+:[A-Za-z0-9_-]{30,}$/.test(String(targetBotToken || ''))) {
      return res.status(400).json({ error: 'Valid Telegram User ID and Bot Token are required.' });
    }

    // Generate 6-digit OTP
    const otp = String(crypto.randomInt(100000, 1000000));
    const expiresAt = Date.now() + (5 * 60 * 1000); // 5 minutes
    otpStore.set(storeKey, {
      otp,
      telegramUserId: targetTelegramId,
      expiresAt,
      attempts: 0,
    });

    // Send OTP via Telegram Bot
    const tgResp = await fetch(`https://api.telegram.org/bot${targetBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: targetTelegramId,
        text: `🔐 *CloudIPA Access Verification*\n\nYour 6-digit OTP code is: \`${otp}\`\n\n⏰ Valid for 5 minutes. Do not share this code.`,
        parse_mode: 'Markdown',
      }),
    });

    if (!tgResp.ok) {
      const err = await tgResp.json().catch(() => ({}));
      if (tgResp.status === 400 || tgResp.status === 403) {
        return res.status(400).json({
          error: `Telegram delivery error (${tgResp.status}): ${err.description || 'Ensure you sent /start to your bot.'}`,
        });
      }
      return res.status(502).json({ error: `Telegram gateway error: ${err.description || 'Failed to deliver OTP.'}` });
    }

    res.json({
      message: 'OTP sent successfully to Telegram.',
      expiresInSeconds: 300,
    });

  } catch (err) {
    console.error('Error sending OTP:', err);
    res.status(500).json({ error: 'Internal error generating OTP.' });
  }
});

// POST /api/auth/verify-otp
// Accepts { username, otp } OR { telegramUserId, otp }
app.post('/api/auth/verify-otp', (req, res) => {
  try {
    const { username, telegramUserId, otp } = req.body || {};
    const storeKey = username || (telegramUserId ? String(telegramUserId) : '');

    if (!storeKey || !otp) {
      return res.status(400).json({ error: 'Credential and OTP are required.' });
    }

    const entry = otpStore.get(storeKey);
    if (!entry) {
      return res.status(400).json({ error: 'No OTP requested or code expired. Please request a new code.' });
    }

    if (Date.now() > entry.expiresAt) {
      otpStore.delete(storeKey);
      return res.status(400).json({ error: 'OTP has expired. Please request a new code.' });
    }

    if (entry.attempts >= 5) {
      otpStore.delete(storeKey);
      return res.status(429).json({ error: 'Too many failed attempts. Lockout triggered. Please request a new OTP.' });
    }

    if (entry.otp !== String(otp).trim()) {
      entry.attempts += 1;
      const remaining = 5 - entry.attempts;
      return res.status(400).json({ error: `Invalid OTP code. ${remaining} attempt(s) remaining.` });
    }

    // Success: Clear OTP entry and sign 12-hour session bearer token
    otpStore.delete(storeKey);
    const token = signToken({ user: storeKey, role: 'admin' }, 12 * 60 * 60 * 1000);

    res.json({
      token,
      message: 'Authentication successful. Welcome to CloudIPA Studio.',
      expiresInHours: 12,
    });

  } catch (err) {
    console.error('Error verifying OTP:', err);
    res.status(500).json({ error: 'Internal error verifying OTP.' });
  }
});

// GET /api/uploads/:requestId (HMAC-signed archive download for GitHub Actions macOS runner)
app.get('/api/uploads/:requestId', (req, res) => {
  const { requestId } = req.params;
  const { expires, sig } = req.query;

  if (!expires || !sig) {
    return res.status(403).json({ error: 'Missing HMAC signature or expiration timestamp' });
  }

  const expTime = parseInt(expires, 10);
  if (isNaN(expTime) || Date.now() > expTime) {
    return res.status(403).json({ error: 'Download URL has expired' });
  }

  const expectedSig = generateHmacSignature(requestId, expires);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    return res.status(403).json({ error: 'Invalid HMAC signature' });
  }

  const job = jobs.get(requestId);
  const filePath = job ? job.uploadFilePath : path.join(UPLOADS_DIR, `${requestId}.zip`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Uploaded project archive not found' });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${requestId}.zip"`);
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
});

// --- Protected Endpoints (requireAuth) ---

// GET /api/settings/github/status
app.get('/api/settings/github/status', requireAuth, async (req, res) => {
  const currentToken = SERVER_GITHUB_TOKEN;
  const currentRepo = SERVER_GITHUB_REPO;

  if (!currentToken || !currentRepo) {
    return res.json({
      configured: false,
      repo: currentRepo || '',
      workflowInstalled: false,
    });
  }

  try {
    const wfResp = await fetch(`https://api.github.com/repos/${currentRepo}/contents/.github/workflows/cloudipa-build.yml`, {
      headers: {
        'Authorization': `Bearer ${currentToken}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'CloudIPA',
      },
    });

    res.json({
      configured: true,
      repo: currentRepo,
      workflowInstalled: wfResp.ok,
    });
  } catch (err) {
    res.json({
      configured: true,
      repo: currentRepo,
      workflowInstalled: false,
      error: err.message,
    });
  }
});

// POST /api/settings/github (1-Click GitHub Connect & Auto-Install Workflow)
app.post('/api/settings/github', requireAuth, async (req, res) => {
  try {
    const { token, repo } = req.body || {};
    const effectiveToken = (token || SERVER_GITHUB_TOKEN || '').trim();
    const effectiveRepo = (repo || SERVER_GITHUB_REPO || '').trim();

    if (!effectiveToken) {
      return res.status(400).json({ error: 'GitHub Personal Access Token is required.' });
    }
    if (!REPO_REGEX.test(effectiveRepo)) {
      return res.status(400).json({ error: 'Invalid repository format. Expected "owner/repo".' });
    }

    // Step 1: Verify token authentication and identity
    const userResp = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${effectiveToken}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'CloudIPA',
      },
    });

    if (!userResp.ok) {
      const err = await userResp.json().catch(() => ({}));
      return res.status(401).json({ error: `GitHub Authentication Failed (${userResp.status}): ${err.message || 'Invalid Token'}` });
    }

    const userData = await userResp.json();

    // Step 2: Verify repository access
    const repoResp = await fetch(`https://api.github.com/repos/${effectiveRepo}`, {
      headers: {
        'Authorization': `Bearer ${effectiveToken}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'CloudIPA',
      },
    });

    if (!repoResp.ok) {
      const err = await repoResp.json().catch(() => ({}));
      return res.status(404).json({ error: `Repository '${effectiveRepo}' not accessible (${repoResp.status}): ${err.message || 'Check repository name or permissions'}` });
    }

    // Step 3: Check and Install .github/workflows/cloudipa-build.yml
    const candidatePaths = [
      path.join(__dirname, '..', 'templates', 'cloudipa-build.yml'),
      path.join(__dirname, 'templates', 'cloudipa-build.yml'),
      path.join(__dirname, '..', '.github', 'workflows', 'cloudipa-build.yml'),
      path.join(__dirname, 'cloudipa-build.yml'),
    ];

    let workflowContent = '';
    for (const cp of candidatePaths) {
      if (fs.existsSync(cp)) {
        workflowContent = fs.readFileSync(cp, 'utf8');
        break;
      }
    }

    if (!workflowContent) {
      return res.status(500).json({ error: 'Local workflow template file not found on server.' });
    }

    // Check if workflow file already exists to get its SHA for update
    let existingSha = null;
    const checkFileResp = await fetch(`https://api.github.com/repos/${effectiveRepo}/contents/.github/workflows/cloudipa-build.yml`, {
      headers: {
        'Authorization': `Bearer ${effectiveToken}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'CloudIPA',
      },
    });

    if (checkFileResp.ok) {
      const fileData = await checkFileResp.json();
      existingSha = fileData.sha;
    }

    // Commit file via GitHub REST API
    const putBody = {
      message: 'ci: add CloudIPA iOS Build workflow for macOS runners',
      content: Buffer.from(workflowContent, 'utf8').toString('base64'),
    };
    if (existingSha) {
      putBody.sha = existingSha;
    }

    const putResp = await fetch(`https://api.github.com/repos/${effectiveRepo}/contents/.github/workflows/cloudipa-build.yml`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${effectiveToken}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'CloudIPA',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(putBody),
    });

    if (!putResp.ok) {
      const err = await putResp.json().catch(() => ({}));
      return res.status(putResp.status).json({
        error: `Failed to commit workflow to GitHub (${putResp.status}): ${err.message || 'Ensure token has "workflow" or "Workflows: Read and write" permission.'}`,
      });
    }

    // Step 4: Update runtime variables & persist to .env
    SERVER_GITHUB_TOKEN = effectiveToken;
    SERVER_GITHUB_REPO = effectiveRepo;

    try {
      const envPath = path.join(__dirname, '.env');
      let currentEnv = '';
      if (fs.existsSync(envPath)) currentEnv = fs.readFileSync(envPath, 'utf8');

      const lines = currentEnv.split('\n');
      let hasToken = false;
      let hasRepo = false;
      const updatedLines = lines.map(line => {
        if (line.startsWith('GITHUB_TOKEN=')) {
          hasToken = true;
          return `GITHUB_TOKEN=${effectiveToken}`;
        }
        if (line.startsWith('GITHUB_REPO=')) {
          hasRepo = true;
          return `GITHUB_REPO=${effectiveRepo}`;
        }
        return line;
      });

      if (!hasToken) updatedLines.push(`GITHUB_TOKEN=${effectiveToken}`);
      if (!hasRepo) updatedLines.push(`GITHUB_REPO=${effectiveRepo}`);

      fs.writeFileSync(envPath, updatedLines.join('\n').trim() + '\n', 'utf8');
    } catch (e) {
      console.warn('Failed to persist .env on disk:', e.message);
    }

    res.json({
      success: true,
      message: `Successfully connected as @${userData.login}! Workflow installed into '${effectiveRepo}'.`,
      repo: effectiveRepo,
      user: userData.login,
      workflowInstalled: true,
    });

  } catch (err) {
    console.error('Error configuring GitHub:', err);
    res.status(500).json({ error: err.message || 'Internal error setting up GitHub.' });
  }
});

// GET /api/build/:id (Status polling with real-time telemetry)
app.get('/api/build/:id', requireAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Build job not found' });
  }

  let elapsed = job.elapsedSeconds || 0;
  if (job.status === 'in_progress' && job.startTime) {
    elapsed = Math.floor((Date.now() - job.startTime) / 1000);
  }

  res.json({
    id: job.id,
    status: job.status,
    stage: job.stage,
    stageName: job.stageName,
    message: job.message,
    progressPct: job.progressPct || 0,
    activities: job.activities || [],
    runnerSteps: job.runnerSteps || [],
    fixSuggestion: job.fixSuggestion || null,
    elapsedSeconds: elapsed,
    artifactUrl: job.artifactUrl || null,
    ipaName: job.ipaName || null,
    error: job.error || null,
  });
});

// POST /api/build
app.post('/api/build', requireAuth, upload.single('projectZip'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No project file uploaded. Please upload a .zip archive or project folder.' });
    }

    const clientGitHubToken = req.headers['x-github-token'] || req.body.githubToken;
    let effectiveToken = clientGitHubToken || SERVER_GITHUB_TOKEN;

    const rawRepo = (req.headers['x-github-repo'] || req.body.githubRepo || SERVER_GITHUB_REPO || '').trim();
    if (!REPO_REGEX.test(rawRepo)) {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      return res.status(400).json({ error: 'Invalid GitHub repository format. Expected "owner/repo".' });
    }

    const scheme = (req.body.scheme || '').trim();
    if (scheme && !SAFE_INPUT_REGEX.test(scheme)) {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      return res.status(400).json({ error: 'Invalid scheme name. Allowed characters: alphanumeric, space, dot, underscore, dash.' });
    }

    const configuration = (req.body.configuration || 'Release').trim();
    if (!ALLOWED_CONFIGS.has(configuration)) {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      return res.status(400).json({ error: 'Invalid configuration. Allowed values: Release, Debug.' });
    }

    const runner = (req.body.runner || 'macos-15').trim();
    if (!ALLOWED_RUNNERS.has(runner)) {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      return res.status(400).json({ error: 'Invalid runner label. Allowed values: macos-15, macos-14.' });
    }

    const requestId = crypto.randomUUID();
    const startTime = Date.now();

    // Preserve upload bound to requestId
    const permanentUploadPath = path.join(UPLOADS_DIR, `${requestId}.zip`);
    fs.renameSync(file.path, permanentUploadPath);

    // Inspect archive for schemes and project name
    let detectedScheme = scheme;
    let detectedProjectName = 'App';

    try {
      const zip = new AdmZip(permanentUploadPath);
      const entries = zip.getEntries();
      for (const entry of entries) {
        const name = entry.entryName;
        if (name.endsWith('.xcodeproj/') || name.endsWith('.xcodeproj')) {
          const base = path.basename(name, '.xcodeproj');
          if (!detectedProjectName || detectedProjectName === 'App') {
            detectedProjectName = base;
          }
        }
        if (name.includes('xcshareddata/xcschemes/') && name.endsWith('.xcscheme')) {
          const schemeName = path.basename(name, '.xcscheme');
          if (!detectedScheme) {
            detectedScheme = schemeName;
          }
        }
      }
    } catch (err) {
      console.warn('Zip parsing note:', err.message);
    }

    const effectiveScheme = detectedScheme || detectedProjectName;

    // Generate HMAC-signed archive URL valid for 25 minutes
    const expires = Date.now() + (25 * 60 * 1000);
    const signature = generateHmacSignature(requestId, expires);
    const archiveUrl = `${PUBLIC_BASE_URL}/api/uploads/${requestId}?expires=${expires}&sig=${signature}`;

    const job = {
      id: requestId,
      status: 'in_progress',
      stage: 1,
      stageName: 'Project Uploaded & Signed',
      message: 'Project uploaded and HMAC signed URL generated.',
      progressPct: 15,
      startTime,
      elapsedSeconds: 0,
      scheme: effectiveScheme,
      uploadFilePath: permanentUploadPath,
      activities: [],
      runnerSteps: [],
      fixSuggestion: null,
      artifactUrl: null,
      error: null,
    };

    recordActivity(job, 'info', 1, 'Project uploaded and archive integrity scanned', `Found scheme: ${effectiveScheme}`, 10);
    recordActivity(job, 'info', 1, 'Generated HMAC-signed temporary download URL for macOS runner', `Expires in 25 minutes`, 15);

    jobs.set(requestId, job);

    res.json({
      requestId,
      scheme: job.scheme,
      message: 'Build initialized successfully',
    });

    // Run async build pipeline in background
    runBuildPipeline(requestId, archiveUrl, effectiveToken, rawRepo, effectiveScheme, configuration, runner);

  } catch (err) {
    console.error('Error starting build:', err);
    res.status(500).json({ error: err.message || 'Internal build server error' });
  }
});

async function runBuildPipeline(requestId, archiveUrl, token, repo, scheme, configuration, runner) {
  const job = jobs.get(requestId);
  if (!job) return;

  try {
    recordActivity(job, 'info', 2, `Dispatching GitHub Actions workflow on ${repo}...`, `Ref: main, Runner: ${runner}`, 25);

    const dispatchUrl = `https://api.github.com/repos/${repo}/actions/workflows/cloudipa-build.yml/dispatches`;
    const dispatchBody = JSON.stringify({
      ref: 'main',
      inputs: {
        request_id: requestId,
        project_path: '.',
        archive_url: archiveUrl,
        scheme: scheme || '',
        configuration: configuration || 'Release',
        runner: runner || 'macos-15',
        xcode_version: 'auto',
        artifact_name: scheme || 'App',
      },
    });

    const dispatchResp = await fetch(dispatchUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'CloudIPA-Web-Builder',
        'Content-Type': 'application/json',
      },
      body: dispatchBody,
    });

    if (!dispatchResp.ok) {
      const errText = await dispatchResp.text();
      let parsedErr = {};
      try { parsedErr = JSON.parse(errText); } catch {}

      if (dispatchResp.status === 404) {
        job.fixSuggestion = "Workflow file 'cloudipa-build.yml' was not found on GitHub. Please ensure the workflow is committed to the 'main' branch of your repository and that your GitHub token has 'Workflows: Read and write' and 'Contents: Read and write' permissions.";
      } else if (dispatchResp.status === 401 || dispatchResp.status === 403) {
        job.fixSuggestion = "GitHub API authorization failed. Verify that your GitHub token is valid and possesses 'Actions: Read and write' and 'Workflows: Read and write' permissions.";
      }

      throw new Error(`Failed to dispatch GitHub Actions workflow (${dispatchResp.status}): ${parsedErr.message || errText}`);
    }

    recordActivity(job, 'info', 3, 'Waiting for macOS runner allocation in GitHub Actions queue...', '', 35);

    let targetRunId = null;
    let targetRun = null;
    const pollStart = Date.now();
    const seenSteps = new Set();

    while (Date.now() - pollStart < 25 * 60 * 1000) {
      await sleep(10000); // 10s polite polling interval

      if (!targetRunId) {
        const listUrl = `https://api.github.com/repos/${repo}/actions/runs?event=workflow_dispatch&per_page=10`;
        const listResp = await fetch(listUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'CloudIPA-Web-Builder',
          },
        });

        if (listResp.ok) {
          const data = await listResp.json();
          const matched = (data.workflow_runs || []).find(r => r.display_title && r.display_title.includes(requestId));
          if (matched) {
            targetRunId = matched.id;
            targetRun = matched;
            recordActivity(job, 'info', 4, `macOS runner allocated. Build run #${targetRunId} started`, '', 40);
          }
        }
      } else {
        // Query live job and runner steps
        const jobsUrl = `https://api.github.com/repos/${repo}/actions/runs/${targetRunId}/jobs`;
        const jobsResp = await fetch(jobsUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'CloudIPA-Web-Builder',
          },
        });

        if (jobsResp.ok) {
          const jobsData = await jobsResp.json();
          const firstJob = (jobsData.jobs || [])[0];
          if (firstJob && Array.isArray(firstJob.steps)) {
            job.runnerSteps = firstJob.steps;
            for (const step of firstJob.steps) {
              const stepKey = `${step.name}:${step.status}`;
              if (!seenSteps.has(stepKey)) {
                seenSteps.add(stepKey);

                let mappedPct = null;
                let mappedStage = job.stage;

                if (step.name.includes('Checkout')) { mappedPct = 40; mappedStage = 4; }
                else if (step.name.includes('Fetch Uploaded Web Studio Archive')) { mappedPct = 45; mappedStage = 4; }
                else if (step.name.includes('Select Xcode Version')) { mappedPct = 50; mappedStage = 4; }
                else if (step.name.includes('Resolve Project & Scheme')) { mappedPct = 60; mappedStage = 4; }
                else if (step.name.includes('Compile Unsigned iOS Application')) { mappedPct = 70; mappedStage = 5; }
                else if (step.name.includes('Package Unsigned IPA')) { mappedPct = 80; mappedStage = 6; }
                else if (step.name.includes('Upload')) { mappedPct = 85; mappedStage = 6; }

                if (step.status === 'in_progress') {
                  recordActivity(job, 'info', mappedStage, `Runner executing: ${step.name}`, '', mappedPct);
                } else if (step.status === 'completed') {
                  const level = step.conclusion === 'success' ? 'info' : 'error';
                  recordActivity(job, level, mappedStage, `Runner finished: ${step.name} (${step.conclusion})`, '', mappedPct);
                }
              }
            }
          }
        }

        // Query overall run status
        const runUrl = `https://api.github.com/repos/${repo}/actions/runs/${targetRunId}`;
        const runResp = await fetch(runUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'CloudIPA-Web-Builder',
          },
        });

        if (runResp.ok) {
          targetRun = await runResp.json();
          if (targetRun.status === 'completed') {
            break;
          }
        }
      }
    }

    if (!targetRun || targetRun.conclusion !== 'success') {
      const conclusion = targetRun ? targetRun.conclusion : 'timeout';

      // Diagnose failure reason from steps
      if (job.runnerSteps.length > 0) {
        const failedStep = job.runnerSteps.find(s => s.conclusion === 'failure');
        if (failedStep) {
          const name = failedStep.name.toLowerCase();
          if (name.includes('scheme') || name.includes('resolve')) {
            job.fixSuggestion = "Could not find a valid Xcode scheme. In your iOS project, go to Xcode -> Product -> Scheme -> Manage Schemes, and ensure 'Shared' is checked.";
          } else if (name.includes('compile') || name.includes('xcodebuild')) {
            job.fixSuggestion = "xcodebuild compiler failure. Check that your project builds cleanly without signing and that external dependencies/Pods are committed.";
          } else if (name.includes('fetch') || name.includes('archive')) {
            job.fixSuggestion = "macOS runner could not download the uploaded archive. Check server network accessibility.";
          }
        }
      }

      if (!job.fixSuggestion) {
        job.fixSuggestion = "Inspect the GitHub Actions workflow run logs for detailed compiler error traces.";
      }

      throw new Error(`Cloud compilation finished with status: '${conclusion}'.`);
    }

    // Stage 6: Artifact Download
    recordActivity(job, 'info', 6, 'Retrieving compiled unsigned .ipa from GitHub runner...', '', 90);

    const artifactsUrl = `https://api.github.com/repos/${repo}/actions/runs/${targetRunId}/artifacts`;
    const artResp = await fetch(artifactsUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'CloudIPA-Web-Builder',
      },
    });

    if (!artResp.ok) {
      throw new Error(`Failed to fetch artifact list: HTTP ${artResp.status}`);
    }

    const artData = await artResp.json();
    const artifact = (artData.artifacts || []).find(a => a.name.includes(requestId) || a.name.includes('cloudipa-artifact'));

    if (!artifact) {
      throw new Error('No compiled artifact found for this build run.');
    }

    const downloadZipResp = await fetch(artifact.archive_download_url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'CloudIPA-Web-Builder',
      },
    });

    if (!downloadZipResp.ok) {
      throw new Error(`Failed to download artifact archive: HTTP ${downloadZipResp.status}`);
    }

    const buffer = Buffer.from(await downloadZipResp.arrayBuffer());

    const destDir = path.join(BUILDS_DIR, requestId);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    recordActivity(job, 'info', 6, 'Validating ZIP integrity and Payload structure (Zip Slip protection)...', '', 95);

    // Extract with Zip Slip protection
    extractZipSafely(buffer, destDir);

    const files = fs.readdirSync(destDir);
    const ipaFile = files.find(f => f.endsWith('.ipa')) || `${scheme}.unsigned.ipa`;

    job.stage = 7;
    job.stageName = 'Build Complete';
    job.status = 'completed';
    job.ipaName = ipaFile;
    job.artifactUrl = `/builds/${requestId}/${ipaFile}`;
    job.elapsedSeconds = Math.floor((Date.now() - job.startTime) / 1000);

    recordActivity(job, 'success', 7, 'Unsigned IPA built successfully! Ready for download.', `Package: ${ipaFile}`, 100);

  } catch (err) {
    console.error(`Build pipeline error for ${requestId}:`, err);
    job.status = 'failed';
    job.stageName = 'Build Failed';
    job.error = err.message || 'Unknown build error';
    job.message = err.message;
    recordActivity(job, 'error', job.stage, `Build failed: ${err.message}`, job.fixSuggestion || '');
  } finally {
    // Clean up local temp upload after pipeline concludes
    try {
      if (job.uploadFilePath && fs.existsSync(job.uploadFilePath)) {
        fs.unlinkSync(job.uploadFilePath);
      }
    } catch {}
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CloudIPA Web Builder backend running on port ${PORT}`);
  });
}

module.exports = {
  app,
  signToken,
  verifyToken,
  generateHmacSignature,
  extractZipSafely,
  recordActivity,
  otpStore,
  jobs,
  ALLOWED_CREDENTIAL_1,
};
