import { Command } from 'commander';
import { runInit } from './commands/init';
import { runBuild } from './commands/build';
import { runStatus } from './commands/status';
import { runLogs } from './commands/logs';
import { runDownload } from './commands/download';
import { runDoctor } from './commands/doctor';
import { logger } from './utils/logger';

export function createCli(): Command {
  const program = new Command();

  program
    .name('cloudipa')
    .description('Cross-platform CLI tool to compile iOS projects into unsigned .ipa packages using GitHub-hosted macOS runners')
    .version('1.0.0')
    .option('--plain', 'Disable colors and spinners for plain output')
    .option('--verbose', 'Enable verbose debug logging')
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts();
      if (opts.plain) logger.setPlain(true);
      if (opts.verbose) logger.setVerbose(true);
    });

  // init
  program
    .command('init')
    .description('Initialize CloudIPA configuration (.cloudipa.yml) and install GitHub Actions workflow template')
    .action(async () => {
      try {
        await runInit(program.opts());
      } catch (err: any) {
        logger.error(err.message || String(err));
        process.exit(1);
      }
    });

  // build
  program
    .command('build [path]')
    .description('Build an unsigned iOS .ipa package via GitHub-hosted macOS runner')
    .option('-s, --scheme <scheme>', 'Xcode scheme to compile')
    .option('-c, --configuration <config>', 'Build configuration (Release or Debug)', 'Release')
    .option('-r, --runner <runner>', 'GitHub-hosted runner label (e.g. macos-15, macos-14)', 'macos-15')
    .option('-o, --output <path>', 'Output directory or IPA file path')
    .option('--ref <branch>', 'Git branch or tag to build on remote')
    .option('--xcode <version>', 'Xcode version to select on runner (e.g. 16.0, 15.4, auto)', 'auto')
    .option('-t, --timeout <minutes>', 'Build timeout in minutes (default: 25)', (val) => parseInt(val, 10), 25)
    .option('--allow-dirty-remote', 'Allow building remote ref despite uncommitted or unpushed local changes')
    .option('--no-wait', 'Dispatch workflow and exit immediately without polling')
    .option('--upload-local', 'Upload local working directory as a temporary snapshot ref (future release)')
    .action(async (projectPath, cmdOpts) => {
      try {
        const globalOpts = program.opts();
        await runBuild(projectPath, {
          ...cmdOpts,
          plain: globalOpts.plain,
          verbose: globalOpts.verbose,
        });
      } catch (err: any) {
        logger.error(err.message || String(err));
        process.exit(1);
      }
    });

  // status
  program
    .command('status')
    .description('View status and details of the latest CloudIPA build')
    .action(async () => {
      try {
        await runStatus(program.opts());
      } catch (err: any) {
        logger.error(err.message || String(err));
        process.exit(1);
      }
    });

  // logs
  program
    .command('logs [runId]')
    .description('Stream or inspect execution logs for the latest build run')
    .action(async (runId) => {
      try {
        await runLogs(runId, program.opts());
      } catch (err: any) {
        logger.error(err.message || String(err));
        process.exit(1);
      }
    });

  // download
  program
    .command('download [runId]')
    .description('Download and verify the unsigned IPA artifact from a successful build')
    .option('-o, --output <path>', 'Destination output directory or file path')
    .action(async (runId, cmdOpts) => {
      try {
        const globalOpts = program.opts();
        await runDownload(runId, {
          output: cmdOpts.output,
          plain: globalOpts.plain,
          verbose: globalOpts.verbose,
        });
      } catch (err: any) {
        logger.error(err.message || String(err));
        process.exit(1);
      }
    });

  // doctor
  program
    .command('doctor')
    .description('Run 8-point environment diagnostics and verify GitHub CLI integration')
    .action(async () => {
      try {
        const pass = await runDoctor(program.opts());
        if (!pass) {
          process.exit(1);
        }
      } catch (err: any) {
        logger.error(err.message || String(err));
        process.exit(1);
      }
    });

  return program;
}

// Auto-run if executed directly as main script
if (require.main === module) {
  const cli = createCli();
  cli.parse(process.argv);
}
