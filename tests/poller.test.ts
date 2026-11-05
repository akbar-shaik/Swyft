import { describe, it, expect, vi } from 'vitest';
import { RunPoller } from '../src/github/poller';
import { GitHubClient } from '../src/github/gh-client';
import { WorkflowRun } from '../src/types';

describe('Workflow Run Poller (Polite Polling & Correlation)', () => {
  it('correlates run by request_id and polls until completion', async () => {
    let listCalls = 0;
    let detailCalls = 0;
    const mockClient = {
      listWorkflowRuns: vi.fn().mockImplementation(async () => {
        listCalls++;
        if (listCalls === 1) {
          // First check: run not yet registered by GitHub Actions
          return [];
        }
        // Second check: run registered
        return [
          {
            databaseId: 555,
            displayTitle: 'CloudIPA Build [uuid-999] (Release)',
            status: 'queued',
            conclusion: null,
            url: 'https://github.com/runs/555',
            createdAt: '2026-11-05T00:00:00Z',
          },
        ];
      }),
      getRunDetails: vi.fn().mockImplementation(async (id: number) => {
        expect(id).toBe(555);
        detailCalls++;
        if (detailCalls === 1) {
          return {
            databaseId: 555,
            displayTitle: 'CloudIPA Build [uuid-999] (Release)',
            status: 'in_progress',
            conclusion: null,
            url: 'https://github.com/runs/555',
            createdAt: '2026-11-05T00:00:00Z',
          };
        }
        return {
          databaseId: 555,
          displayTitle: 'CloudIPA Build [uuid-999] (Release)',
          status: 'completed',
          conclusion: 'success',
          url: 'https://github.com/runs/555',
          createdAt: '2026-11-05T00:00:00Z',
        };
      }),
    } as unknown as GitHubClient;

    const poller = new RunPoller(mockClient);
    const progressStates: string[] = [];

    const finalRun = await poller.pollUntilCompletion({
      workflow: 'cloudipa-build.yml',
      requestId: 'uuid-999',
      baseIntervalMs: 10,
      maxTimeoutMs: 5000,
      sleeper: async () => {}, // Instant sleeper for testing
      onProgress: (p) => progressStates.push(p.state),
    });

    expect(finalRun.databaseId).toBe(555);
    expect(finalRun.status).toBe('completed');
    expect(finalRun.conclusion).toBe('success');
    expect(progressStates).toContain('finding_run');
    expect(progressStates).toContain('completed');
  });

  it('backs off gracefully on temporary network / rate limit errors', async () => {
    let attempts = 0;
    const mockClient = {
      listWorkflowRuns: vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('Secondary rate limit reached. Please wait.');
        }
        return [
          {
            databaseId: 777,
            displayTitle: 'CloudIPA Build [req-backoff]',
            status: 'completed',
            conclusion: 'success',
            url: 'https://github.com/runs/777',
            createdAt: '2026-11-05T00:00:00Z',
          },
        ];
      }),
      getRunDetails: vi.fn().mockImplementation(async () => ({
        databaseId: 777,
        status: 'completed',
        conclusion: 'success',
      })),
    } as unknown as GitHubClient;

    const poller = new RunPoller(mockClient);
    const progressStates: string[] = [];

    const finalRun = await poller.pollUntilCompletion({
      workflow: 'cloudipa-build.yml',
      requestId: 'req-backoff',
      baseIntervalMs: 5,
      maxTimeoutMs: 2000,
      sleeper: async () => {},
      onProgress: (p) => progressStates.push(p.state),
    });

    expect(finalRun.databaseId).toBe(777);
    expect(progressStates).toContain('backoff');
    expect(progressStates).toContain('completed');
  });

  it('throws a timeout error if the run does not complete within maxTimeoutMs', async () => {
    const mockClient = {
      listWorkflowRuns: vi.fn().mockResolvedValue([]),
    } as unknown as GitHubClient;

    const poller = new RunPoller(mockClient);

    await expect(
      poller.pollUntilCompletion({
        workflow: 'cloudipa-build.yml',
        requestId: 'nonexistent-uuid',
        baseIntervalMs: 5,
        maxTimeoutMs: 20, // 20ms timeout
        sleeper: async () => new Promise((r) => setTimeout(r, 10)),
      })
    ).rejects.toThrow(/Timed out after/);
  });
});
