export interface ProjectConfig {
  path: string;
  workspace?: string;
  project?: string;
  scheme?: string;
  configuration: string;
}

export interface GithubConfig {
  workflow: string;
  branch: string;
}

export interface BuildConfig {
  runner: string;
  xcode_version: string;
  signing: string;
  destination: string;
  timeout_minutes: number;
}

export interface OutputConfig {
  directory: string;
  filename: string;
}

export interface CloudIPAConfig {
  project: ProjectConfig;
  github: GithubConfig;
  build: BuildConfig;
  output: OutputConfig;
}

export interface BuildOptions {
  scheme?: string;
  configuration?: string;
  runner?: string;
  output?: string;
  ref?: string;
  xcode?: string;
  timeout?: number;
  plain?: boolean;
  verbose?: boolean;
  allowDirtyRemote?: boolean;
  wait?: boolean;
  uploadLocal?: boolean;
}

export interface ProjectInfo {
  projectPath: string;
  workspaceFile?: string;
  projectFile?: string;
  schemes: string[];
  bundleIdentifier?: string;
  marketingVersion?: string;
  currentProjectVersion?: string;
}

export interface GitStatus {
  isRepo: boolean;
  currentBranch: string;
  remoteOriginUrl?: string;
  hasUncommitted: boolean;
  unpushedCommitCount: number;
  repoOwner?: string;
  repoName?: string;
}

export interface WorkflowRun {
  databaseId: number;
  displayTitle: string;
  status: string;
  conclusion?: string | null;
  url: string;
  createdAt: string;
}

export interface BuildInfo {
  requestId: string;
  scheme: string;
  configuration: string;
  bundleIdentifier: string;
  displayName: string;
  version: string;
  buildNumber: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  runner: string;
}

export interface LastBuildRecord {
  requestId: string;
  runId: number;
  url: string;
  branch: string;
  commitHash?: string;
  status: string;
  conclusion?: string | null;
  timestamp: string;
  outputFile?: string;
  sha256?: string;
  buildInfo?: BuildInfo;
}

export interface DoctorCheckResult {
  id: string;
  title: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  message: string;
  fix?: string;
}

export interface IpaValidationResult {
  valid: boolean;
  appName?: string;
  hasInfoPlist: boolean;
  errors: string[];
}
