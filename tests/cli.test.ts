import { describe, it, expect } from 'vitest';
import { createCli } from '../src/cli';

describe('CLI Structure & Command Definitions', () => {
  it('initializes Commander with proper name and version', () => {
    const cli = createCli();
    expect(cli.name()).toBe('cloudipa');
    expect(cli.version()).toBe('1.0.0');
  });

  it('registers all required subcommands', () => {
    const cli = createCli();
    const commandNames = cli.commands.map((c) => c.name());

    expect(commandNames).toContain('init');
    expect(commandNames).toContain('build');
    expect(commandNames).toContain('status');
    expect(commandNames).toContain('logs');
    expect(commandNames).toContain('download');
    expect(commandNames).toContain('doctor');
  });

  it('configures build command with all expected flags', () => {
    const cli = createCli();
    const buildCmd = cli.commands.find((c) => c.name() === 'build');
    expect(buildCmd).toBeDefined();

    const options = buildCmd!.options.map((o) => o.long || o.short);
    expect(options).toContain('--scheme');
    expect(options).toContain('--configuration');
    expect(options).toContain('--runner');
    expect(options).toContain('--output');
    expect(options).toContain('--ref');
    expect(options).toContain('--xcode');
    expect(options).toContain('--timeout');
    expect(options).toContain('--allow-dirty-remote');
    expect(options).toContain('--no-wait');

    // Destructive defaults must not be present so .cloudipa.yml isn't silently overwritten
    const findOption = (name: string) => buildCmd!.options.find((o) => o.long === name);
    expect(findOption('--configuration')?.defaultValue).toBeUndefined();
    expect(findOption('--runner')?.defaultValue).toBeUndefined();
    expect(findOption('--xcode')?.defaultValue).toBeUndefined();
    expect(findOption('--timeout')?.defaultValue).toBeUndefined();
  });

  it('supports global --plain and --verbose flags', () => {
    const cli = createCli();
    const globalOptions = cli.options.map((o) => o.long);
    expect(globalOptions).toContain('--plain');
    expect(globalOptions).toContain('--verbose');
  });
});
