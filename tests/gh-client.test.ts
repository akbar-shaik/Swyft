import { describe, it, expect, afterEach } from 'vitest';
import { ghClient } from '../src/github/gh-client';
import { setCustomExecutor } from '../src/utils/exec';

describe('GitHub CLI (gh) Client Wrapper', () => {
  afterEach(() => {
    setCustomExecutor(null);
  });

  it('checks auth status correctly', async () => {
    setCustomExecutor(async (file, args) => {
      expect(file).toBe('gh');
      expect(args).toEqual(['auth', 'status']);
      return { stdout: 'Logged in to github.com as testuser\n', stderr: '', exitCode: 0 };
    });

    const auth = await ghClient.checkAuth();
    expect(auth.authenticated).toBe(true);
    expect(auth.message).toContain('Logged in');
  });

  it('reports authentication failure when gh auth status exits with non-zero code', async () => {
    setCustomExecutor(async () => {
      return { stdout: '', stderr: 'You are not logged into any GitHub hosts.\n', exitCode: 1 };
    });

    const auth = await ghClient.checkAuth();
    expect(auth.authenticated).toBe(false);
    expect(auth.message).toContain('not logged into');
  });

  it('triggers workflow with expected inputs and flags', async () => {
    let capturedArgs: string[] = [];
    setCustomExecutor(async (file, args) => {
      capturedArgs = args;
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await ghClient.triggerWorkflow('cloudipa-build.yml', 'main', {
      request_id: 'test-uuid-1234',
      scheme: 'SampleApp',
      runner: 'macos-15',
    });

    expect(capturedArgs).toContain('workflow');
    expect(capturedArgs).toContain('run');
    expect(capturedArgs).toContain('cloudipa-build.yml');
    expect(capturedArgs).toContain('--ref');
    expect(capturedArgs).toContain('main');
    expect(capturedArgs).toContain('-f');
    expect(capturedArgs).toContain('request_id=test-uuid-1234');
    expect(capturedArgs).toContain('scheme=SampleApp');
    expect(capturedArgs).toContain('runner=macos-15');
  });

  it('lists workflow runs and parses JSON output', async () => {
    const mockRuns = [
      {
        databaseId: 101,
        displayTitle: 'CloudIPA Build [req-1]',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/org/repo/actions/runs/101',
        createdAt: '2026-11-05T12:00:00Z',
      },
    ];

    setCustomExecutor(async (file, args) => {
      expect(args).toContain('list');
      return { stdout: JSON.stringify(mockRuns), stderr: '', exitCode: 0 };
    });

    const runs = await ghClient.listWorkflowRuns('cloudipa-build.yml', 5);
    expect(runs).toHaveLength(1);
    expect(runs[0].databaseId).toBe(101);
    expect(runs[0].displayTitle).toContain('[req-1]');
  });

  it('downloads artifact with exact run ID, artifact name, and target directory', async () => {
    let capturedArgs: string[] = [];
    setCustomExecutor(async (file, args) => {
      capturedArgs = args;
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await ghClient.downloadArtifact(101, 'cloudipa-artifact-req-1', './build');
    expect(capturedArgs).toEqual([
      'run',
      'download',
      '101',
      '-n',
      'cloudipa-artifact-req-1',
      '--dir',
      './build',
    ]);
  });

  it('omits -n flag when artifact name is empty or whitespace', async () => {
    let capturedArgs: string[] = [];
    setCustomExecutor(async (file, args) => {
      capturedArgs = args;
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await ghClient.downloadArtifact(102, '', './build');
    expect(capturedArgs).toEqual([
      'run',
      'download',
      '102',
      '--dir',
      './build',
    ]);
    expect(capturedArgs).not.toContain('-n');

    await ghClient.downloadArtifact(103, '   ', './build');
    expect(capturedArgs).toEqual([
      'run',
      'download',
      '103',
      '--dir',
      './build',
    ]);
    expect(capturedArgs).not.toContain('-n');
  });
});
