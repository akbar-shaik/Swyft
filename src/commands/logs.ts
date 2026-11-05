import fs from 'fs';
import path from 'path';
import { LAST_BUILD_FILE } from './build';
import { ghClient } from '../github/gh-client';
import { logger } from '../utils/logger';
import { LastBuildRecord } from '../types';

export async function runLogs(runIdArg?: string, options?: { plain?: boolean; verbose?: boolean }): Promise<void> {
  if (options) {
    logger.setPlain(!!options.plain);
    logger.setVerbose(!!options.verbose);
  }

  const cwd = process.cwd();
  let targetRunId: number | null = null;

  if (runIdArg) {
    targetRunId = parseInt(runIdArg, 10);
    if (isNaN(targetRunId)) {
      throw new Error(`Invalid run ID: "${runIdArg}". Expected numeric GitHub run ID.`);
    }
  } else {
    const lastBuildPath = path.join(cwd, LAST_BUILD_FILE);
    if (fs.existsSync(lastBuildPath)) {
      try {
        const lastBuild: LastBuildRecord = JSON.parse(fs.readFileSync(lastBuildPath, 'utf8'));
        targetRunId = lastBuild.runId;
      } catch (err: any) {
        logger.warn(`Could not read ${LAST_BUILD_FILE}: ${err.message}`);
      }
    }
  }

  if (!targetRunId) {
    // Fallback: list latest run
    try {
      const runs = await ghClient.listWorkflowRuns('cloudipa-build.yml', 1, cwd);
      if (runs.length > 0) {
        targetRunId = runs[0].databaseId;
      }
    } catch {
      // ignore
    }
  }

  if (!targetRunId) {
    throw new Error('No build run ID found. Provide a run ID or trigger a build with "cloudipa build".');
  }

  logger.info(`Fetching logs for GitHub Actions Run #${targetRunId}...`);
  const logs = await ghClient.getRunLogs(targetRunId, cwd);
  logger.raw('\n--- BEGIN WORKFLOW LOGS ---');
  logger.raw(logs);
  logger.raw('--- END WORKFLOW LOGS ---\n');
}
