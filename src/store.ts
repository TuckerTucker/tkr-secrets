/**
 * SecretsStore: encrypted secrets CRUD with auto-lock and atomic persistence.
 * Uses v2 vault file format with key wrapping (VK wrapped by PK and RK).
 * Constructor-injected deps — no singletons.
 */

import { dirname, join } from 'node:path';
import { mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Logger, VaultFileFormat, GroupMeta, SecretsFileFormat, SecretsStatus } from './types.js';
import { SECRET_NAME_RE, DEFAULT_AUTO_LOCK_MS } from './types.js';
import { generateSalt, deriveKey, encrypt, decrypt, generateVaultKey, wrapKey, unwrapKey } from './crypto.js';
import { generateRecoveryKey } from './recovery.js';
import type { KeychainProvider } from './keychain.js';

export interface SecretsStoreDeps {
  readonly filePath: string;
  readonly autoLockMs: number;
  readonly logger: Logger;
  /** Optional keychain provider for auto-unlock on macOS. */
  readonly keychain?: KeychainProvider;
  /** Keychain service name (e.g., 'tkr-secrets-vault'). */
  readonly keychainService?: string;
  /** Keychain account name (e.g., vault name). */
  readonly keychainAccount?: string;
}

export class SecretsStore {
  private readonly filePath: string;
  private readonly autoLockMs: number;
  private readonly logger: Logger;
  private readonly keychain?: KeychainProvider;
  private readonly keychainService?: string;
  private readonly keychainAccount?: string;
  private vaultKey: Buffer | null = null;
  private salt: string | null = null;
  private secrets: Map<string, string> = new Map();
  private groups: Map<string, GroupMeta> = new Map();
  private order: string[] = [];
  private secretGroups: Map<string, string> = new Map();
  private passwordWrappedKey: string | null = null;
  private recoveryWrappedKey: string | null = null;
  private lockTimer: ReturnType<typeof setTimeout> | null = null;
  private unlockedAt: number | null = null;
  private persistSession = false;

  constructor(deps: SecretsStoreDeps) {
    this.filePath = deps.filePath;
    this.autoLockMs = deps.autoLockMs;
    this.logger = deps.logger.child({ component: 'secrets-store' });
    this.keychain = deps.keychain;
    this.keychainService = deps.keychainService;
    this.keychainAccount = deps.keychainAccount;
  }

  /**
   * Initializes a new vault file with the given password.
   *
   * Generates a vault key (VK), wraps it with both a password-derived key (PK)
   * and a recovery key (RK), then persists the v2 file format.
   *
   * @param password - Master password for the vault.
   * @returns Recovery key (RK) as a 32-byte Buffer. Caller is responsible for
   *   building {@link RecoveryKeyMaterial} from this.
   */
  async init(password: string): Promise<Buffer> {
    if (await this.fileExists()) {
      throw new Error('secrets file already exists — use unlock() instead');
    }

    this.salt = generateSalt();
    const pk = deriveKey(password, this.salt);
    const vk = generateVaultKey();
    const rk = generateRecoveryKey();

    this.passwordWrappedKey = wrapKey(pk, vk);
    this.recoveryWrappedKey = wrapKey(rk, vk);
    this.vaultKey = vk;
    this.secrets = new Map();
    this.groups = new Map();
    this.order = [];
    this.secretGroups = new Map();
    this.unlockedAt = Date.now();

    await this.persist();
    this.resetLockTimer();
    this.logger.info('secrets store initialized');

    return rk;
  }

  /**
   * Unlocks an existing vault file with the given password.
   *
   * Derives the password key, unwraps the vault key, then decrypts all secrets.
   *
   * @param password - Master password.
   * @param stayAuthenticated - If true, saves VK to keychain for auto-unlock.
   * @throws Error if the password is incorrect or the file is missing.
   */
  async unlock(password: string, stayAuthenticated = false): Promise<void> {
    const data = await this.readFile();
    if (!data) {
      throw new Error('secrets file not found — use init() first');
    }

    this.salt = data.salt;
    const pk = deriveKey(password, this.salt);

    let vk: Buffer;
    try {
      vk = unwrapKey(pk, data.passwordWrappedKey);
    } catch {
      throw new Error('invalid password');
    }

    // Decrypt all secrets using VK
    const decrypted = new Map<string, string>();
    try {
      for (const [name, ciphertext] of Object.entries(data.secrets)) {
        decrypted.set(name, decrypt(ciphertext, vk));
      }
    } catch {
      vk.fill(0);
      throw new Error('invalid password');
    }

    this.vaultKey = vk;
    this.secrets = decrypted;
    this.passwordWrappedKey = data.passwordWrappedKey;
    this.recoveryWrappedKey = data.recoveryWrappedKey;
    this.groups = new Map(Object.entries(data.groups));
    this.order = [...data.order];
    this.secretGroups = new Map(Object.entries(data.secretGroups));
    this.unlockedAt = Date.now();
    this.persistSession = stayAuthenticated;
    this.resetLockTimer();
    this.logger.info({ count: this.secrets.size }, 'secrets store unlocked');

    if (stayAuthenticated) {
      await this.saveToKeychain(vk);
    } else {
      await this.removeFromKeychain();
    }
  }

