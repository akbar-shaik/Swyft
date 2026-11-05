import { CloudIPAConfig } from '../types';

export const DEFAULT_CONFIG: CloudIPAConfig = {
  project: {
    path: '.',
    workspace: '',
    project: '',
    scheme: '',
    configuration: 'Release',
  },
  github: {
    workflow: 'cloudipa-build.yml',
    branch: 'main',
  },
  build: {
    runner: 'macos-15',
    xcode_version: 'auto',
    signing: 'disabled',
    destination: 'generic/platform=iOS',
    timeout_minutes: 25,
  },
  output: {
    directory: './build',
    filename: 'MyApp.unsigned.ipa',
  },
};

export function validateAndNormalizeConfig(raw: any): CloudIPAConfig {
  if (!raw || typeof raw !== 'object') {
    return structuredClone(DEFAULT_CONFIG);
  }

  const project = raw.project || {};
  const github = raw.github || {};
  const build = raw.build || {};
  const output = raw.output || {};

  return {
    project: {
      path: typeof project.path === 'string' && project.path ? project.path : DEFAULT_CONFIG.project.path,
      workspace: typeof project.workspace === 'string' ? project.workspace : DEFAULT_CONFIG.project.workspace,
      project: typeof project.project === 'string' ? project.project : DEFAULT_CONFIG.project.project,
      scheme: typeof project.scheme === 'string' ? project.scheme : DEFAULT_CONFIG.project.scheme,
      configuration: typeof project.configuration === 'string' && project.configuration ? project.configuration : DEFAULT_CONFIG.project.configuration,
    },
    github: {
      workflow: typeof github.workflow === 'string' && github.workflow ? github.workflow : DEFAULT_CONFIG.github.workflow,
      branch: typeof github.branch === 'string' && github.branch ? github.branch : DEFAULT_CONFIG.github.branch,
    },
    build: {
      runner: typeof build.runner === 'string' && build.runner ? build.runner : DEFAULT_CONFIG.build.runner,
      xcode_version: typeof build.xcode_version === 'string' && build.xcode_version ? build.xcode_version : DEFAULT_CONFIG.build.xcode_version,
      signing: typeof build.signing === 'string' ? build.signing : DEFAULT_CONFIG.build.signing,
      destination: typeof build.destination === 'string' ? build.destination : DEFAULT_CONFIG.build.destination,
      timeout_minutes: typeof build.timeout_minutes === 'number' && build.timeout_minutes > 0 ? build.timeout_minutes : DEFAULT_CONFIG.build.timeout_minutes,
    },
    output: {
      directory: typeof output.directory === 'string' && output.directory ? output.directory : DEFAULT_CONFIG.output.directory,
      filename: typeof output.filename === 'string' && output.filename ? output.filename : DEFAULT_CONFIG.output.filename,
    },
  };
}
