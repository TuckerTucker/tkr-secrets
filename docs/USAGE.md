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
  SecretsStatus,       // { fileExists, unlocked, timeoutRemaining?, keychainAvailable, stayAuthenticated }
  SecretMapping,       // { secretName, envVar, required? }
  RecoveryKeyMaterial, // { mnemonic, raw, qr }
  VaultFileFormat,     // On-disk v2 vault schema
  GroupMeta,           // { name, order }
  SecretsStoreDeps,    // Constructor deps for SecretsStore
  VaultManagerDeps,    // Constructor deps for VaultManager
  VaultSummary,        // Vault listing metadata
  VaultRouter,         // HTTP router interface
  VaultRouterDeps,     // Constructor deps for router
  KeychainProvider,    // Keychain integration interface
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

### Keychain Integration

```typescript
import { MacOSKeychainProvider } from 'tkr-secrets';
import type { KeychainProvider } from 'tkr-secrets';
```

The `MacOSKeychainProvider` uses the macOS `security` CLI to store vault keys in the system keychain, enabling stay-authenticated functionality across server restarts.

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

// Create a vault — returns { store, recoveryKey }
const { store, recoveryKey } = await manager.create('my-vault', 'my-password');
const recovery = await store.init('my-password');
console.log('Recovery mnemonic:', recovery.mnemonic);

// Unlock and use
await store.unlock('my-password');
await store.set('API_KEY', 'sk-abc123');
const value = store.get('API_KEY');

// Lock when done
await store.lock();
```

## Example: Embedding the HTTP API

```typescript
import { createVaultRouter, VaultManager } from 'tkr-secrets';
import { ImportStore } from 'tkr-secrets/import';

const manager = new VaultManager({ vaultsDir: './data', autoLockMs: 300_000, logger });
const importStore = new ImportStore();
const router = createVaultRouter({ vaultManager: manager, importStore, logger });

Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);
    if (router.match(req.method, url.pathname)) {
      return router.handle(req);
    }
    return new Response('Not found', { status: 404 });
  },
});
```

## Example: Injecting Secrets into process.env

```typescript
import { VaultManager, injectAllSecretsToEnv } from 'tkr-secrets';

const manager = new VaultManager({ vaultsDir: './data', autoLockMs: 300_000, logger });
const store = manager.get('production');
await store.unlock('password');

// Inject all secrets as environment variables
injectAllSecretsToEnv(store);

// Now accessible via process.env
console.log(process.env.DATABASE_URL);
```

## Example: Stay Authenticated with Keychain

```typescript
import { VaultManager, MacOSKeychainProvider } from 'tkr-secrets';

const keychain = new MacOSKeychainProvider();

const manager = new VaultManager({
  vaultsDir: './data',
  autoLockMs: 300_000,
  logger,
  keychain,
  keychainService: 'my-app-secrets',
});

// Discover existing vault files on disk
manager.scanAndRegister();

// Auto-unlock vaults that have keychain entries
const unlocked = await manager.tryAutoUnlockAll();
console.log(`Auto-unlocked ${unlocked} vaults`);
```
