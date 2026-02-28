# Library Usage

tkr-secrets exports its core modules for programmatic use. You can embed vault management into other Bun applications without the HTTP layer.

## Installation

```bash
bun add tkr-secrets
```

Or import directly from the source:

```typescript
import { VaultManager, SecretsStore } from 'tkr-secrets';
```

## Public Exports

All exports from `src/index.ts`:

### Types

```typescript
import type {
  Logger,              // Structured logger interface (pino-compatible)
  SecretsStatus,       // { fileExists, unlocked, timeoutRemaining? }
  SecretMapping,       // { secretName, envVar, required? }
  RecoveryKeyMaterial, // { mnemonic, raw, qr }
  VaultFileFormat,     // On-disk v2 vault schema
  GroupMeta,           // { name, order }
  SecretsStoreDeps,    // Constructor deps for SecretsStore
  VaultManagerDeps,    // Constructor deps for VaultManager
  VaultSummary,        // Vault listing metadata
  VaultRouter,         // HTTP router interface
  VaultRouterDeps,     // Constructor deps for router
} from 'tkr-secrets';
```

### Constants

```typescript
import {
  DEFAULT_AUTO_LOCK_MS, // 300_000 (5 minutes)
  SECRET_NAME_RE,       // /^[A-Za-z_][A-Za-z0-9_]*$/
} from 'tkr-secrets';
```

### Crypto Primitives

```typescript
import {
  generateSalt,     // () => string (64-char hex)
  deriveKey,        // (password, salt) => Buffer (256-bit key via Scrypt)
  encrypt,          // (plaintext, key) => string ("iv:ciphertext:tag")
  decrypt,          // (encrypted, key) => string (plaintext)
  generateVaultKey, // () => Buffer (256-bit random)
  wrapKey,          // (wrappingKey, targetKey) => string (encrypted key)
  unwrapKey,        // (wrappingKey, wrappedKey) => Buffer (decrypted key)
} from 'tkr-secrets';
```

### Recovery

```typescript
import {
  generateRecoveryKey,      // () => Buffer (256-bit random)
  recoveryKeyToMnemonic,    // (key) => string (24-word BIP39)
  mnemonicToRecoveryKey,    // (mnemonic) => Buffer
  parseRecoveryKeyInput,    // (input) => Buffer (auto-detects hex or mnemonic)
  generateRecoveryQR,       // (vaultName, hexKey) => Promise<string> (base64 PNG)
  buildRecoveryKeyMaterial, // (vaultName, key) => Promise<RecoveryKeyMaterial>
  buildRecoveryFile,        // (vaultName, key) => string (JSON for .tkr-recovery)
} from 'tkr-secrets';
```

### Password Persistence

```typescript
import {
  resolvePasswordFilePath, // (vaultsDir, vaultName) => string
  readPasswordFile,        // (filePath) => string | null
  writePasswordFile,       // (filePath, password) => void (0o600 perms)
  deletePasswordFile,      // (filePath) => void
  isPasswordRemembered,    // (filePath) => boolean
} from 'tkr-secrets';
```

### Core Classes

```typescript
import { SecretsStore, VaultManager, validateVaultName } from 'tkr-secrets';
```

### Environment Bridge

```typescript
import { injectSecretsToEnv, injectAllSecretsToEnv } from 'tkr-secrets';
```

### HTTP Router

```typescript
import { createVaultRouter } from 'tkr-secrets';
```

## Example: Programmatic Vault Management

```typescript
import { VaultManager } from 'tkr-secrets';

// Provide a pino-compatible logger
const logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child: () => logger,
};

const manager = new VaultManager({
  vaultsDir: './data',
  autoLockMs: 300_000,
  logger,
});

// Create a vault
const store = await manager.createVault('my-vault');
const recovery = await store.init('my-password');
console.log('Recovery mnemonic:', recovery.mnemonic);

// Unlock and use
await store.unlock('my-password');
await store.setSecret('API_KEY', 'sk-abc123');
const value = store.getSecret('API_KEY');

// Lock when done
store.lock();
```

## Example: Embedding the HTTP API

```typescript
import { createVaultRouter, VaultManager } from 'tkr-secrets';

const manager = new VaultManager({ vaultsDir: './data', autoLockMs: 300_000, logger });
const router = createVaultRouter({ manager, logger });

Bun.serve({
  port: 3000,
  async fetch(req) {
    const match = router.match(req);
    if (match) return router.handle(req, match);
    return new Response('Not found', { status: 404 });
  },
});
```

## Example: Injecting Secrets into process.env

```typescript
import { VaultManager, injectAllSecretsToEnv } from 'tkr-secrets';

const manager = new VaultManager({ vaultsDir: './data', autoLockMs: 300_000, logger });
const store = manager.getStore('production');
await store.unlock('password');

// Inject all secrets as environment variables
injectAllSecretsToEnv(store);

// Now accessible via process.env
console.log(process.env.DATABASE_URL);
```