  /**
   * Attempts auto-unlock without user interaction.
   *
   * Tries in order:
   * 1. macOS Keychain — retrieve VK directly
   * 2. TKR_VAULT_PASSWORD env var — derive PK, unwrap VK
   * 3. Password file — read stored password, derive PK, unwrap VK
   *
   * @returns true if the store was unlocked, false if manual unlock is needed.
   */
  async tryAutoUnlock(): Promise<boolean> {
    const data = await this.readFile();
    if (!data) return false;

    // 1. Try keychain
    if (this.keychain?.isAvailable() && this.keychainService && this.keychainAccount) {
      try {
        const vk = await this.keychain.retrieve(this.keychainService, this.keychainAccount);
        if (vk) {
          const decrypted = new Map<string, string>();
          for (const [name, ciphertext] of Object.entries(data.secrets)) {
            decrypted.set(name, decrypt(ciphertext, vk));
          }
          this.vaultKey = vk;
          this.salt = data.salt;
          this.secrets = decrypted;
          this.passwordWrappedKey = data.passwordWrappedKey;
          this.recoveryWrappedKey = data.recoveryWrappedKey;
          this.groups = new Map(Object.entries(data.groups));
          this.order = [...data.order];
          this.secretGroups = new Map(Object.entries(data.secretGroups));
          this.persistSession = true;
          this.unlockedAt = Date.now();
          this.resetLockTimer();
          this.logger.info({ method: 'keychain', count: this.secrets.size }, 'auto-unlock succeeded');
          return true;
        }
      } catch (err) {
        this.logger.debug({ err }, 'keychain auto-unlock failed — trying next method');
      }
    }

    // 2. Try env var
    const envPassword = process.env['TKR_VAULT_PASSWORD'];
    if (envPassword) {
      try {
        await this.unlock(envPassword);
        this.logger.info({ method: 'env' }, 'auto-unlock succeeded via TKR_VAULT_PASSWORD');
        return true;
      } catch {
        this.logger.warn('TKR_VAULT_PASSWORD set but unlock failed — invalid password');
      }
    }

    return false;
  }

  /**
   * Locks the store, zeroing the vault key from memory and clearing all state.
   */
  lock(): void {
    if (this.vaultKey) {
      this.vaultKey.fill(0);
    }
    this.vaultKey = null;
    this.salt = null;
    this.secrets = new Map();
    this.groups = new Map();
    this.order = [];
    this.secretGroups = new Map();
    this.passwordWrappedKey = null;
    this.recoveryWrappedKey = null;
    this.unlockedAt = null;
    this.clearLockTimer();

    if (!this.persistSession) {
      void this.removeFromKeychain();
    }

    this.logger.info('secrets store locked');
  }

