import fs from 'fs';
import path from 'path';
import { ProjectInfo } from '../types';
import { BuildAdapter } from './adapter-interface';

export class NativeIosAdapter implements BuildAdapter {
  public name = 'native-ios';

  public async detect(projectRoot: string): Promise<boolean> {
    const resolvedRoot = path.resolve(projectRoot);
    if (!fs.existsSync(resolvedRoot)) {
      return false;
    }

    // Check for Android-only projects first
    this.assertNotAndroidOnly(resolvedRoot);

    const { workspaceFile, projectFile } = this.findContainers(resolvedRoot);
    return Boolean(workspaceFile || projectFile);
  }

  public async inspect(projectRoot: string): Promise<ProjectInfo> {
    const resolvedRoot = path.resolve(projectRoot);
    if (!fs.existsSync(resolvedRoot)) {
      throw new Error(`Project directory not found: ${projectRoot}`);
    }

    // Check for Android-only projects
    this.assertNotAndroidOnly(resolvedRoot);

    const { workspaceFile, projectFile } = this.findContainers(resolvedRoot);

    if (!workspaceFile && !projectFile) {
      throw new Error(
        `No iOS project (.xcodeproj) or workspace (.xcworkspace) found in "${projectRoot}". ` +
        `Ensure this is an iOS or cross-platform iOS project directory.`
      );
    }

    const schemes = new Set<string>();

    // 1. Check shared schemes in xcshareddata of workspace and project
    if (workspaceFile) {
      this.extractSharedSchemes(path.join(resolvedRoot, workspaceFile), schemes);
    }
    if (projectFile) {
      this.extractSharedSchemes(path.join(resolvedRoot, projectFile), schemes);
    }

    // 2. Parse pbxproj for metadata and fallback target/schemes
    let bundleId: string | undefined;
    let marketingVersion: string | undefined;
    let currentProjectVersion: string | undefined;

    if (projectFile) {
      const pbxprojPath = path.join(resolvedRoot, projectFile, 'project.pbxproj');
      if (fs.existsSync(pbxprojPath)) {
        const pbxContent = fs.readFileSync(pbxprojPath, 'utf8');

        // Extract metadata
        const metadata = this.extractPbxprojMetadata(pbxContent);
        bundleId = metadata.bundleId;
        marketingVersion = metadata.marketingVersion;
        currentProjectVersion = metadata.currentProjectVersion;

        // If no shared schemes were found, extract PBXNativeTarget names
        if (schemes.size === 0) {
          const targets = this.extractPbxNativeTargets(pbxContent);
          for (const target of targets) {
            schemes.add(target);
          }
        }
      }
    }

    // If still empty, fallback to project filename base
    if (schemes.size === 0 && projectFile) {
      schemes.add(path.basename(projectFile, '.xcodeproj'));
    }

    return {
      projectPath: resolvedRoot,
      workspaceFile: workspaceFile || undefined,
      projectFile: projectFile || undefined,
      schemes: Array.from(schemes),
      bundleIdentifier: bundleId,
      marketingVersion,
      currentProjectVersion,
    };
  }

  private assertNotAndroidOnly(resolvedRoot: string): void {
    const hasAndroidGradle =
      fs.existsSync(path.join(resolvedRoot, 'build.gradle')) ||
      fs.existsSync(path.join(resolvedRoot, 'build.gradle.kts')) ||
      fs.existsSync(path.join(resolvedRoot, 'app', 'build.gradle')) ||
      fs.existsSync(path.join(resolvedRoot, 'app', 'build.gradle.kts'));

    const hasAndroidManifest =
      fs.existsSync(path.join(resolvedRoot, 'AndroidManifest.xml')) ||
      fs.existsSync(path.join(resolvedRoot, 'app', 'src', 'main', 'AndroidManifest.xml'));

    const hasIosDir =
      fs.existsSync(path.join(resolvedRoot, 'ios')) &&
      fs.statSync(path.join(resolvedRoot, 'ios')).isDirectory();

    const { workspaceFile, projectFile } = this.findContainers(resolvedRoot);

    if ((hasAndroidGradle || hasAndroidManifest) && !hasIosDir && !workspaceFile && !projectFile) {
      throw new Error(
        'Detected an Android-only project (found build.gradle / AndroidManifest.xml without any iOS project files). ' +
        'CloudIPA only compiles iOS projects into unsigned .ipa packages.'
      );
    }
  }

