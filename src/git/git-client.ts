import { runCommand, checkBinaryAvailable } from '../utils/exec';
import { GitStatus } from '../types';

export class GitClient {
  public async isGitInstalled(): Promise<boolean> {
    return checkBinaryAvailable('git');
  }

  public async getRepoRoot(cwd: string = process.cwd()): Promise<string> {
    const res = await runCommand('git', ['rev-parse', '--show-toplevel'], { cwd });
    if (res.exitCode === 0 && res.stdout.trim()) {
      return res.stdout.trim();
    }
    return cwd;
  }

  public async getGitStatus(cwd: string = process.cwd()): Promise<GitStatus> {
    const isRepoRes = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
    if (isRepoRes.exitCode !== 0 || isRepoRes.stdout.trim() !== 'true') {
      return {
        isRepo: false,
        currentBranch: '',
        hasRemoteBranch: false,
        hasUncommitted: false,
        unpushedCommitCount: 0,
      };
    }

    const repoRoot = await this.getRepoRoot(cwd);

    // Current branch
    const branchRes = await runCommand('git', ['branch', '--show-current'], { cwd });
    let currentBranch = branchRes.stdout.trim();
    if (!currentBranch) {
      const headRes = await runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
      currentBranch = headRes.stdout.trim();
    }

    // Remote origin
    const remoteRes = await runCommand('git', ['config', '--get', 'remote.origin.url'], { cwd });
    const remoteOriginUrl = remoteRes.stdout.trim() || undefined;

    let repoOwner: string | undefined;
    let repoName: string | undefined;

    if (remoteOriginUrl) {
      const parsed = this.parseGitHubUrl(remoteOriginUrl);
      if (parsed) {
        repoOwner = parsed.owner;
        repoName = parsed.repo;
      }
    }

    // Uncommitted changes
    const statusRes = await runCommand('git', ['status', '--porcelain'], { cwd });
    const hasUncommitted = statusRes.stdout.trim().length > 0;

    // Remote branch tracking & unpushed commits
    let unpushedCommitCount = 0;
    let hasRemoteBranch = false;

    const upstreamCheck = await runCommand('git', ['rev-parse', '--verify', '@{u}'], { cwd });
    if (upstreamCheck.exitCode === 0) {
      hasRemoteBranch = true;
      const revListRes = await runCommand('git', ['rev-list', '--count', '@{u}..HEAD'], { cwd });
      const count = parseInt(revListRes.stdout.trim(), 10);
      if (!isNaN(count)) {
        unpushedCommitCount = count;
      }
    } else if (currentBranch) {
      // Check if branch exists on remote despite missing local tracking
      const lsRemoteRes = await runCommand('git', ['ls-remote', '--exit-code', '--heads', 'origin', currentBranch], { cwd });
      if (lsRemoteRes.exitCode === 0) {
        hasRemoteBranch = true;
        const revListRes = await runCommand('git', ['rev-list', '--count', `origin/${currentBranch}..HEAD`], { cwd });
        const count = parseInt(revListRes.stdout.trim(), 10);
        if (!isNaN(count)) {
          unpushedCommitCount = count;
        }
      } else {
        hasRemoteBranch = false;
      }
    }

    return {
      isRepo: true,
      repoRoot,
      currentBranch,
      remoteOriginUrl,
      hasRemoteBranch,
      hasUncommitted,
      unpushedCommitCount,
      repoOwner,
      repoName,
    };
  }

  public parseGitHubUrl(url: string): { owner: string; repo: string } | null {
    // Matches https://github.com/owner/repo.name(.git) and git@github.com:owner/repo.name(.git)
    const httpsRegex = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i;
    const match = url.match(httpsRegex);
    if (match) {
      return {
        owner: match[1],
        repo: match[2],
      };
    }
    return null;
  }

  public async verifyReadiness(cwd: string = process.cwd(), allowDirtyRemote: boolean = false): Promise<GitStatus> {
    const status = await this.getGitStatus(cwd);

    if (!status.isRepo) {
      throw new Error(
        'The current directory is not inside a Git repository. ' +
        'CloudIPA requires a Git repository linked to GitHub to dispatch remote builds.'
      );
    }

    if (!status.remoteOriginUrl) {
      throw new Error(
        'No Git remote "origin" found. CloudIPA dispatches builds on GitHub Actions and requires ' +
        'a remote origin pointing to your GitHub repository (e.g. git remote add origin https://github.com/user/repo.git).'
      );
    }

    if (!status.repoOwner || !status.repoName) {
      throw new Error(
        `Remote origin URL "${status.remoteOriginUrl}" does not appear to be a GitHub repository. ` +
        `CloudIPA uses GitHub-hosted macOS runners via GitHub Actions.`
      );
    }

    if (!allowDirtyRemote) {
      const issues: string[] = [];

      if (!status.hasRemoteBranch) {
        issues.push(`Remote branch "${status.currentBranch}" does not exist on origin. Push it first with: git push -u origin ${status.currentBranch}`);
      }

      if (status.hasUncommitted) {
        issues.push('You have uncommitted local changes (`git status --porcelain`).');
      }
      if (status.unpushedCommitCount > 0) {
        issues.push(`You have ${status.unpushedCommitCount} unpushed local commit(s) ahead of origin/${status.currentBranch}.`);
      }

      if (issues.length > 0) {
        throw new Error(
          `Local Git repository is out of sync with remote origin:\n` +
          issues.map((i) => ` - ${i}`).join('\n') +
          `\n\nCloudIPA builds code from the remote GitHub branch (${status.currentBranch}). ` +
          `Please commit and push your changes, or pass --allow-dirty-remote to force building the current remote ref.`
        );
      }
    }

    return status;
  }

  /**
   * Documented stub for temporary snapshot branch uploads (--upload-local).
   * In a future release, this will create a detached commit and push it to a temporary ref
   * like `refs/heads/cloudipa-temp-<request_id>` without modifying current branch history.
   */
  public async uploadLocalSnapshotStub(requestId: string): Promise<string> {
    throw new Error(
      `--upload-local is planned for a future release. ` +
      `Snapshot ref creation for request ${requestId} is not yet enabled. ` +
      `Please commit and push your work to your remote branch.`
    );
  }
}

export const gitClient = new GitClient();
