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
const HMAC_SECRET = process.env.HMAC_SECRET || 'cloudipa-hmac-secure-token-secret-salt';
const API_AUTH_TOKEN = process.env.API_AUTH_TOKEN || '';
const SERVER_GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const SERVER_GITHUB_REPO = process.env.GITHUB_REPO || 'akbar-shaik/CloudIPAAA';

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
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1024 MB limit (1 GB)
});

// Memory job registry
const jobs = new Map();

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

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    activeJobs: jobs.size,
    timestamp: new Date().toISOString()
  });
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

// GET /api/build/:id (Status polling)
app.get('/api/build/:id', (req, res) => {
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
    elapsedSeconds: elapsed,
    artifactUrl: job.artifactUrl || null,
    ipaName: job.ipaName || null,
    error: job.error || null,
  });
});

// POST /api/build
app.post('/api/build', upload.single('projectZip'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No project file uploaded. Please upload a .zip archive or project folder.' });
    }

    // Authentication: Require user token or server API Key or pre-configured server token
    const clientGitHubToken = req.headers['x-github-token'] || req.body.githubToken;
    const clientApiKey = req.headers['x-api-key'] || req.body.apiKey;

    let effectiveToken = clientGitHubToken || SERVER_GITHUB_TOKEN;
    if (!effectiveToken) {
      if (API_AUTH_TOKEN && clientApiKey !== API_AUTH_TOKEN) {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        return res.status(401).json({ error: 'Authentication required. Provide X-GitHub-Token or valid X-API-Key.' });
      }
    }

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

    // Move file to preserved upload location bound to requestId
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

    // Generate HMAC-signed archive URL valid for 20 minutes
    const expires = Date.now() + (20 * 60 * 1000);
    const signature = generateHmacSignature(requestId, expires);
    const archiveUrl = `${PUBLIC_BASE_URL}/api/uploads/${requestId}?expires=${expires}&sig=${signature}`;

    const job = {
      id: requestId,
      status: 'in_progress',
      stage: 1,
      stageName: 'Project Uploaded & Signed',
      message: 'Project uploaded, HMAC signature generated.',
      startTime,
      elapsedSeconds: 0,
      scheme: effectiveScheme,
      uploadFilePath: permanentUploadPath,
      artifactUrl: null,
      error: null,
    };

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
    // Stage 2: Dispatched to Cloud Runner
    job.stage = 2;
    job.stageName = 'Dispatching macOS Runner';
    job.message = `Sending build request to GitHub Actions [${repo}]...`;

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
      throw new Error(`Failed to dispatch GitHub Actions workflow (${dispatchResp.status}): ${errText}`);
    }

    // Stage 3: Queued & Allocating Runner
    job.stage = 3;
    job.stageName = 'Queued in Cloud';
    job.message = 'Waiting for an available GitHub macOS runner (macos-15)...';

    let targetRunId = null;
    let targetRun = null;
    const pollStart = Date.now();

    while (Date.now() - pollStart < 25 * 60 * 1000) {
      await sleep(10000); // 10s polite poll

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
          }
        }
      } else {
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

          if (targetRun.status === 'in_progress') {
            job.stage = 5;
            job.stageName = 'Compiling on macOS';
            job.message = `xcodebuild compiling scheme '${scheme}' on Apple Silicon runner...`;
          } else if (targetRun.status === 'completed') {
            break;
          }
        }
      }
    }

    if (!targetRun || targetRun.conclusion !== 'success') {
      const conclusion = targetRun ? targetRun.conclusion : 'timeout';
      throw new Error(`Cloud compilation failed with status: ${conclusion}. Check GitHub repository Actions tab for details.`);
    }

    // Stage 6: Artifact Download
    job.stage = 6;
    job.stageName = 'Downloading & Verifying IPA';
    job.message = 'Retrieving compiled unsigned .ipa from GitHub runner...';

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

    // Extract with Zip Slip protection
    extractZipSafely(buffer, destDir);

    const files = fs.readdirSync(destDir);
    const ipaFile = files.find(f => f.endsWith('.ipa')) || `${scheme}.unsigned.ipa`;

    job.stage = 7;
    job.stageName = 'Build Complete';
    job.status = 'completed';
    job.ipaName = ipaFile;
    job.artifactUrl = `/builds/${requestId}/${ipaFile}`;
    job.message = 'Unsigned IPA built successfully! Ready for download.';
    job.elapsedSeconds = Math.floor((Date.now() - job.startTime) / 1000);

  } catch (err) {
    console.error(`Build pipeline error for ${requestId}:`, err);
    job.status = 'failed';
    job.stageName = 'Build Failed';
    job.error = err.message || 'Unknown build error';
    job.message = err.message;
  } finally {
    // Delete uploaded zip file after runner downloads it or upon completion
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CloudIPA Web Builder backend running on port ${PORT}`);
});
