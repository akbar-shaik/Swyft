import fs from 'fs';
import path from 'path';
import { LAST_BUILD_FILE } from './build';
import { loadConfig } from '../config/loader';
import { ghClient } from '../github/gh-client';
import { validateIpaArchive, calculateSha256 } from '../utils/validator';
import { logger } from '../utils/logger';
import { LastBuildRecord, BuildInfo } from '../types';

export async function runDownload(
  runIdArg?: string,
  options?: { output?: string; plain?: boolean; verbose?: boolean }
): Promise<void> {
  if (options) {
    logger.setPlain(!!options.plain);
    logger.setVerbose(!!options.verbose);
  }

  const cwd = process.cwd();
  const config = loadConfig(undefined, { output: options?.output });

  let targetRunId: number | null = null;
  let requestId: string | null = null;

  if (runIdArg) {
    targetRunId = parseInt(runIdArg, 10);
    if (isNaN(targetRunId)) {
      throw new Error(`Invalid run ID: "${runIdArg}". Expected numeric GitHub run ID.`);
    }
  }

  const lastBuildPath = path.join(cwd, LAST_BUILD_FILE);
  if (!targetRunId && fs.existsSync(lastBuildPath)) {
    try {
      const lastBuild: LastBuildRecord = JSON.parse(fs.readFileSync(lastBuildPath, 'utf8'));
      targetRunId = lastBuild.runId;
      requestId = lastBuild.requestId;
    } catch (err: any) {
      logger.warn(`Could not read ${LAST_BUILD_FILE}: ${err.message}`);
    }
  }

  if (!targetRunId) {
    throw new Error('No build run ID found. Specify a run ID or run "cloudipa build" first.');
  }

  const outDir = path.resolve(cwd, config.output.directory);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const downloadTempDir = path.join(outDir, `.download-${targetRunId}`);
  if (!fs.existsSync(downloadTempDir)) {
    fs.mkdirSync(downloadTempDir, { recursive: true });
  }

  const artifactName = requestId ? `cloudipa-artifact-${requestId}` : '';

  logger.info(`Downloading artifact from GitHub Actions Run #${targetRunId}...`);
  if (artifactName) {
    await ghClient.downloadArtifact(targetRunId, artifactName, downloadTempDir, cwd);
  } else {
    // If no specific artifact name, try to download all artifacts
    const res = await ghClient.downloadArtifact(targetRunId, '', downloadTempDir, cwd);
  }

  // Find .ipa in downloaded files
  const searchForIpa = (dir: string): string | null => {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) {
        const sub = searchForIpa(full);
        if (sub) return sub;
      } else if (f.endsWith('.ipa')) {
        return full;
      }
    }
    return null;
  };

  const foundIpa = searchForIpa(downloadTempDir);
  if (!foundIpa) {
    throw new Error(`Downloaded artifact for run #${targetRunId} did not contain an .ipa package.`);
  }

  const targetIpaPath = path.join(outDir, config.output.filename);
  if (fs.existsSync(targetIpaPath)) {
    const backup = path.join(outDir, `${config.output.filename}.bak.${Date.now()}`);
    fs.renameSync(targetIpaPath, backup);
    logger.warn(`Existing IPA moved to backup: ${path.basename(backup)}`);
  }

  fs.copyFileSync(foundIpa, targetIpaPath);

  // Check validation
  const validation = validateIpaArchive(targetIpaPath);
  if (!validation.valid) {
    throw new Error(`IPA archive validation failed: ${validation.errors.join(', ')}`);
  }

  const sha256 = await calculateSha256(targetIpaPath);
  logger.success(`Successfully downloaded and verified: ${path.relative(cwd, targetIpaPath)}`);
  logger.table({
    'Destination': path.relative(cwd, targetIpaPath),
    'App Bundle': validation.appName || 'Verified',
    'SHA-256': sha256,
  });

  // Clean up
  try {
    fs.rmSync(downloadTempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