  private findContainers(resolvedRoot: string): { workspaceFile: string | null; projectFile: string | null } {
    let workspaceFile: string | null = null;
    let projectFile: string | null = null;

    // Check at root, and optionally inside 'ios/' directory for React Native / Flutter
    const candidateDirs = [resolvedRoot];
    const iosSubdir = path.join(resolvedRoot, 'ios');
    if (fs.existsSync(iosSubdir) && fs.statSync(iosSubdir).isDirectory()) {
      candidateDirs.push(iosSubdir);
    }

    for (const dir of candidateDirs) {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const relPath = path.relative(resolvedRoot, fullPath);

        if (entry.endsWith('.xcworkspace') && entry !== 'project.xcworkspace') {
          if (!workspaceFile) {
            workspaceFile = relPath.replace(/\\/g, '/');
          }
        } else if (entry.endsWith('.xcodeproj')) {
          if (!projectFile) {
            projectFile = relPath.replace(/\\/g, '/');
          }
        }
      }
    }

    return { workspaceFile, projectFile };
  }

  private extractSharedSchemes(containerPath: string, schemes: Set<string>): void {
    const sharedDataDir = path.join(containerPath, 'xcshareddata', 'xcschemes');
    if (fs.existsSync(sharedDataDir) && fs.statSync(sharedDataDir).isDirectory()) {
      const files = fs.readdirSync(sharedDataDir);
      for (const file of files) {
        if (file.endsWith('.xcscheme')) {
          schemes.add(path.basename(file, '.xcscheme'));
        }
      }
    }
  }

  private extractPbxNativeTargets(pbxContent: string): string[] {
    const appTargets: string[] = [];
    const otherTargets: string[] = [];
    const targetBlockRegex = /([0-9A-Fa-f]{24})\s*\/\*\s*([^*]+)\s*\*\/\s*=\s*\{[^}]*?isa\s*=\s*PBXNativeTarget;[\s\S]*?\};/g;
    let match: RegExpExecArray | null;

    while ((match = targetBlockRegex.exec(pbxContent)) !== null) {
      const block = match[0];
      const nameMatch = block.match(/name\s*=\s*(?:"([^"]+)"|([^;\s]+));/);
      const productTypeMatch = block.match(/productType\s*=\s*(?:"([^"]+)"|([^;\s]+));/);
      const name = nameMatch ? (nameMatch[1] || nameMatch[2]) : null;
      const productType = productTypeMatch ? (productTypeMatch[1] || productTypeMatch[2]) : '';

      if (name && !name.includes('Tests') && !name.includes('UITests') && !name.startsWith('Pods-')) {
        if (productType.includes('application')) {
          appTargets.push(name.trim());
        } else {
          otherTargets.push(name.trim());
        }
      }
    }

    if (appTargets.length > 0) return appTargets;
    if (otherTargets.length > 0) return otherTargets;

    const simpleRegex = /isa\s*=\s*PBXNativeTarget\s*;[\s\S]*?name\s*=\s*(?:"([^"]+)"|([^;\s]+));/g;
    while ((match = simpleRegex.exec(pbxContent)) !== null) {
      const name = match[1] || match[2];
      if (name && !name.includes('Tests') && !name.includes('UITests') && !name.startsWith('Pods-')) {
        otherTargets.push(name.trim());
      }
    }
    return otherTargets;
  }

  private extractPbxprojMetadata(pbxContent: string): {
    bundleId?: string;
    marketingVersion?: string;
    currentProjectVersion?: string;
  } {
    let bundleId: string | undefined;
    let marketingVersion: string | undefined;
    let currentProjectVersion: string | undefined;

    // Match static PRODUCT_BUNDLE_IDENTIFIER
    const bundleIdMatch = pbxContent.match(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*(?:\"([^\"]+)\"|([^;\s]+));/);
    if (bundleIdMatch) {
      const raw = bundleIdMatch[1] || bundleIdMatch[2];
      if (raw && !raw.includes('$')) {
        bundleId = raw.trim();
      }
    }

    // Match MARKETING_VERSION
    const versionMatch = pbxContent.match(/MARKETING_VERSION\s*=\s*(?:\"([^\"]+)\"|([^;\s]+));/);
    if (versionMatch) {
      marketingVersion = (versionMatch[1] || versionMatch[2]).trim();
    }

    // Match CURRENT_PROJECT_VERSION
    const buildMatch = pbxContent.match(/CURRENT_PROJECT_VERSION\s*=\s*(?:\"([^\"]+)\"|([^;\s]+));/);
    if (buildMatch) {
      currentProjectVersion = (buildMatch[1] || buildMatch[2]).trim();
    }

    return { bundleId, marketingVersion, currentProjectVersion };
  }
}

export const iosDetector = new NativeIosAdapter();

export async function detectIosProject(projectRoot: string): Promise<ProjectInfo> {
  return iosDetector.inspect(projectRoot);
}
