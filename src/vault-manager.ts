/**
 * VaultManager: manages an in-memory registry of SecretsStore instances.
 *
 * Each vault is an independent SecretsStore backed by a file in the vaults directory.
 * The manager handles creation, lookup, deletion, and listing of vaults.
 */

import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import type { Logger } from './types.js';
import { SecretsStore } from './store.js';

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
}

/** Summary metadata for a registered vault. */
export interface VaultSummary {
  readonly name: string;
  readonly fileExists: boolean;
  readonly unlocked: boolean;
  readonly secretCount: number;
  readonly groupCount: number;
  readonly lastAccessed: string | null;
  readonly remembered: boolean;
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

  constructor(deps: VaultManagerDeps) {
    this.vaultsDir = deps.vaultsDir;
    this.autoLockMs = deps.autoLockMs;
    this.logger = deps.logger.child({ component: 'vault-manager' });
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
      const passwordFilePath = this.getPasswordFilePath(name);
      const fileExists = existsSync(filePath);
      const unlocked = store.isUnlocked;
      const remembered = existsSync(passwordFilePath);

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
        remembered,
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
      store.lock();
    }

    const vaultFile = this.getVaultFilePath(name);
    if (existsSync(vaultFile)) {
      unlinkSync(vaultFile);
    }

    const passwordFile = this.getPasswordFilePath(name);
    if (existsSync(passwordFile)) {
      unlinkSync(passwordFile);
    }

    this.vaults.delete(name);
    this.logger.info({ vault: name }, 'vault deleted');
  }

  /**
   * Returns the password file path for a given vault name.
   *
   * @param name - Vault name.
   * @returns Absolute path to the password file.
   */
  getPasswordFilePath(name: string): string {
    return join(this.vaultsDir, `.secrets-password-${name}`);
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
