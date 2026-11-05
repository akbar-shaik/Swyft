import { GitHubClient, ghClient } from './gh-client';
import { WorkflowRun } from '../types';

export interface PollerOptions {
  workflow: string;
  requestId: string;
  cwd?: string;
  baseIntervalMs?: number; // default 10000 ms
  maxTimeoutMs?: number; // default 25 * 60 * 1000 ms
  sleeper?: (ms: number) => Promise<void>;
  onProgress?: (info: {
    state: 'finding_run' | 'queued' | 'in_progress' | 'completed' | 'backoff';
    run?: WorkflowRun;
    elapsedSeconds: number;
    message: string;
  }) => void;
}

const defaultSleeper = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RunPoller {
  private client: GitHubClient;

  constructor(client: GitHubClient = ghClient) {
    this.client = client;
  }

  public async pollUntilCompletion(options: PollerOptions): Promise<WorkflowRun> {
    const {
      workflow,
      requestId,
      cwd = process.cwd(),
      baseIntervalMs = 10000,
      maxTimeoutMs = 25 * 60 * 1000,
      sleeper = defaultSleeper,
      onProgress,
    } = options;

    const startTime = Date.now();
    let currentInterval = baseIntervalMs;
    let targetRun: WorkflowRun | null = null;

    while (Date.now() - startTime < maxTimeoutMs) {
      const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);

      try {
        if (!targetRun) {
          // 1. Correlate run via request_id in displayTitle
          if (onProgress) {
            onProgress({
              state: 'finding_run',
              elapsedSeconds,
              message: `Waiting for GitHub Actions runner to register build [${requestId}]...`,
            });
          }

          const runs = await this.client.listWorkflowRuns(workflow, 10, cwd);
          const matched = runs.find((r) => r.displayTitle && r.displayTitle.includes(`[${requestId}]`));

          if (matched) {
            targetRun = matched;
          }
        } else {
          // 2. Track correlated run by databaseId
          targetRun = await this.client.getRunDetails(targetRun.databaseId, cwd);

          const status = targetRun.status;
          const conclusion = targetRun.conclusion;

          if (status === 'completed') {
            if (onProgress) {
              onProgress({
                state: 'completed',
                run: targetRun,
                elapsedSeconds,
                message: `Remote build completed with status: ${conclusion || 'unknown'}.`,
              });
            }
            return targetRun;
          }

          if (status === 'queued' || status === 'waiting') {
            if (onProgress) {
              onProgress({
                state: 'queued',
                run: targetRun,
                elapsedSeconds,
                message: `Run #${targetRun.databaseId} is queued waiting for an available macOS runner...`,
              });
            }
          } else {
            if (onProgress) {
              onProgress({
                state: 'in_progress',
                run: targetRun,
                elapsedSeconds,
                message: `Compiling unsigned IPA on macOS runner (Run #${targetRun.databaseId})...`,
              });
            }
          }
        }

        // Reset interval to base on successful poll
        currentInterval = baseIntervalMs;
      } catch (err: any) {
        // Exponential backoff with ceiling of 60 seconds on rate limits or errors
        currentInterval = Math.min(currentInterval * 1.5, 60000);
        if (onProgress) {
          onProgress({
            state: 'backoff',
            run: targetRun || undefined,
            elapsedSeconds,
            message: `Polling backed off (${err.message || 'Rate limit / network'}). Next retry in ${Math.round(currentInterval / 1000)}s...`,
          });
        }
      }

      // Add jitter (0-2000ms) to prevent synchronized bursts
      const jitter = Math.floor(Math.random() * 2000);
      const waitTime = currentInterval + jitter;

      await sleeper(waitTime);
    }

    throw new Error(
      `Timed out after ${Math.round(maxTimeoutMs / 60000)} minutes waiting for build run [${requestId}] to complete.`
    );
  }
}

export const runPoller = new RunPoller();
