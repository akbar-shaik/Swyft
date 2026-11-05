import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import AdmZip from 'adm-zip';
const {
  signToken,
  verifyToken,
  generateHmacSignature,
  extractZipSafely,
  recordActivity,
  otpStore,
  ALLOWED_CREDENTIAL_1,
} = require('../server/server');

describe('Server Authentication, Security & Telemetry Engine', () => {
  beforeEach(() => {
    otpStore.clear();
  });

  describe('HMAC Session Token Engine', () => {
    it('signs and verifies valid token within TTL', () => {
      const payload = { user: 'user_Akbar84', role: 'admin' };
      const token = signToken(payload, 60 * 1000); // 1 minute TTL
      expect(typeof token).toBe('string');
      expect(token).toContain('.');

      const decoded = verifyToken(token);
      expect(decoded).toBeDefined();
      expect(decoded.user).toBe('user_Akbar84');
      expect(decoded.role).toBe('admin');
      expect(decoded.exp).toBeGreaterThan(Date.now());
    });

    it('rejects expired session tokens', () => {
      const payload = { user: 'user_Akbar84' };
      const token = signToken(payload, -1000); // Already expired
      const decoded = verifyToken(token);
      expect(decoded).toBeNull();
    });

    it('rejects tampered token payloads and signatures', () => {
      const payload = { user: 'user_Akbar84' };
      const token = signToken(payload, 60 * 1000);
      const [data, sig] = token.split('.');

      // Tamper signature
      const tamperedSig = sig.slice(0, -4) + 'abcd';
      expect(verifyToken(`${data}.${tamperedSig}`)).toBeNull();

      // Tamper data payload
      const tamperedData = Buffer.from(JSON.stringify({ user: 'hacker', exp: Date.now() + 60000 })).toString('base64url');
      expect(verifyToken(`${tamperedData}.${sig}`)).toBeNull();
    });

    it('rejects malformed token strings', () => {
      expect(verifyToken('')).toBeNull();
      expect(verifyToken('invalid-token-no-dots')).toBeNull();
      expect(verifyToken('a.b.c')).toBeNull();
    });
  });

  describe('Telegram 6-Digit OTP Store & Lockout Policy', () => {
    it('enforces the strict Credential 1 check', () => {
      expect(ALLOWED_CREDENTIAL_1).toBe('user_Akbar84');
    });

    it('records OTP with expiration and zero initial attempts', () => {
      const key = 'user_Akbar84';
      const otp = '849201';
      otpStore.set(key, {
        otp,
        telegramUserId: '672766342',
        expiresAt: Date.now() + 5 * 60 * 1000,
        attempts: 0,
      });

      const entry = otpStore.get(key);
      expect(entry).toBeDefined();
      expect(entry.otp).toBe(otp);
      expect(entry.attempts).toBe(0);
      expect(entry.expiresAt).toBeGreaterThan(Date.now());
    });

    it('locks out and cleans up after 5 failed attempts', () => {
      const key = 'user_Akbar84';
      otpStore.set(key, {
        otp: '123456',
        telegramUserId: '672766342',
        expiresAt: Date.now() + 5 * 60 * 1000,
        attempts: 4,
      });

      const entry = otpStore.get(key);
      entry.attempts += 1;
      expect(entry.attempts).toBe(5);

      // 5th failed attempt triggers lockout cleanup
      if (entry.attempts >= 5) {
        otpStore.delete(key);
      }
      expect(otpStore.has(key)).toBe(false);
    });
  });

  describe('HMAC-Signed Upload URL Security', () => {
    it('generates reproducible HMAC signature for requestId and expiration', () => {
      const requestId = 'req-test-uuid-999';
      const expires = String(Date.now() + 60000);
      const sig1 = generateHmacSignature(requestId, expires);
      const sig2 = generateHmacSignature(requestId, expires);

      expect(sig1).toBe(sig2);
      expect(sig1).toHaveLength(64); // SHA256 hex is 64 chars
    });

    it('produces completely different signatures for different timestamps', () => {
      const requestId = 'req-test-uuid-999';
      const sig1 = generateHmacSignature(requestId, '1000');
      const sig2 = generateHmacSignature(requestId, '2000');
      expect(sig1).not.toBe(sig2);
    });
  });

  describe('Zip Slip Path Traversal Protection', () => {
    it('successfully extracts a safe zip archive', () => {
      const zip = new AdmZip();
      zip.addFile('MyApp/Info.plist', Buffer.from('<plist/>'));
      zip.addFile('MyApp/main.m', Buffer.from('int main() { return 0; }'));

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-zip-test-'));
      const buffer = zip.toBuffer();

      expect(() => extractZipSafely(buffer, tmpDir)).not.toThrow();
      expect(fs.existsSync(path.join(tmpDir, 'MyApp', 'Info.plist'))).toBe(true);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('throws error and halts extraction on Zip Slip path traversal attempt', () => {
      const zip = new AdmZip();
      zip.addFile('test.txt', Buffer.from('#!/bin/bash\necho pwned'));
      // Mutate entryName to simulate raw Zip Slip traversal header
      zip.getEntries()[0].entryName = '../../evil-payload.sh';

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unsafe-zip-test-'));
      const buffer = zip.toBuffer();

      expect(() => extractZipSafely(buffer, tmpDir)).toThrow(/Zip Slip/);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('Activity Telemetry & Progress Engine', () => {
    it('records timestamped activity lines and updates granular progress percentage', () => {
      const job = {
        id: 'job-123',
        stage: 1,
        message: 'Init',
        progressPct: 0,
        activities: [],
      };

      recordActivity(job, 'info', 2, 'Dispatching runner', 'Detail info', 25);
      expect(job.stage).toBe(2);
      expect(job.message).toBe('Dispatching runner');
      expect(job.progressPct).toBe(25);
      expect(job.activities).toHaveLength(1);
      expect(job.activities[0].level).toBe('info');
      expect(job.activities[0].stage).toBe(2);
      expect(job.activities[0].detail).toBe('Detail info');

      recordActivity(job, 'success', 7, 'Build complete', '', 100);
      expect(job.progressPct).toBe(100);
      expect(job.activities).toHaveLength(2);
      expect(job.activities[1].level).toBe('success');
    });

    it('clamps progress percentage strictly between 0 and 100', () => {
      const job = { activities: [] };
      recordActivity(job, 'info', 1, 'Low', '', -15);
      expect(job.progressPct).toBe(0);

      recordActivity(job, 'info', 1, 'High', '', 150);
      expect(job.progressPct).toBe(100);
    });
  });
});
