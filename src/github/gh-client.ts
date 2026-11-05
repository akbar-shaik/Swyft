import { runCommand, checkBinaryAvailable } from '../utils/exec';
import { WorkflowRun } from '../types';

export class GitHubClient {
  public async isGhInstalled(): Promise<boolean> {
    return checkBinaryAvailable('gh');
  }

  public async checkAuth(): Promise<{ authenticated: boolean; message: string }> {
    const res = await runCommand('gh', ['auth', 'status']);
    if (res.exitCode === 0) {
      return {
        authenticated: true,
        message: res.stdout.trim() || res.stderr.trim() || 'Logged in to GitHub',
      };
    }
    return {
      authenticated: false,
      message: res.stderr.trim() || res.stdout.trim() || 'Not authenticated with GitHub CLI',
    };
  }

  public async triggerWorkflow(
    workflow: string,
    ref: string,
    inputs: Record<string, string>,
    cwd: string = process.cwd()
  ): Promise<void> {
    const args: string[] = ['workflow', 'run', workflow, '--ref', ref];

    for (const [key, value] of Object.entries(inputs)) {
      if (value !== undefined && value !== null) {
        args.push('-f', `${key}=${value}`);
      }
    }

    const res = await runCommand('gh', args, { cwd });
    if (res.exitCode !== 0) {
      throw new Error(`Failed to dispatch GitHub Actions workflow:\n${res.stderr || res.stdout}`);
    }
  }

  public async listWorkflowRuns(
    workflow: string,
    limit: number = 10,
    cwd: string = process.cwd()
  ): Promise<WorkflowRun[]> {
    const args = [
      'run',
      'list',
      '--workflow',
      workflow,
      '--limit',
      String(limit),
      '--json',
      'databaseId,displayTitle,status,conclusion,url,createdAt',
    ];

    const res = await runCommand('gh', args, { cwd });
    if (res.exitCode !== 0) {
      throw new Error(`Failed to list GitHub Actions workflow runs:\n${res.stderr || res.stdout}`);
    }

    try {
      const data = JSON.parse(res.stdout);
      if (Array.isArray(data)) {
        return data as WorkflowRun[];
      }
      return [];
    } catch (err: any) {
      throw new Error(`Failed to parse workflow run list JSON from GitHub CLI: ${err.message}`);
    }
  }

  public async getRunDetails(runId: number, cwd: string = process.cwd()): Promise<WorkflowRun> {
    const args = [
      'run',
      'view',
      String(runId),
      '--json',
      'databaseId,displayTitle,status,conclusion,url,createdAt',
    ];

    const res = await runCommand('gh', args, { cwd });
    if (res.exitCode !== 0) {
      throw new Error(`Failed to get run details for #${runId}:\n${res.stderr || res.stdout}`);
    }

    try {
      return JSON.parse(res.stdout) as WorkflowRun;
    } catch (err: any) {
      throw new Error(`Failed to parse run details JSON for #${runId}: ${err.message}`);
    }
  }

  public async getRunLogs(runId: number, cwd: string = process.cwd()): Promise<string> {
    const args = ['run', 'view', String(runId), '--log'];
    const res = await runCommand('gh', args, { cwd });
    if (res.exitCode !== 0) {
      throw new Error(`Failed to fetch logs for run #${runId}:\n${res.stderr || res.stdout}`);
    }
    return res.stdout || res.stderr;
  }

  public async downloadArtifact(
    runId: number,
    artifactName: string,
    outputDir: string,
    cwd: string = process.cwd()
  ): Promise<void> {
    const args = ['run', 'download', String(runId)];
    if (artifactName && artifactName.trim()) {
      args.push('-n', artifactName.trim());
    }
    args.push('--dir', outputDir);

    const res = await runCommand('gh', args, { cwd });
    if (res.exitCode !== 0) {
      throw new Error(
        `Failed to download artifact${artifactName ? ` "${artifactName}"` : ''} for run #${runId}:\n${res.stderr || res.stdout}`
      );
    }
  }
}

export const ghClient = new GitHubClient();
