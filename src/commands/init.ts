import fs from 'fs';
import path from 'path';
import { gitClient } from '../git/git-client';
import { ghClient } from '../github/gh-client';
import { iosDetector } from '../detectors/ios-detector';
import { saveConfig, CONFIG_FILE_NAME } from '../config/loader';
import { DEFAULT_CONFIG } from '../config/schema';
import { logger } from '../utils/logger';
import { CloudIPAConfig } from '../types';

export async function runInit(options?: { plain?: boolean; verbose?: boolean }): Promise<void> {
  if (options) {
    logger.setPlain(!!options.plain);
    logger.setVerbose(!!options.verbose);
  }

  logger.info('Initializing CloudIPA configuration and GitHub Actions workflow...');
  const cwd = process.cwd();

  // 1. Verify Git repo
  const gitStatus = await gitClient.getGitStatus(cwd);
  if (!gitStatus.isRepo) {
    logger.warn('Current directory is not a Git repository. Initializing new repository...');
  }

  // 2. Check gh auth status
  const ghInstalled = await ghClient.isGhInstalled();
  if (ghInstalled) {
    const auth = await ghClient.checkAuth();
    if (auth.authenticated) {
      logger.success('GitHub CLI is authenticated.');
    } else {
      logger.warn('GitHub CLI is not authenticated. Remember to run "gh auth login".');
    }
  } else {
    logger.warn('GitHub CLI (gh) is not installed. You will need "gh" to dispatch builds.');
  }

  // 3. Inspect local iOS project to generate smart defaults
  const config: CloudIPAConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  try {
    const detected = await iosDetector.inspect(cwd);
    logger.success(`Detected iOS project: ${detected.projectFile || detected.workspaceFile || 'iOS Root'}`);

    if (detected.workspaceFile) {
      config.project.workspace = detected.workspaceFile;
    }
    if (detected.projectFile) {
      config.project.project = detected.projectFile;
    }
    if (detected.schemes.length > 0) {
      config.project.scheme = detected.schemes[0];
      logger.info(`Using default scheme: "${config.project.scheme}" (available: ${detected.schemes.join(', ')})`);
    }

    const baseName = config.project.scheme || 'App';
    config.output.filename = `${baseName}.unsigned.ipa`;
  } catch (err: any) {
    logger.info(`No active iOS project auto-detected at root: ${err.message}. Using default configuration.`);
  }

  if (gitStatus.currentBranch) {
    config.github.branch = gitStatus.currentBranch;
  }

  // 4. Write .cloudipa.yml
  const configPath = path.join(cwd, CONFIG_FILE_NAME);
  if (fs.existsSync(configPath)) {
    logger.info(`${CONFIG_FILE_NAME} already exists. Leaving existing config unchanged.`);
  } else {
    saveConfig(configPath, config);
    logger.success(`Created configuration file: ${CONFIG_FILE_NAME}`);
  }

  // 5. Copy Workflow Template to .github/workflows/cloudipa-build.yml
  const workflowsDir = path.join(cwd, '.github', 'workflows');
  if (!fs.existsSync(workflowsDir)) {
    fs.mkdirSync(workflowsDir, { recursive: true });
  }

  const targetWorkflow = path.join(workflowsDir, 'cloudipa-build.yml');
  // Locate template file (either in dev dist/../templates or installed location)
  let templatePath = path.resolve(__dirname, '../../templates/cloudipa-build.yml');
  if (!fs.existsSync(templatePath)) {
    templatePath = path.resolve(__dirname, '../templates/cloudipa-build.yml');
  }

  if (fs.existsSync(templatePath)) {
    const templateContent = fs.readFileSync(templatePath, 'utf8');
    fs.writeFileSync(targetWorkflow, templateContent, 'utf8');
    logger.success(`Installed GitHub Actions workflow: .github/workflows/cloudipa-build.yml`);
  } else {
    throw new Error(`CloudIPA workflow template not found at: ${templatePath}`);
  }

  // 6. Update .gitignore to exclude .cloudipa/ and build/
  const gitignorePath = path.join(cwd, '.gitignore');
  let gitignoreContent = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const additions: string[] = [];

  if (!gitignoreContent.includes('.cloudipa')) {
    additions.push('.cloudipa/');
  }
  if (!gitignoreContent.includes('build/') && !gitignoreContent.includes('./build')) {
    additions.push('build/');
  }

  if (additions.length > 0) {
    const newContent = (gitignoreContent ? gitignoreContent.trimEnd() + '\n' : '') +
      '# CloudIPA\n' +
      additions.join('\n') +
      '\n';
    fs.writeFileSync(gitignorePath, newContent, 'utf8');
    logger.success(`Updated .gitignore with ${additions.join(', ')}`);
  }

  // 7. Output commit and push guidance
  const branch = gitStatus.currentBranch || 'main';
  logger.raw('\nInitialization complete! To activate CloudIPA in your repository:');
  logger.raw('------------------------------------------------------------');
  logger.raw(`  git add .cloudipa.yml .github/workflows/cloudipa-build.yml .gitignore`);
  logger.raw(`  git commit -m "ci: add CloudIPA remote iOS build workflow"`);
  logger.raw(`  git push origin ${branch}`);
  logger.raw('------------------------------------------------------------');
  logger.raw(`Then run "cloudipa build" to trigger your first cloud compilation.\n`);
}