  /**
   * Changes the vault password without changing the vault key or recovery key.
   *
   * @param currentPassword - Current master password.
   * @param newPassword - New master password.
   * @throws Error if currentPassword is incorrect.
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const data = await this.readFile();
    if (!data) {
      throw new Error('secrets file not found');
    }

    const oldPk = deriveKey(currentPassword, data.salt);
    let vk: Buffer;
    try {
      vk = unwrapKey(oldPk, data.passwordWrappedKey);
    } catch {
      throw new Error('invalid password');
    }

    const newSalt = generateSalt();
    const newPk = deriveKey(newPassword, newSalt);
    const newPasswordWrappedKey = wrapKey(newPk, vk);

    // Re-encrypt all secrets with VK (new IVs)
    const encrypted: Record<string, string> = {};
    for (const [name, ciphertext] of Object.entries(data.secrets)) {
      const plaintext = decrypt(ciphertext, vk);
      encrypted[name] = encrypt(plaintext, vk);
    }

    const newData: VaultFileFormat = {
      version: 2,
      salt: newSalt,
      passwordWrappedKey: newPasswordWrappedKey,
      recoveryWrappedKey: data.recoveryWrappedKey,
      groups: data.groups,
      order: data.order,
      secretGroups: data.secretGroups,
      secrets: encrypted,
    };

    await this.writeFileAtomic(newData);

    // Update in-memory state if currently unlocked
    if (this.vaultKey) {
      this.salt = newSalt;
      this.passwordWrappedKey = newPasswordWrappedKey;
      // Re-decrypt secrets to update in-memory with fresh ciphertexts on next persist
    }

    vk.fill(0);
    this.logger.info('password changed');
  }

  /**
   * Recovers a vault using the recovery key, setting a new password and generating a new recovery key.
   *
   * @param recoveryKey - Current 32-byte recovery key.
   * @param newPassword - New master password.
   * @returns New recovery key as a 32-byte Buffer.
   * @throws Error if the recovery key is incorrect.
   */
  async recover(recoveryKey: Buffer, newPassword: string): Promise<Buffer> {
    const data = await this.readFile();
    if (!data) {
      throw new Error('secrets file not found');
    }

    let vk: Buffer;
    try {
      vk = unwrapKey(recoveryKey, data.recoveryWrappedKey);
    } catch {
      throw new Error('invalid recovery key');
    }

    // Verify integrity by decrypting all secrets
    const decrypted = new Map<string, string>();
    for (const [name, ciphertext] of Object.entries(data.secrets)) {
      decrypted.set(name, decrypt(ciphertext, vk));
    }

    const newSalt = generateSalt();
    const newPk = deriveKey(newPassword, newSalt);
    const newRk = generateRecoveryKey();

    const newPasswordWrappedKey = wrapKey(newPk, vk);
    const newRecoveryWrappedKey = wrapKey(newRk, vk);

    // Re-encrypt all secrets with VK (new IVs)
    const encrypted: Record<string, string> = {};
    for (const [name, value] of decrypted) {
      encrypted[name] = encrypt(value, vk);
    }

    const newData: VaultFileFormat = {
      version: 2,
      salt: newSalt,
      passwordWrappedKey: newPasswordWrappedKey,
      recoveryWrappedKey: newRecoveryWrappedKey,
      groups: data.groups,
      order: data.order,
      secretGroups: data.secretGroups,
      secrets: encrypted,
    };

    await this.writeFileAtomic(newData);

    // Update in-memory state
    this.vaultKey = vk;
    this.salt = newSalt;
    this.passwordWrappedKey = newPasswordWrappedKey;
    this.recoveryWrappedKey = newRecoveryWrappedKey;
    this.secrets = decrypted;
    this.groups = new Map(Object.entries(data.groups));
    this.order = [...data.order];
    this.secretGroups = new Map(Object.entries(data.secretGroups));
    this.unlockedAt = Date.now();
    this.resetLockTimer();

    this.logger.info('vault recovered with new password and recovery key');
    return newRk;
  }

  /** Gets a secret value by name. Falls back to process.env when locked. */
  get(name: string): string | undefined {
    if (this.vaultKey) {
      this.resetLockTimer();
      return this.secrets.get(name);
    }
    return process.env[name.toUpperCase()];
  }

  /** Returns all decrypted secrets as a Map. Requires unlocked store. */
  getAll(): ReadonlyMap<string, string> {
    this.assertUnlocked();
    this.resetLockTimer();
    return new Map(this.secrets);
  }

  /** Sets a secret value. */
  async set(name: string, value: string): Promise<void> {
    this.assertUnlocked();
    this.validateName(name);
    this.secrets.set(name, value);
    await this.persist();
    this.resetLockTimer();
    this.logger.debug({ name }, 'secret set');
  }

  /** Deletes a secret by name. Returns true if it existed. */
  async delete(name: string): Promise<boolean> {
    this.assertUnlocked();
    const existed = this.secrets.delete(name);
    if (existed) {
      this.secretGroups.delete(name);
      await this.persist();
      this.logger.debug({ name }, 'secret deleted');
    }
    this.resetLockTimer();
    return existed;
  }

  /** Lists all secret names (not values). */
  list(): string[] {
    this.assertUnlocked();
    this.resetLockTimer();
    return [...this.secrets.keys()].sort();
  }

  /** Returns current store status. */
  async status(): Promise<SecretsStatus> {
    const fileExists = await this.fileExists();
    const unlocked = this.vaultKey !== null;
    const timeoutRemaining = unlocked && this.unlockedAt
      ? Math.max(0, this.autoLockMs - (Date.now() - this.unlockedAt))
      : undefined;
    return {
      fileExists,
      unlocked,
      timeoutRemaining,
      keychainAvailable: this.keychain?.isAvailable() ?? false,
      stayAuthenticated: this.persistSession,
    };
  }

