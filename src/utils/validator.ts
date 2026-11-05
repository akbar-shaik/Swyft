import fs from 'fs';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import { IpaValidationResult } from '../types';

export function validateIpaArchive(filePathOrBuffer: string | Buffer): IpaValidationResult {
  const errors: string[] = [];

  try {
    let zip: AdmZip;
    if (typeof filePathOrBuffer === 'string') {
      if (!fs.existsSync(filePathOrBuffer)) {
        return {
          valid: false,
          hasInfoPlist: false,
          errors: [`File does not exist: ${filePathOrBuffer}`],
        };
      }
      zip = new AdmZip(filePathOrBuffer);
    } else {
      zip = new AdmZip(filePathOrBuffer);
    }

    const entries = zip.getEntries();
    if (entries.length === 0) {
      return {
        valid: false,
        hasInfoPlist: false,
        errors: ['Archive is empty or corrupted.'],
      };
    }

    const payloadPrefixRegex = /^Payload\/([^/]+)\.app\//i;
    let appName: string | undefined;
    let hasInfoPlist = false;
    let hasPayloadFolder = false;

    for (const entry of entries) {
      const entryName = entry.entryName.replace(/\\/g, '/');

      if (entryName.startsWith('Payload/')) {
        hasPayloadFolder = true;
      }

      const match = entryName.match(payloadPrefixRegex);
      if (match) {
        if (!appName) {
          appName = `${match[1]}.app`;
        }
        if (entryName.toLowerCase() === `payload/${match[1].toLowerCase()}.app/info.plist`) {
          hasInfoPlist = true;
        }
      }
    }

    if (!hasPayloadFolder) {
      errors.push('Archive missing "Payload/" root directory.');
    }

    if (!appName) {
      errors.push('Archive missing "<AppName>.app" bundle directory inside Payload/.');
    }

    if (!hasInfoPlist) {
      errors.push('Missing "Info.plist" inside application bundle (Payload/*.app/Info.plist).');
    }

    return {
      valid: errors.length === 0,
      appName,
      hasInfoPlist,
      errors,
    };
  } catch (err: any) {
    return {
      valid: false,
      hasInfoPlist: false,
      errors: [`Corrupted ZIP archive: ${err.message || String(err)}`],
    };
  }
}

export function calculateSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`File not found: ${filePath}`));
    }
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
}
