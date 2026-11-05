import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { gitClient } from '../src/git/git-client';
import { setCustomExecutor } from '../src/utils/exec';

describe('Git Client & State Validation', () => {
  afterEach(() => {
    setCustomExecutor(null);
  });

  it('correctly parses GitHub HTTPS and SSH remote URLs, including dot-named repositories', () => {
    const httpsParsed = gitClient.parseGitHubUrl('https://github.com/octocat/Hello-World.git');
    expect(httpsParsed).toEqual({ owner: 'octocat', repo: 'Hello-World' });

    const dotRepo = gitClient.parseGitHubUrl('https://github.com/my.org/my.app.repo.git');
    expect(dotRepo).toEqual({ owner: 'my.org', repo: 'my.app.repo' });

    const sshParsed = gitClient.parseGitHubUrl('git@github.com:myorg/ios.app.bundle.git');
    expect(sshParsed).toEqual({ owner: 'myorg', repo: 'ios.app.bundle' });

    const nonGithub = gitClient.parseGitHubUrl('https://gitlab.com/owner/project.git');
    expect(nonGithub).toBeNull();
  });

  it('retrieves the Git repository root directory via rev-parse', async () => {
    setCustomExecutor(async (file, args) => {
      const cmd = `${file} ${args.join(' ')}`;
      if (cmd.includes('rev-parse --show-toplevel')) {
        return { stdout: '/workspace/repo\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const root = await gitClient.getRepoRoot('/workspace/repo/ios');
    expect(root).toBe('/workspace/repo');
  });

  it('detects clean repository state when git status is clean and synced', async () => {
    setCustomExecutor(async (file, args) => {
      const cmd = `${file} ${args.join(' ')}`;
      if (cmd.includes('rev-parse --is-inside-work-tree')) {
        return { stdout: 'true\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('rev-parse --show-toplevel')) {
        return { stdout: '/mock/repo\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('branch --show-current')) {
        return { stdout: 'main\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('config --get remote.origin.url')) {
        return { stdout: 'https://github.com/myorg/ios-app.git\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('status --porcelain')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('rev-parse --verify @{u}')) {
        return { stdout: 'commit-hash\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('rev-list --count @{u}..HEAD')) {
        return { stdout: '0\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const status = await gitClient.verifyReadiness('/mock/repo', false);
    expect(status.isRepo).toBe(true);
    expect(status.currentBranch).toBe('main');
    expect(status.hasRemoteBranch).toBe(true);
    expect(status.hasUncommitted).toBe(false);
    expect(status.unpushedCommitCount).toBe(0);
    expect(status.repoOwner).toBe('myorg');
    expect(status.repoName).toBe('ios-app');
  });

  it('checks remote branch presence via ls-remote when upstream tracking is missing', async () => {
    setCustomExecutor(async (file, args) => {
      const cmd = `${file} ${args.join(' ')}`;
      if (cmd.includes('rev-parse --is-inside-work-tree')) {
        return { stdout: 'true\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('rev-parse --show-toplevel')) {
        return { stdout: '/mock/repo\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('branch --show-current')) {
        return { stdout: 'feat/new\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('config --get remote.origin.url')) {
        return { stdout: 'https://github.com/myorg/ios-app.git\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('status --porcelain')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('rev-parse --verify @{u}')) {
        return { stdout: '', stderr: 'fatal: no upstream', exitCode: 1 };
      }
      if (cmd.includes('ls-remote --exit-code --heads origin feat/new')) {
        return { stdout: '', stderr: 'not found', exitCode: 2 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const status = await gitClient.getGitStatus('/mock/repo');
    expect(status.hasRemoteBranch).toBe(false);

    await expect(gitClient.verifyReadiness('/mock/repo', false)).rejects.toThrow(
      /Remote branch "feat\/new" does not exist on origin/
    );
  });

  it('blocks build when working directory has uncommitted changes without --allow-dirty-remote', async () => {
    setCustomExecutor(async (file, args) => {
      const cmd = `${file} ${args.join(' ')}`;
      if (cmd.includes('rev-parse --is-inside-work-tree')) {
        return { stdout: 'true\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('rev-parse --show-toplevel')) {
        return { stdout: '/mock/repo\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('branch --show-current')) {
        return { stdout: 'main\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('config --get remote.origin.url')) {
        return { stdout: 'https://github.com/myorg/ios-app.git\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('status --porcelain')) {
        return { stdout: ' M src/App.swift\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('rev-parse --verify @{u}')) {
        return { stdout: 'hash\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('rev-list --count @{u}..HEAD')) {
        return { stdout: '0\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await expect(gitClient.verifyReadiness('/mock/repo', false)).rejects.toThrow(
      /uncommitted local changes/
    );

    const allowed = await gitClient.verifyReadiness('/mock/repo', true);
    expect(allowed.hasUncommitted).toBe(true);
  });

  it('blocks build when local branch has unpushed commits ahead of origin', async () => {
    setCustomExecutor(async (file, args) => {
      const cmd = `${file} ${args.join(' ')}`;
      if (cmd.includes('rev-parse --is-inside-work-tree')) {
        return { stdout: 'true\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('rev-parse --show-toplevel')) {
        return { stdout: '/mock/repo\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('branch --show-current')) {
        return { stdout: 'feature-x\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('config --get remote.origin.url')) {
        return { stdout: 'https://github.com/myorg/ios-app.git\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('status --porcelain')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('rev-parse --verify @{u}')) {
        return { stdout: 'hash\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('rev-list --count @{u}..HEAD')) {
        return { stdout: '3\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await expect(gitClient.verifyReadiness('/mock/repo', false)).rejects.toThrow(
      /3 unpushed local commit\(s\)/
    );
  });
});
