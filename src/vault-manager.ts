/**
 * VaultManager: manages an in-memory registry of SecretsStore instances.
 *
 * Each vault is an independent SecretsStore backed by a file in the vaults directory.
 * The manager handles creation, lookup, deletion, and listing of vaults.
 */

import { join } from 'node:path';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import type { Logger } from './types.js';
import { SecretsStore } from './store.js';
import type { KeychainProvider } from './keychain.js';

/** Regex for valid vault names: lowercase letter followed by lowercase alphanumeric or hyphens. */
const VAULT_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Maximum length for a vault name. */
const MAX_VAULT_NAME_LENGTH = 64;

/** Vault names that cannot be used. */
const RESERVED_VAULT_NAMES = ['default'];

/** Dependencies injected into VaultManager. */
export interface VaultManagerDeps {
  /** Directory where vault files live. */
  readonly vaultsDir: string;
  /** Auto-lock timeout in milliseconds for each vault. */
  readonly autoLockMs: number;
  /** Structured logger instance. */
  readonly logger: Logger;
  /** Optional keychain provider for auto-unlock on macOS. */
  readonly keychain?: KeychainProvider;
  /** Keychain service name (e.g., 'tkr-secrets'). */
  readonly keychainService?: string;
}

/** Summary metadata for a registered vault. */
export interface VaultSummary {
  readonly name: string;
  readonly fileExists: boolean;
  readonly unlocked: boolean;
  readonly secretCount: number;
  readonly groupCount: number;
  readonly lastAccessed: string | null;
}

/**
 * Validates a vault name against naming rules.
 *
 * @param name - Candidate vault name.
 * @throws Error if the name is invalid, too long, or reserved.
 */
export function validateVaultName(name: string): void {
  if (!name) {
    throw new Error('vault name must not be empty');
  }
  if (name.length > MAX_VAULT_NAME_LENGTH) {
    throw new Error(`vault name must be at most ${MAX_VAULT_NAME_LENGTH} characters`);
  }
  if (!VAULT_NAME_RE.test(name)) {
    throw new Error(`vault name must match ${VAULT_NAME_RE} (lowercase letter, then lowercase alphanumeric or hyphens)`);
  }
  if (RESERVED_VAULT_NAMES.includes(name)) {
    throw new Error(`vault name '${name}' is reserved`);
  }
}

/**
 * Manages multiple independent vault instances in an in-memory registry.
 */
export class VaultManager {
  private readonly vaults: Map<string, SecretsStore> = new Map();
  private readonly vaultsDir: string;
  private readonly autoLockMs: number;
  private readonly logger: Logger;
  private readonly keychain?: KeychainProvider;
  private readonly keychainService?: string;

  constructor(deps: VaultManagerDeps) {
    this.vaultsDir = deps.vaultsDir;
    this.autoLockMs = deps.autoLockMs;
    this.logger = deps.logger.child({ component: 'vault-manager' });
    this.keychain = deps.keychain;
    this.keychainService = deps.keychainService;
  }

  /**
   * Returns summary metadata for all registered vaults.
   *
   * @returns Array of {@link VaultSummary} objects.
   */
  async list(): Promise<VaultSummary[]> {
    const summaries: VaultSummary[] = [];
    for (const [name, store] of this.vaults) {
      const filePath = this.getVaultFilePath(name);
      const fileExists = existsSync(filePath);
      const unlocked = store.isUnlocked;

      let secretCount = 0;
      let groupCount = 0;
      if (unlocked) {
        secretCount = store.getSecretCount();
        groupCount = store.getGroupCount();
      }

      summaries.push({
        name,
        fileExists,
        unlocked,
        secretCount,
        groupCount,
        lastAccessed: null,
      });
    }
    return summaries;
  }

  /**
   * Creates a new vault, initializes it with the given password, and registers it.
   *
   * @param name - Vault name (validated against naming rules).
   * @param password - Master password for the new vault.
   * @returns The created store and the recovery key buffer.
   * @throws Error with code-like message if name is invalid or vault already exists.
   */
  async create(name: string, password: string): Promise<{ store: SecretsStore; recoveryKey: Buffer }> {
    validateVaultName(name);

    if (this.vaults.has(name)) {
      const error = new Error(`vault '${name}' already exists`);
      (error as unknown as Record<string, unknown>)['status'] = 409;
      throw error;
    }

    const filePath = this.getVaultFilePath(name);
    const store = new SecretsStore({
      filePath,
      autoLockMs: this.autoLockMs,
      logger: this.logger,
      keychain: this.keychain,
      keychainService: this.keychainService,
      keychainAccount: name,
    });

    const recoveryKey = await store.init(password);
    this.vaults.set(name, store);
    this.logger.info({ vault: name }, 'vault created');

    return { store, recoveryKey };
  }

  /**
   * Looks up a registered vault by name.
   *
   * @param name - Vault name.
   * @returns The SecretsStore instance, or undefined if not registered.
   */
  get(name: string): SecretsStore | undefined {
    return this.vaults.get(name);
  }

  /**
   * Deletes a vault: locks it, removes files, and unregisters it.
   *
   * @param name - Vault name.
   * @throws Error if the vault is not registered.
   */
  async delete(name: string): Promise<void> {
    const store = this.vaults.get(name);
    if (!store) {
      throw new Error(`vault '${name}' not found`);
    }

    if (store.isUnlocked) {
      await store.lock();
    }

    // Always clear keychain on delete, regardless of persistSession
    if (this.keychain?.isAvailable() && this.keychainService) {
      try {
        await this.keychain.remove(this.keychainService, name);
      } catch {
        // Best-effort cleanup
      }
    }

    const vaultFile = this.getVaultFilePath(name);
    if (existsSync(vaultFile)) {
      unlinkSync(vaultFile);
    }

    this.vaults.delete(name);
    this.logger.info({ vault: name }, 'vault deleted');
  }

  /**
   * Scans the vaults directory for existing vault files and registers them.
   *
   * Vault files follow the naming convention `secrets-{name}.enc.json`.
   * Already-registered vaults are skipped.
   */
  scanAndRegister(): void {
    if (!existsSync(this.vaultsDir)) return;

    const files = readdirSync(this.vaultsDir);
    const pattern = /^secrets-([a-z][a-z0-9-]*)\.enc\.json$/;

    for (const file of files) {
      const match = pattern.exec(file);
      if (!match) continue;

      const name = match[1];
      if (this.vaults.has(name)) continue;

      const store = new SecretsStore({
        filePath: join(this.vaultsDir, file),
        autoLockMs: this.autoLockMs,
        logger: this.logger,
        keychain: this.keychain,
        keychainService: this.keychainService,
        keychainAccount: name,
      });

      this.vaults.set(name, store);
      this.logger.info({ vault: name }, 'vault discovered on disk');
    }
  }

  /**
   * Attempts auto-unlock on all registered vaults via keychain or env var.
   *
   * @returns Number of vaults that were auto-unlocked.
   */
  async tryAutoUnlockAll(): Promise<number> {
    let count = 0;
    for (const [name, store] of this.vaults) {
      try {
        if (await store.tryAutoUnlock()) {
          this.logger.info({ vault: name }, 'vault auto-unlocked');
          count++;
        }
      } catch (err) {
        this.logger.warn({ vault: name, err }, 'auto-unlock failed');
      }
    }
    return count;
  }

  /**
   * Returns the vault file path for a given vault name.
   *
   * @param name - Vault name.
   * @returns Absolute path to the vault file.
   */
  private getVaultFilePath(name: string): string {
    return join(this.vaultsDir, `secrets-${name}.enc.json`);
  }
}
