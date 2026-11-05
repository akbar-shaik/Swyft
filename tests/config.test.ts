import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DEFAULT_CONFIG, validateAndNormalizeConfig } from '../src/config/schema';
import { loadConfig, saveConfig } from '../src/config/loader';

describe('Configuration System (.cloudipa.yml)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudipa-config-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('provides required safe defaults', () => {
    expect(DEFAULT_CONFIG.build.runner).toBe('macos-15');
    expect(DEFAULT_CONFIG.build.xcode_version).toBe('auto');
    expect(DEFAULT_CONFIG.build.timeout_minutes).toBe(25);
    expect(DEFAULT_CONFIG.build.destination).toBe('generic/platform=iOS');
    expect(DEFAULT_CONFIG.project.configuration).toBe('Release');
    expect(DEFAULT_CONFIG.github.workflow).toBe('cloudipa-build.yml');
  });

  it('normalizes missing or empty fields with default values', () => {
    const normalized = validateAndNormalizeConfig({});
    expect(normalized.project.path).toBe('.');
    expect(normalized.project.configuration).toBe('Release');
    expect(normalized.build.runner).toBe('macos-15');
    expect(normalized.build.timeout_minutes).toBe(25);
  });

  it('persists and reloads config via saveConfig and loadConfig', () => {
    const configPath = path.join(tempDir, '.cloudipa.yml');
    const customConfig = {
      ...DEFAULT_CONFIG,
      project: {
        ...DEFAULT_CONFIG.project,
        scheme: 'CustomScheme',
      },
      build: {
        ...DEFAULT_CONFIG.build,
        runner: 'macos-14',
        timeout_minutes: 20,
      },
    };

    saveConfig(configPath, customConfig);
    expect(fs.existsSync(configPath)).toBe(true);

    const reloaded = loadConfig(configPath);
    expect(reloaded.project.scheme).toBe('CustomScheme');
    expect(reloaded.build.runner).toBe('macos-14');
    expect(reloaded.build.timeout_minutes).toBe(20);
  });

  it('properly applies CLI flag overrides over file configuration', () => {
    const configPath = path.join(tempDir, '.cloudipa.yml');
    saveConfig(configPath, DEFAULT_CONFIG);

    const overridden = loadConfig(configPath, {
      scheme: 'OverriddenScheme',
      configuration: 'Debug',
      runner: 'macos-14',
      xcode: '16.0',
      ref: 'feat/test',
      timeout: 15,
      output: './custom-output/CustomApp.unsigned.ipa',
    });

    expect(overridden.project.scheme).toBe('OverriddenScheme');
    expect(overridden.project.configuration).toBe('Debug');
    expect(overridden.build.runner).toBe('macos-14');
    expect(overridden.build.xcode_version).toBe('16.0');
    expect(overridden.github.branch).toBe('feat/test');
    expect(overridden.build.timeout_minutes).toBe(15);
    expect(overridden.output.filename).toBe('CustomApp.unsigned.ipa');
  });
});