  /** Whether the store is currently unlocked. */
  get isUnlocked(): boolean {
    return this.vaultKey !== null;
  }

  // --- Group/Order Accessors ---

  /** Returns a read-only view of group metadata. Requires unlocked. */
  getGroups(): ReadonlyMap<string, GroupMeta> {
    this.assertUnlocked();
    return this.groups;
  }

  /** Returns the current secret ordering. Requires unlocked. */
  getOrder(): readonly string[] {
    this.assertUnlocked();
    return this.order;
  }

  /** Returns a read-only mapping of secret name to group ID. Requires unlocked. */
  getSecretGroups(): ReadonlyMap<string, string> {
    this.assertUnlocked();
    return this.secretGroups;
  }

  /** Returns the number of stored secrets. Requires unlocked. */
  getSecretCount(): number {
    this.assertUnlocked();
    return this.secrets.size;
  }

  /** Returns the number of groups. Requires unlocked. */
  getGroupCount(): number {
    this.assertUnlocked();
    return this.groups.size;
  }

  // --- Group/Order Mutators ---

  /** Replaces groups and persists. Requires unlocked. */
  async setGroups(groups: Map<string, GroupMeta>): Promise<void> {
    this.assertUnlocked();
    this.groups = new Map(groups);
    await this.persist();
  }

  /** Replaces secret ordering and persists. Requires unlocked. */
  async setOrder(order: string[]): Promise<void> {
    this.assertUnlocked();
    this.order = [...order];
    await this.persist();
  }

  /** Replaces secret-to-group mapping and persists. Requires unlocked. */
  async setSecretGroups(secretGroups: Map<string, string>): Promise<void> {
    this.assertUnlocked();
    this.secretGroups = new Map(secretGroups);
    await this.persist();
  }

  // --- Internal ---

  private assertUnlocked(): void {
    if (!this.vaultKey) {
      throw new Error('secrets store is locked');
    }
  }

  private validateName(name: string): void {
    if (!SECRET_NAME_RE.test(name)) {
      throw new Error(`invalid secret name: must match ${SECRET_NAME_RE}`);
    }
  }

  private async fileExists(): Promise<boolean> {
    return Bun.file(this.filePath).exists();
  }

  private async readFile(): Promise<VaultFileFormat | null> {
    const file = Bun.file(this.filePath);
    if (!await file.exists()) return null;
    return JSON.parse(await file.text()) as VaultFileFormat;
  }

  /** Atomic write: write to temp file, then rename. */
  private async persist(): Promise<void> {
    if (!this.vaultKey || !this.salt) return;

    const encrypted: Record<string, string> = {};
    for (const [name, value] of this.secrets) {
      encrypted[name] = encrypt(value, this.vaultKey);
    }

    const data: VaultFileFormat = {
      version: 2,
      salt: this.salt,
      passwordWrappedKey: this.passwordWrappedKey!,
      recoveryWrappedKey: this.recoveryWrappedKey!,
      groups: Object.fromEntries(this.groups),
      order: this.order,
      secretGroups: Object.fromEntries(this.secretGroups),
      secrets: encrypted,
    };

    await this.writeFileAtomic(data);
  }

  /** Writes data atomically via temp file + rename. */
  private async writeFileAtomic(data: VaultFileFormat): Promise<void> {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = join(dir, `.secrets-${randomBytes(8).toString('hex')}.tmp`);
    await Bun.write(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, this.filePath);
  }

  /** Stores the vault key in the system keychain if available. */
  private async saveToKeychain(vk: Buffer): Promise<void> {
    if (!this.keychain?.isAvailable() || !this.keychainService || !this.keychainAccount) return;
    try {
      await this.keychain.store(this.keychainService, this.keychainAccount, vk);
      this.logger.info('vault key saved to keychain');
    } catch (err) {
      this.logger.warn({ err }, 'failed to save vault key to keychain');
    }
  }

  /** Removes the vault key from the system keychain if available. */
  private async removeFromKeychain(): Promise<void> {
    if (!this.keychain?.isAvailable() || !this.keychainService || !this.keychainAccount) return;
    try {
      await this.keychain.remove(this.keychainService, this.keychainAccount);
      this.logger.info('vault key removed from keychain');
    } catch (err) {
      this.logger.warn({ err }, 'failed to remove vault key from keychain');
    }
  }

  private resetLockTimer(): void {
    this.clearLockTimer();
    this.unlockedAt = Date.now();
    this.lockTimer = setTimeout(() => {
      this.logger.info('auto-lock timeout reached');
      this.lock();
    }, this.autoLockMs);
  }

  private clearLockTimer(): void {
    if (this.lockTimer) {
      clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }
  }
}
