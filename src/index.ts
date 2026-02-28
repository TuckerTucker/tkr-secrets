export type { Logger, SecretsStatus, SecretMapping, RecoveryKeyMaterial, VaultFileFormat, GroupMeta } from './types.js';
export { DEFAULT_AUTO_LOCK_MS, SECRET_NAME_RE } from './types.js';
export { generateSalt, deriveKey, encrypt, decrypt, generateVaultKey, wrapKey, unwrapKey } from './crypto.js';
export {
  generateRecoveryKey,
  recoveryKeyToMnemonic,
  mnemonicToRecoveryKey,
  parseRecoveryKeyInput,
  generateRecoveryQR,
  buildRecoveryKeyMaterial,
  buildRecoveryFile,
} from './recovery.js';
export {
  resolvePasswordFilePath,
  readPasswordFile,
  writePasswordFile,
  deletePasswordFile,
  isPasswordRemembered,
} from './password-file.js';
export { SecretsStore } from './store.js';
export type { SecretsStoreDeps } from './store.js';
export { VaultManager, validateVaultName } from './vault-manager.js';
export type { VaultManagerDeps, VaultSummary } from './vault-manager.js';
export { injectSecretsToEnv, injectAllSecretsToEnv } from './env-bridge.js';
export { createVaultRouter } from './http/vault-router.js';
export type { VaultRouter, VaultRouterDeps } from './http/vault-router.js';
