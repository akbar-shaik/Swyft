import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { CloudIPAConfig, BuildOptions } from '../types';
import { DEFAULT_CONFIG, validateAndNormalizeConfig } from './schema';

export const CONFIG_FILE_NAME = '.cloudipa.yml';

export function findConfigFile(startDir: string = process.cwd()): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const ymlPath = path.join(current, '.cloudipa.yml');
    const yamlPath = path.join(current, '.cloudipa.yaml');

    if (fs.existsSync(ymlPath)) return ymlPath;
    if (fs.existsSync(yamlPath)) return yamlPath;

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

export function loadConfig(configPath?: string, overrides?: BuildOptions): CloudIPAConfig {
  let loaded: any = {};
  const targetPath = configPath || findConfigFile();

  if (targetPath && fs.existsSync(targetPath)) {
    try {
      const content = fs.readFileSync(targetPath, 'utf8');
      loaded = YAML.parse(content) || {};
    } catch (err: any) {
      throw new Error(`Failed to parse configuration file at ${targetPath}: ${err.message}`);
    }
  }

  const config = validateAndNormalizeConfig(loaded);

  // Apply CLI overrides if present
  if (overrides) {
    if (overrides.scheme) {
      config.project.scheme = overrides.scheme;
    }
    if (overrides.configuration) {
      config.project.configuration = overrides.configuration;
    }
    if (overrides.runner) {
      config.build.runner = overrides.runner;
    }
    if (overrides.xcode) {
      config.build.xcode_version = overrides.xcode;
    }
    if (overrides.ref) {
      config.github.branch = overrides.ref;
    }
    if (overrides.timeout) {
      config.build.timeout_minutes = overrides.timeout;
    }
    if (overrides.output) {
      if (overrides.output.endsWith('.ipa')) {
        config.output.directory = path.dirname(overrides.output);
        config.output.filename = path.basename(overrides.output);
      } else {
        config.output.directory = overrides.output;
      }
    }
  }

  return config;
}

export function saveConfig(filePath: string, config: CloudIPAConfig): void {
  const content = YAML.stringify(config);
  fs.writeFileSync(filePath, content, 'utf8');
}
