import fs from 'fs';
import path from 'path';
import { LAST_BUILD_FILE } from './build';
import { loadConfig, findConfigFile } from '../config/loader';
import { ghClient } from '../github/gh-client';
import { gitClient } from '../git/git-client';
import { logger } from '../utils/logger';
import { LastBuildRecord } from '../types';

export async function runStatus(options?: { plain?: boolean; verbose?: boolean }): Promise<void> {
  if (options) {
    logger.setPlain(!!options.plain);
    logger.setVerbose(!!options.verbose);
  }

  const cwd = process.cwd();
  const config = loadConfig(findConfigFile(cwd) || undefined);
  const lastBuildPath = path.join(cwd, LAST_BUILD_FILE);

  let lastBuild: LastBuildRecord | null = null;
  if (fs.existsSync(lastBuildPath)) {
    try {
      const content = fs.readFileSync(lastBuildPath, 'utf8');
      lastBuild = JSON.parse(content);
    } catch (err: any) {
      logger.warn(`Could not read ${LAST_BUILD_FILE}: ${err.message}`);
    }
  }

  const gitStatus = await gitClient.getGitStatus(cwd);

  if (!lastBuild) {
    logger.info('No recorded local builds found in .cloudipa/last-build.json.');

    // Attempt to query latest remote run
    if (gitStatus.isRepo) {
      try {
        const runs = await ghClient.listWorkflowRuns(config.github.workflow, 1, cwd);
        if (runs.length > 0) {
          const run = runs[0];
          logger.raw('\nLatest Remote Workflow Run:');
          logger.table({
            'Run ID': `#${run.databaseId}`,
            'Title': run.displayTitle,
            'Status': run.status,
            'Conclusion': run.conclusion || 'pending',
            'Created At': run.createdAt,
            'URL': run.url,
          });
          return;
        }
      } catch {
        // ignore
      }
    }
    logger.raw('Run "cloudipa build" to trigger a new iOS compilation.');
    return;
  }

  // Attempt to refresh live run details if gh is available
  let liveStatus = lastBuild.status;
  let liveConclusion = lastBuild.conclusion;

  try {
    const ghInstalled = await ghClient.isGhInstalled();
    if (ghInstalled && lastBuild.runId) {
      const details = await ghClient.getRunDetails(lastBuild.runId, cwd);
      liveStatus = details.status;
      liveConclusion = details.conclusion;
    }
  } catch {
    // fallback to recorded values
  }

  logger.raw('\nCloudIPA Build Status\n=====================');
  logger.table({
    'Request ID': lastBuild.requestId,
    'GitHub Run ID': `#${lastBuild.runId}`,
    'Repository': gitStatus.repoOwner && gitStatus.repoName ? `${gitStatus.repoOwner}/${gitStatus.repoName}` : 'Local',
    'Branch': lastBuild.branch,
    'Status': liveStatus,
    'Conclusion': liveConclusion || 'in_progress',
    'Built At': lastBuild.timestamp,
    'Artifact File': lastBuild.outputFile || 'None',
    'SHA-256': lastBuild.sha256 || 'None',
    'Workflow URL': lastBuild.url,
  });
  logger.raw('');
}
