import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { iosDetector } from '../src/detectors/ios-detector';

describe('Local iOS Project Detection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudipa-detector-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('rejects Android-only projects with a descriptive error', async () => {
    fs.writeFileSync(path.join(tempDir, 'build.gradle'), '// Android build file');
    fs.writeFileSync(path.join(tempDir, 'AndroidManifest.xml'), '<manifest></manifest>');

    await expect(iosDetector.inspect(tempDir)).rejects.toThrow(/Android-only project/);
  });

  it('detects .xcodeproj and extracts shared schemes from xcshareddata', async () => {
    const projDir = path.join(tempDir, 'SampleApp.xcodeproj');
    const schemesDir = path.join(projDir, 'xcshareddata', 'xcschemes');
    fs.mkdirSync(schemesDir, { recursive: true });

    fs.writeFileSync(path.join(schemesDir, 'SampleApp.xcscheme'), '<Scheme></Scheme>');
    fs.writeFileSync(path.join(schemesDir, 'SampleAppStaging.xcscheme'), '<Scheme></Scheme>');

    const info = await iosDetector.inspect(tempDir);
    expect(info.projectFile).toBe('SampleApp.xcodeproj');
    expect(info.schemes).toContain('SampleApp');
    expect(info.schemes).toContain('SampleAppStaging');
  });

  it('ignores internal project.xcworkspace inside .xcodeproj and prioritizes outer workspace', async () => {
    const workspaceDir = path.join(tempDir, 'MainApp.xcworkspace');
    fs.mkdirSync(workspaceDir, { recursive: true });

    const projDir = path.join(tempDir, 'MainApp.xcodeproj');
    const internalWs = path.join(projDir, 'project.xcworkspace');
    fs.mkdirSync(internalWs, { recursive: true });

    const info = await iosDetector.inspect(tempDir);
    expect(info.workspaceFile).toBe('MainApp.xcworkspace');
  });

  it('falls back to extracting PBXNativeTarget and metadata from project.pbxproj when no xcshareddata exists', async () => {
    const projDir = path.join(tempDir, 'DirectProj.xcodeproj');
    fs.mkdirSync(projDir, { recursive: true });

    const mockPbxproj = `
// !$*UTF8*$!
{
  archiveVersion = 1;
  classes = {};
  objectVersion = 56;
  objects = {
    1A2B3C4D /* DirectTarget */ = {
      isa = PBXNativeTarget;
      name = "DirectTarget";
      productName = DirectTarget;
      productReference = 1A2B3C4E /* DirectTarget.app */;
      productType = "com.apple.product-type.application";
    };
    1A2B3C50 /* BuildConfiguration */ = {
      isa = XCBuildConfiguration;
      buildSettings = {
        PRODUCT_BUNDLE_IDENTIFIER = "com.example.cloudipa.app";
        MARKETING_VERSION = "2.1.0";
        CURRENT_PROJECT_VERSION = "42";
      };
      name = Release;
    };
  };
  rootObject = 1A2B3C40;
}
`;
    fs.writeFileSync(path.join(projDir, 'project.pbxproj'), mockPbxproj);

    const info = await iosDetector.inspect(tempDir);
    expect(info.schemes).toContain('DirectTarget');
    expect(info.bundleIdentifier).toBe('com.example.cloudipa.app');
    expect(info.marketingVersion).toBe('2.1.0');
    expect(info.currentProjectVersion).toBe('42');
  });

  it('throws helpful error if directory contains no iOS project files', async () => {
    await expect(iosDetector.inspect(tempDir)).rejects.toThrow(/No iOS project \(\.xcodeproj\) or workspace/);
  });
});
