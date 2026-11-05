import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { loadConfig } from '../config/loader';
import { iosDetector } from '../detectors/ios-detector';
import { gitClient } from '../git/git-client';
import { ghClient } from '../github/gh-client';
import { runPoller } from '../github/poller';
import { validateIpaArchive, calculateSha256 } from '../utils/validator';
import { logger } from '../utils/logger';
import { BuildOptions, LastBuildRecord, BuildInfo } from '../types';

export const LAST_BUILD_FILE = path.join('.cloudipa', 'last-build.json');

export async function runBuild(projectPathArg?: string, options: BuildOptions = {}): Promise<void> {
  if (options.plain) logger.setPlain(true);
  if (options.verbose) logger.setVerbose(true);

  const cwd = process.cwd();
  const startTime = Date.now();

  // STAGE 1: Environment & Auth Validation
  logger.stage(1, 7, 'Environment & Auth Validation');
  const ghInstalled = await ghClient.isGhInstalled();
  if (!ghInstalled) {
    throw new Error('GitHub CLI (gh) is not installed. Install it from https://cli.github.com');
  }

  const auth = await ghClient.checkAuth();
  if (!auth.authenticated) {
    throw new Error('GitHub CLI is not authenticated. Run "gh auth login" to authenticate.');
  }
  logger.success('GitHub CLI authenticated and operational.');

  // STAGE 2: Local Project & Git Inspection
  logger.stage(2, 7, 'Local Project & Git Inspection');
  const projectRoot = projectPathArg ? path.resolve(cwd, projectPathArg) : cwd;

  // Validate Git state
  const gitStatus = await gitClient.verifyReadiness(projectRoot, options.allowDirtyRemote);
  logger.success(`Git repository ready: ${gitStatus.repoOwner}/${gitStatus.repoName} (Branch: ${gitStatus.currentBranch})`);

  // Load configuration with overrides
  const config = loadConfig(undefined, {
    ...options,
    ref: options.ref || gitStatus.currentBranch,
  });

  // Inspect local iOS project
  let detectedScheme = config.project.scheme;
  let artifactBaseName = path.basename(config.output.filename, '.unsigned.ipa').replace(/\.ipa$/, '');

  try {
    const projectInfo = await iosDetector.inspect(projectRoot);
    logger.success(`Detected iOS project: ${projectInfo.projectFile || projectInfo.workspaceFile}`);

    if (!detectedScheme && projectInfo.schemes.length > 0) {
      detectedScheme = projectInfo.schemes[0];
      logger.info(`Using detected scheme: ${detectedScheme}`);
    }
  } catch (err: any) {
    logger.warn(`Notice: ${err.message}`);
    if (!detectedScheme) {
      logger.info('No explicit scheme provided. The remote macOS runner will auto-detect from xcodebuild.');
    }
  }

  // STAGE 3: Remote Workflow Dispatch
  logger.stage(3, 7, 'Remote Workflow Dispatch');
  const requestId = crypto.randomUUID();
  const branchToBuild = options.ref || config.github.branch || gitStatus.currentBranch || 'main';

  const dispatchInputs: Record<string, string> = {
    request_id: requestId,
    project_path: path.relative(cwd, projectRoot) || '.',
    scheme: detectedScheme || '',
    configuration: config.project.configuration,
    runner: config.build.runner,
    xcode_version: config.build.xcode_version,
    artifact_name: artifactBaseName,
  };

  logger.info(`Dispatching workflow "${config.github.workflow}" on branch "${branchToBuild}" [Request: ${requestId}]...`);
  await ghClient.triggerWorkflow(config.github.workflow, branchToBuild, dispatchInputs, cwd);
  logger.success('Workflow dispatched successfully.');

  if (options.wait === false) {
    logger.info(`--no-wait specified. Run "cloudipa status" or "cloudipa logs" to monitor execution.`);
    return;
  }

  // STAGE 4 & 5: Polling, Runner Allocation & Remote Compilation
  logger.stage(4, 7, 'Queued / Runner Allocation');
  let currentStageDisplayed = 4;

  const targetRun = await runPoller.pollUntilCompletion({
    workflow: config.github.workflow,
    requestId,
    cwd,
    baseIntervalMs: 10000,
    maxTimeoutMs: (config.build.timeout_minutes || 25) * 60 * 1000,
    onProgress: (progress) => {
      if (progress.state === 'in_progress' && currentStageDisplayed < 5) {
        logger.stage(5, 7, 'Remote macOS Build Execution');
        currentStageDisplayed = 5;
      }
      logger.info(`[+${progress.elapsedSeconds}s] ${progress.message}`);
    },
  });

  if (targetRun.conclusion !== 'success') {
    throw new Error(
      `Remote build failed with conclusion: "${targetRun.conclusion}". ` +
      `Run "cloudipa logs" to inspect the failure logs.`
    );
  }

  // STAGE 6: Artifact Download & Checksum Verification
  logger.stage(6, 7, 'Artifact Download & Checksum Verification');
  const artifactName = `cloudipa-artifact-${requestId}`;
  const outDir = path.resolve(cwd, config.output.directory);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const downloadTempDir = path.join(outDir, `.download-${requestId}`);
  if (!fs.existsSync(downloadTempDir)) {
    fs.mkdirSync(downloadTempDir, { recursive: true });
  }

  logger.info(`Downloading build artifact "${artifactName}" (Run #${targetRun.databaseId})...`);
  await ghClient.downloadArtifact(targetRun.databaseId, artifactName, downloadTempDir, cwd);

  // Search downloaded files
  const downloadedFiles = fs.readdirSync(downloadTempDir);
  const ipaFile = downloadedFiles.find((f) => f.endsWith('.ipa'));

  if (!ipaFile) {
    throw new Error(`Downloaded artifact did not contain an .ipa package in ${downloadTempDir}`);
  }

  const tempIpaPath = path.join(downloadTempDir, ipaFile);
  let finalIpaPath = path.join(outDir, config.output.filename);

  // Avoid silent destructive overwrite
  if (fs.existsSync(finalIpaPath)) {
    const backupPath = path.join(outDir, `${config.output.filename}.bak.${Date.now()}`);
    fs.renameSync(finalIpaPath, backupPath);
    logger.warn(`Existing IPA moved to backup: ${path.basename(backupPath)}`);
  }

  fs.copyFileSync(tempIpaPath, finalIpaPath);

  // Read build-info.json if available
  let buildInfo: BuildInfo | undefined;
  const buildInfoFile = downloadedFiles.find((f) => f === 'build-info.json');
  if (buildInfoFile) {
    try {
      const rawInfo = fs.readFileSync(path.join(downloadTempDir, buildInfoFile), 'utf8');
      buildInfo = JSON.parse(rawInfo);
    } catch (err: any) {
      logger.debug(`Could not parse build-info.json: ${err.message}`);
    }
  }

  // Verify Checksum
  const localSha256 = await calculateSha256(finalIpaPath);
  if (buildInfo && buildInfo.sha256) {
    if (localSha256.toLowerCase() !== buildInfo.sha256.toLowerCase()) {
      throw new Error(
        `Checksum verification mismatch! Expected: ${buildInfo.sha256}, Actual: ${localSha256}`
      );
    }
    logger.success(`SHA-256 verified: ${localSha256}`);
  }

  // STAGE 7: Local IPA Archive Integrity Validation
  logger.stage(7, 7, 'Local IPA Archive Integrity Validation');
  const validation = validateIpaArchive(finalIpaPath);
  if (!validation.valid) {
    throw new Error(`IPA archive validation failed: ${validation.errors.join(', ')}`);
  }
  logger.success(`Archive integrity passed: Payload/${validation.appName || '*.app'}/Info.plist verified.`);

  // Clean up download temp dir
  try {
    fs.rmSync(downloadTempDir, { recursive: true, force: true });
  } catch {
    // ignore temp cleanup
  }

  // Persist state in .cloudipa/last-build.json
  const cloudipaDir = path.join(cwd, '.cloudipa');
  if (!fs.existsSync(cloudipaDir)) {
    fs.mkdirSync(cloudipaDir, { recursive: true });
  }

  const lastBuildRecord: LastBuildRecord = {
    requestId,
    runId: targetRun.databaseId,
    url: targetRun.url,
    branch: branchToBuild,
    status: targetRun.status,
    conclusion: targetRun.conclusion,
    timestamp: new Date().toISOString(),
    outputFile: path.relative(cwd, finalIpaPath),
    sha256: localSha256,
    buildInfo,
  };

  fs.writeFileSync(
    path.join(cwd, LAST_BUILD_FILE),
    JSON.stringify(lastBuildRecord, null, 2),
    'utf8'
  );

  // Summary Table
  const totalElapsedSec = Math.floor((Date.now() - startTime) / 1000);
  const fileStats = fs.statSync(finalIpaPath);
  const sizeMb = (fileStats.size / (1024 * 1024)).toFixed(2);

  logger.raw('\n============================================================');
  logger.success('CloudIPA Build Completed Successfully!');
  logger.raw('============================================================');
  logger.table({
    'Request ID': requestId,
    'GitHub Run ID': `#${targetRun.databaseId}`,
    'Target Scheme': detectedScheme || buildInfo?.scheme || 'auto',
    'Configuration': config.project.configuration,
    'Bundle Identifier': buildInfo?.bundleIdentifier || 'Resolved on Remote',
    'Version': `${buildInfo?.version || '1.0'} (${buildInfo?.buildNumber || '1'})`,
    'Output File': path.relative(cwd, finalIpaPath),
    'File Size': `${sizeMb} MB`,
    'SHA-256': localSha256,
    'Total Elapsed': `${totalElapsedSec}s`,
    'Run URL': targetRun.url,
  });
  logger.raw('============================================================\n');
}
