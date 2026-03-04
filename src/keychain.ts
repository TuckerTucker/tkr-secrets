/**
 * macOS Keychain provider for secure vault key storage.
 *
 * Uses the `security` CLI to store/retrieve the vault key (VK) in the
 * system keychain. On non-macOS platforms, isAvailable() returns false
 * and all operations are no-ops.
 */

import { execSync } from 'node:child_process';

/** Interface for keychain-based key storage. */
export interface KeychainProvider {
  /** Whether the keychain is available on this platform. */
  isAvailable(): boolean;

  /** Store a key in the keychain. Overwrites any existing entry. */
  store(service: string, account: string, key: Buffer): Promise<void>;

  /** Retrieve a key from the keychain. Returns null if not found. */
  retrieve(service: string, account: string): Promise<Buffer | null>;

  /** Remove a key from the keychain. Returns true if it existed. */
  remove(service: string, account: string): Promise<boolean>;
}

/**
 * macOS Keychain implementation via the `security` CLI.
 *
 * Keys are stored as hex-encoded generic passwords. The `-T /usr/bin/security`
 * flag trusts the security CLI itself, so retrieval via `security find-generic-password`
 * doesn't trigger repeated keychain prompts. The user is still prompted once
 * on first access, and "Always Allow" persists across bun restarts.
 */
export class MacOSKeychainProvider implements KeychainProvider {
  isAvailable(): boolean {
    return process.platform === 'darwin';
  }

  async store(service: string, account: string, key: Buffer): Promise<void> {
    if (!this.isAvailable()) return;

    const hex = key.toString('hex');

    // Delete existing entry first (add-generic-password -U can be unreliable)
    try {
      execSync(
        `security delete-generic-password -s ${shellEscape(service)} -a ${shellEscape(account)}`,
        { stdio: 'ignore' },
      );
    } catch {
      // Entry didn't exist — expected on first store
    }

    execSync(
      `security add-generic-password -s ${shellEscape(service)} -a ${shellEscape(account)} -w ${shellEscape(hex)} -T /usr/bin/security`,
      { stdio: 'ignore' },
    );
  }

  async retrieve(service: string, account: string): Promise<Buffer | null> {
    if (!this.isAvailable()) return null;

    try {
      const result = execSync(
        `security find-generic-password -s ${shellEscape(service)} -a ${shellEscape(account)} -w`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const hex = result.trim();
      if (!hex || !/^[0-9a-f]+$/i.test(hex)) return null;
      return Buffer.from(hex, 'hex');
    } catch {
      return null;
    }
  }

  async remove(service: string, account: string): Promise<boolean> {
    if (!this.isAvailable()) return false;

    try {
      execSync(
        `security delete-generic-password -s ${shellEscape(service)} -a ${shellEscape(account)}`,
        { stdio: 'ignore' },
      );
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Escapes a string for safe use in a shell command argument.
 * Uses single-quote wrapping with internal single-quote escaping.
 */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
