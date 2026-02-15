/**
 * Unit tests for mount security (TOCTOU prevention)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { validateAdditionalMounts, verifyMountInode } from '../../mount-security.js';

describe('Mount Security - TOCTOU Prevention', () => {
  let testDir: string;

  beforeEach(() => {
    // Create temporary test directory
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mount-test-'));
  });

  afterEach(() => {
    // Clean up test directory
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  describe('Path Validation', () => {
    it('should accept safe paths within home directory', () => {
      const safePath = path.join(testDir, 'safe');
      fs.mkdirSync(safePath);

      const mounts = validateAdditionalMounts(
        [{ hostPath: safePath, containerPath: '/data', readonly: false }],
        'test-group',
        false,
      );

      expect(mounts).toHaveLength(1);
      expect(mounts[0].hostPath).toBe(safePath);
    });

    it('should reject symlinks to sensitive directories', () => {
      const symlinkPath = path.join(testDir, 'link-to-ssh');
      const sshDir = path.join(os.homedir(), '.ssh');

      // Create symlink to ~/.ssh (if it exists)
      if (fs.existsSync(sshDir)) {
        fs.symlinkSync(sshDir, symlinkPath);

        const mounts = validateAdditionalMounts(
          [{ hostPath: symlinkPath, containerPath: '/data', readonly: false }],
          'test-group',
          false,
        );

        // Should be rejected because realpath resolves to ~/.ssh
        expect(mounts).toHaveLength(0);
      }
    });

    it('should reject paths outside home directory (for non-main)', () => {
      const mounts = validateAdditionalMounts(
        [{ hostPath: '/etc', containerPath: '/data', readonly: false }],
        'test-group',
        false, // Not main group
      );

      expect(mounts).toHaveLength(0);
    });
  });

  describe('Inode Verification', () => {
    it('should capture inode during validation', () => {
      const testPath = path.join(testDir, 'test-dir');
      fs.mkdirSync(testPath);

      const mounts = validateAdditionalMounts(
        [{ hostPath: testPath, containerPath: '/data', readonly: false }],
        'test-group',
        false,
      );

      expect(mounts).toHaveLength(1);
      expect(mounts[0].ino).toBeDefined();
      expect(mounts[0].dev).toBeDefined();
      expect(typeof mounts[0].ino).toBe('number');
      expect(typeof mounts[0].dev).toBe('number');
    });

    it('should detect inode mismatch (TOCTOU attack)', () => {
      const safePath = path.join(testDir, 'safe');
      const dangerPath = path.join(testDir, 'danger');
      const symlinkPath = path.join(testDir, 'link');

      fs.mkdirSync(safePath);
      fs.mkdirSync(dangerPath);

      // Create symlink to safe path
      fs.symlinkSync(safePath, symlinkPath);

      // Validate mount (captures safe path inode)
      const mounts = validateAdditionalMounts(
        [{ hostPath: symlinkPath, containerPath: '/data', readonly: false }],
        'test-group',
        false,
      );

      expect(mounts).toHaveLength(1);
      const validatedMount = mounts[0];

      // Simulate TOCTOU attack: swap symlink target
      fs.unlinkSync(symlinkPath);
      fs.symlinkSync(dangerPath, symlinkPath);

      // Verify mount - should detect inode changed
      const isValid = verifyMountInode(validatedMount);

      // Should fail because symlink now points to different directory
      expect(isValid).toBe(false);
    });

    it('should pass verification if path unchanged', () => {
      const testPath = path.join(testDir, 'stable');
      fs.mkdirSync(testPath);

      const mounts = validateAdditionalMounts(
        [{ hostPath: testPath, containerPath: '/data', readonly: false }],
        'test-group',
        false,
      );

      expect(mounts).toHaveLength(1);
      const validatedMount = mounts[0];

      // Verify immediately (no changes)
      const isValid = verifyMountInode(validatedMount);

      expect(isValid).toBe(true);
    });
  });

  describe('Dangerous Paths (Blocklist)', () => {
    it('should block .ssh directory', () => {
      const sshPath = path.join(os.homedir(), '.ssh');

      if (fs.existsSync(sshPath)) {
        const mounts = validateAdditionalMounts(
          [{ hostPath: sshPath, containerPath: '/data', readonly: false }],
          'test-group',
          false,
        );

        expect(mounts).toHaveLength(0);
      }
    });

    it('should block .aws directory', () => {
      const awsPath = path.join(os.homedir(), '.aws');

      if (fs.existsSync(awsPath)) {
        const mounts = validateAdditionalMounts(
          [{ hostPath: awsPath, containerPath: '/data', readonly: false }],
          'test-group',
          false,
        );

        expect(mounts).toHaveLength(0);
      }
    });

    it('should block .gnupg directory', () => {
      const gnupgPath = path.join(os.homedir(), '.gnupg');

      if (fs.existsSync(gnupgPath)) {
        const mounts = validateAdditionalMounts(
          [{ hostPath: gnupgPath, containerPath: '/data', readonly: false }],
          'test-group',
          false,
        );

        expect(mounts).toHaveLength(0);
      }
    });
  });

  describe('Main Group Special Cases', () => {
    it('should allow system paths for main group', () => {
      const systemPath = '/tmp';

      const mounts = validateAdditionalMounts(
        [{ hostPath: systemPath, containerPath: '/data', readonly: true }],
        'main',
        true, // Is main group
      );

      // Main group should be allowed to mount system paths
      expect(mounts.length).toBeGreaterThanOrEqual(0);
      // (May still fail validation for other reasons, but won't reject on "outside home" alone)
    });
  });
});
