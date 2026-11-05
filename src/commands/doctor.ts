import fs from 'fs';
import path from 'path';
import { runCommand, checkBinaryAvailable } from '../utils/exec';
import { gitClient } from '../git/git-client';
import { ghClient } from '../github/gh-client';
import { logger } from '../utils/logger';
import { DoctorCheckResult } from '../types';

export async function runDoctor(options?: { plain?: boolean; verbose?: boolean }): Promise<boolean> {
  if (options) {
    logger.setPlain(!!options.plain);
    logger.setVerbose(!!options.verbose);
  }

  logger.raw('\nCloudIPA Environment & Integration Diagnostics\n==============================================');

  const results: DoctorCheckResult[] = [];
  const cwd = process.cwd();

  // 1. Node.js Version Check
  const nodeVersionStr = process.version; // e.g. v20.10.0
  const majorNode = parseInt(nodeVersionStr.replace(/^v/, '').split('.')[0], 10);
  if (majorNode >= 18) {
    results.push({
      id: 'node-version',
      title: 'Node.js Version',
      status: 'PASS',
      message: `${nodeVersionStr} (meets requirement >= 18)`,
    });
  } else {
    results.push({
      id: 'node-version',
      title: 'Node.js Version',
      status: 'FAIL',
      message: `${nodeVersionStr} is unsupported. Node.js >= 18 required.`,
      fix: 'Upgrade Node.js to v18, v20, or v22 from https://nodejs.org',
    });
  }

  // 2. Git binary
  const gitInstalled = await gitClient.isGitInstalled();
  if (gitInstalled) {
    const v = await runCommand('git', ['--version']);
    results.push({
      id: 'git-installed',
      title: 'Git CLI Binary',
      status: 'PASS',
      message: v.stdout.trim() || 'Git installed',
    });
  } else {
    results.push({
      id: 'git-installed',
      title: 'Git CLI Binary',
      status: 'FAIL',
      message: 'git was not found in PATH.',
      fix: 'Install Git from https://git-scm.com/downloads',
    });
  }

  // 3. GitHub CLI (gh)
  const ghInstalled = await ghClient.isGhInstalled();
  if (ghInstalled) {
    const v = await runCommand('gh', ['--version']);
    const firstLine = v.stdout.split('\n')[0].trim();
    results.push({
      id: 'gh-installed',
      title: 'GitHub CLI (gh)',
      status: 'PASS',
      message: firstLine || 'GitHub CLI installed',
    });
  } else {
    results.push({
      id: 'gh-installed',
      title: 'GitHub CLI (gh)',
      status: 'FAIL',
      message: 'gh was not found in PATH.',
      fix: 'Install GitHub CLI from https://cli.github.com (e.g. winget install GitHub.cli, brew install gh, apt install gh)',
    });
  }

  // 4. GitHub CLI Authentication
  if (ghInstalled) {
    const authStatus = await ghClient.checkAuth();
    if (authStatus.authenticated) {
      results.push({
        id: 'gh-auth',
        title: 'GitHub CLI Authentication',
        status: 'PASS',
        message: 'Authenticated with GitHub',
      });
    } else {
      results.push({
        id: 'gh-auth',
        title: 'GitHub CLI Authentication',
        status: 'FAIL',
        message: 'GitHub CLI is not authenticated.',
        fix: 'Run "gh auth login" to authenticate your GitHub account.',
      });
    }
  } else {
    results.push({
      id: 'gh-auth',
      title: 'GitHub CLI Authentication',
      status: 'FAIL',
      message: 'Skipped (gh is not installed).',
      fix: 'Install gh and run "gh auth login".',
    });
  }

  // 5. Git Repository Check
  const gitStatus = await gitClient.getGitStatus(cwd);
  if (gitStatus.isRepo) {
    results.push({
      id: 'git-repo',
      title: 'Git Repository Status',
      status: 'PASS',
      message: `Inside Git repository (branch: ${gitStatus.currentBranch || 'HEAD'})`,
    });
  } else {
    results.push({
      id: 'git-repo',
      title: 'Git Repository Status',
      status: 'FAIL',
      message: 'Current working directory is not a Git repository.',
      fix: 'Run "git init" and connect your repository to GitHub.',
    });
  }

  // 6. Remote Origin Check
  if (gitStatus.isRepo) {
    if (gitStatus.remoteOriginUrl && gitStatus.repoOwner && gitStatus.repoName) {
      results.push({
        id: 'git-remote',
        title: 'Git Remote Origin',
        status: 'PASS',
        message: `${gitStatus.repoOwner}/${gitStatus.repoName} (${gitStatus.remoteOriginUrl})`,
      });
    } else if (gitStatus.remoteOriginUrl) {
      results.push({
        id: 'git-remote',
        title: 'Git Remote Origin',
        status: 'WARN',
        message: `Remote origin "${gitStatus.remoteOriginUrl}" is not recognized as a GitHub URL.`,
        fix: 'Configure remote to point to GitHub (git remote set-url origin https://github.com/owner/repo.git)',
      });
    } else {
      results.push({
        id: 'git-remote',
        title: 'Git Remote Origin',
        status: 'FAIL',
        message: 'No "origin" remote found.',
        fix: 'Add your GitHub repository remote: git remote add origin https://github.com/owner/repo.git',
      });
    }
  } else {
    results.push({
      id: 'git-remote',
      title: 'Git Remote Origin',
      status: 'FAIL',
      message: 'Skipped (not a Git repo).',
    });
  }

  // 7. Workflow File Check
  const workflowPath = path.join(cwd, '.github', 'workflows', 'cloudipa-build.yml');
  if (fs.existsSync(workflowPath)) {
    results.push({
      id: 'workflow-file',
      title: 'CloudIPA Workflow Template',
      status: 'PASS',
      message: '.github/workflows/cloudipa-build.yml exists',
    });
  } else {
    results.push({
      id: 'workflow-file',
      title: 'CloudIPA Workflow Template',
      status: 'WARN',
      message: 'Workflow file .github/workflows/cloudipa-build.yml not found in repository.',
      fix: 'Run "cloudipa init" to generate and commit the GitHub Actions build workflow.',
    });
  }

  // 8. Remote Repository Access & Permissions
  if (ghInstalled && gitStatus.isRepo && gitStatus.repoOwner && gitStatus.repoName) {
    const repoViewRes = await runCommand('gh', ['repo', 'view', `${gitStatus.repoOwner}/${gitStatus.repoName}`, '--json', 'viewerPermission'], { cwd });
    if (repoViewRes.exitCode === 0) {
      try {
        const repoData = JSON.parse(repoViewRes.stdout);
        const perm = repoData.viewerPermission || 'READ';
        results.push({
          id: 'repo-permissions',
          title: 'GitHub Repo Permissions',
          status: 'PASS',
          message: `Access confirmed to ${gitStatus.repoOwner}/${gitStatus.repoName} (Permission: ${perm})`,
        });
      } catch {
        results.push({
          id: 'repo-permissions',
          title: 'GitHub Repo Permissions',
          status: 'PASS',
          message: `Access confirmed to ${gitStatus.repoOwner}/${gitStatus.repoName}`,
        });
      }
    } else {
      results.push({
        id: 'repo-permissions',
        title: 'GitHub Repo Permissions',
        status: 'WARN',
        message: `Could not verify access to remote repo: ${repoViewRes.stderr.trim() || 'Permission denied'}`,
        fix: 'Ensure your GitHub token has "repo" and "workflow" scopes.',
      });
    }
  } else {
    results.push({
      id: 'repo-permissions',
      title: 'GitHub Repo Permissions',
      status: 'WARN',
      message: 'Skipped (requires authenticated gh and GitHub remote).',
    });
  }

  // Print results
  let allPass = true;
  for (const res of results) {
    if (res.status === 'PASS') {
      logger.success(`[PASS] ${res.title}: ${res.message}`);
    } else if (res.status === 'WARN') {
      logger.warn(`[WARN] ${res.title}: ${res.message}`);
      if (res.fix) {
        logger.raw(`       ↳ Fix: ${res.fix}`);
      }
    } else {
      allPass = false;
      logger.error(`[FAIL] ${res.title}: ${res.message}`);
      if (res.fix) {
        logger.raw(`       ↳ Fix: ${res.fix}`);
      }
    }
  }

  logger.raw('\n----------------------------------------------');
  if (allPass) {
    logger.success('All required checks passed! CloudIPA is ready to compile iOS projects.');
  } else {
    logger.error('One or more checks failed. Please address the actionable fixes above.');
  }

  return allPass;
}
