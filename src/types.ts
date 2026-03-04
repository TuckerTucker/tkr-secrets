/**
 * Types and constants for encrypted secrets management.
 */

/** Structured logger interface compatible with pino and similar libraries. */
export interface Logger {
  trace(msg: string): void;
  trace(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  fatal(msg: string): void;
  fatal(obj: Record<string, unknown>, msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** On-disk format for the encrypted secrets file. */
export interface SecretsFileFormat {
  readonly version: 1;
  readonly salt: string;
  readonly secrets: Record<string, string>;
}

/** Runtime status of the secrets store. */
export interface SecretsStatus {
  readonly fileExists: boolean;
  readonly unlocked: boolean;
  readonly timeoutRemaining?: number;
  readonly keychainAvailable: boolean;
  readonly stayAuthenticated: boolean;
}

/** Mapping from a stored secret to a process environment variable. */
export interface SecretMapping {
  readonly secretName: string;
  readonly envVar: string;
  readonly required?: boolean;
}

/** Default auto-lock timeout in milliseconds (5 minutes). */
export const DEFAULT_AUTO_LOCK_MS = 300_000;

/** Recovery key material returned to the user (never stored). */
export interface RecoveryKeyMaterial {
  readonly mnemonic: string;
  readonly raw: string;
  readonly qr: string;
}

/** On-disk format for the v2 vault file with key wrapping. */
export interface VaultFileFormat {
  readonly version: 2;
  readonly salt: string;
  readonly passwordWrappedKey: string;
  readonly recoveryWrappedKey: string;
  readonly groups: Record<string, GroupMeta>;
  readonly order: string[];
  readonly secretGroups: Record<string, string>;
  readonly secrets: Record<string, string>;
}

/** Metadata for a secret group. */
export interface GroupMeta {
  readonly name: string;
  readonly order: number;
}

/** Valid secret name pattern. */
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
