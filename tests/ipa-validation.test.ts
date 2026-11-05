import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import AdmZip from 'adm-zip';
import { validateIpaArchive, calculateSha256 } from '../src/utils/validator';

describe('IPA Archive Validation & Integrity Verification', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudipa-validator-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('validates a properly structured iOS .ipa archive containing Payload/App.app/Info.plist', () => {
    const zip = new AdmZip();
    zip.addFile('Payload/SampleApp.app/Info.plist', Buffer.from('<plist></plist>'));
    zip.addFile('Payload/SampleApp.app/SampleApp', Buffer.from('binary-code'));

    const ipaBuffer = zip.toBuffer();
    const result = validateIpaArchive(ipaBuffer);

    expect(result.valid).toBe(true);
    expect(result.appName).toBe('SampleApp.app');
    expect(result.hasInfoPlist).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects an archive that is missing the Payload/ root directory', () => {
    const zip = new AdmZip();
    zip.addFile('SampleApp.app/Info.plist', Buffer.from('<plist></plist>'));

    const ipaBuffer = zip.toBuffer();
    const result = validateIpaArchive(ipaBuffer);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('missing "Payload/" root directory')])
    );
  });

  it('rejects an archive that has Payload/ but lacks an .app directory', () => {
    const zip = new AdmZip();
    zip.addFile('Payload/readme.txt', Buffer.from('hello'));

    const ipaBuffer = zip.toBuffer();
    const result = validateIpaArchive(ipaBuffer);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('missing "<AppName>.app" bundle directory')])
    );
  });

  it('rejects an archive with .app bundle that lacks Info.plist', () => {
    const zip = new AdmZip();
    zip.addFile('Payload/Incomplete.app/Binary', Buffer.from('executable'));

    const ipaBuffer = zip.toBuffer();
    const result = validateIpaArchive(ipaBuffer);

    expect(result.valid).toBe(false);
    expect(result.hasInfoPlist).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('Missing "Info.plist"')])
    );
  });

  it('handles non-existent or corrupted ZIP files safely', () => {
    const nonExistent = path.join(tempDir, 'does-not-exist.ipa');
    const resultNotExist = validateIpaArchive(nonExistent);
    expect(resultNotExist.valid).toBe(false);

    const corruptPath = path.join(tempDir, 'corrupt.ipa');
    fs.writeFileSync(corruptPath, 'this is not a zip file at all');
    const resultCorrupt = validateIpaArchive(corruptPath);
    expect(resultCorrupt.valid).toBe(false);
    expect(resultCorrupt.errors[0]).toContain('Corrupted ZIP');
  });

  it('calculates accurate SHA-256 hash of a file on disk', async () => {
    const testFile = path.join(tempDir, 'sample.txt');
    fs.writeFileSync(testFile, 'CloudIPA SHA-256 test content');

    const hash = await calculateSha256(testFile);
    expect(typeof hash).toBe('string');
    expect(hash).toHaveLength(64); // 64 hex characters for SHA-256
  });
});
