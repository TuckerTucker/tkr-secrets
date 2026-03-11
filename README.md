# tkr-secrets

Encrypted secrets vault with a browser UI and REST API. Store API keys, database URLs, and other sensitive credentials in AES-256-GCM encrypted vaults with multi-vault support, group organization, and password recovery via BIP39 mnemonic phrases.

## Quick Start

```bash
bun install
bun run dev
open http://localhost:3000
```

## Features

- **AES-256-GCM encryption** with Scrypt key derivation
- **Multi-vault support** with independent passwords and auto-lock timers
- **24-word BIP39 recovery keys** (plus hex and QR code formats)
- **Group organization** with drag-and-drop reordering
- **.env file import** with two-phase preview/confirm workflow
- **Auto-lock** with configurable timeout (default 5 minutes)
- **macOS Keychain integration** for stay-authenticated auto-unlock
- **Light/dark theme** with system preference detection

## Architecture

```
┌───────────────────────────────────────────────┐
│  Browser UI          Vanilla TypeScript SPA    │
│  (ui/src/)           History API routing       │
├───────────────────────────────────────────────┤
│  HTTP API            REST + JSON envelope      │
│  (src/http/)         Bun.serve                 │
├───────────────────────────────────────────────┤
│  Crypto Core         AES-256-GCM, Scrypt KDF  │
│  (src/)              Atomic file persistence   │
└───────────────────────────────────────────────┘
```

### Key Hierarchy

| Key | Purpose | Lifecycle |
|-----|---------|-----------|
| **Vault Key (VK)** | 256-bit random, encrypts secrets | Generated at vault creation, wrapped by PK and RK |
| **Password Key (PK)** | Derived from user password via Scrypt | Re-derived on each unlock |
| **Recovery Key (RK)** | 256-bit random, shown once as BIP39 mnemonic | Generated at creation, used for password reset |

## Project Structure

```
tkr-secrets/
├── src/
│   ├── crypto.ts            # AES-256-GCM, Scrypt KDF, key wrapping
│   ├── store.ts             # SecretsStore (single-vault CRUD, auto-lock)
│   ├── vault-manager.ts     # Multi-vault registry, disk discovery
│   ├── recovery.ts          # BIP39 mnemonic, QR generation
│   ├── groups.ts            # Group CRUD, ordering
│   ├── import.ts            # .env parser, two-phase import
│   ├── keychain.ts          # macOS Keychain integration
│   ├── server.ts            # Bun.serve factory
│   ├── http/
│   │   └── vault-router.ts  # REST API router
│   └── __tests__/           # Unit, integration, E2E tests
├── ui/
│   └── src/
│       ├── main.ts          # App bootstrap, screen routing
│       ├── icons.ts         # Inline SVG icons
│       └── screens/         # Picker, init, unlock, manage, recover
├── docs/                    # Architecture, security, API docs
├── spec-docs/               # Full API spec, design tokens
└── serve.ts                 # Dev server entry point
```

## API

All endpoints return `{ success: true, data: {...} }` or `{ success: false, error: "..." }`.

### Vault Lifecycle

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/vaults` | List all vaults |
| `POST` | `/api/vaults` | Create vault `{name, password}` |
| `DELETE` | `/api/vaults/:name` | Delete vault |
| `GET` | `/api/vaults/:name/status` | Vault status |
| `POST` | `/api/vaults/:name/unlock` | Unlock `{password, stayAuthenticated?}` |
| `POST` | `/api/vaults/:name/lock` | Lock vault |
| `POST` | `/api/vaults/:name/change-password` | Change password |
| `POST` | `/api/vaults/:name/recover` | Reset via recovery key |

### Secrets (requires unlock)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/vaults/:name/secrets` | List secrets |
| `GET` | `/api/vaults/:name/secrets/:secret` | Get secret value |
| `POST` | `/api/vaults/:name/secrets/:secret` | Create/update `{value, group?}` |
| `DELETE` | `/api/vaults/:name/secrets/:secret` | Delete secret |

### Groups (requires unlock)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/vaults/:name/groups` | List groups |
| `POST` | `/api/vaults/:name/groups` | Create group `{name}` |
| `PATCH` | `/api/vaults/:name/groups/:group` | Rename/move secrets |
| `DELETE` | `/api/vaults/:name/groups/:group` | Delete group |
| `PUT` | `/api/vaults/:name/order` | Reorder secrets/groups |

### Import (requires unlock)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/vaults/:name/import` | Preview `.env` import |
| `POST` | `/api/vaults/:name/import/confirm` | Apply import `{importId}` |

See [spec-docs/API-SPEC.md](spec-docs/API-SPEC.md) for full request/response schemas.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `VAULTS_DIR` | `.data/` | Vault file storage directory |

## Scripts

```bash
bun run dev              # Dev server with hot reload
bun run build            # Build library + UI
bun run build:lib        # Build library only
bun run build:ui         # Build UI only (minified)
bun run typecheck        # TypeScript strict validation
bun test                 # All tests
bun run test:integration # Integration tests
bun run test:e2e         # E2E tests
```

## Library Usage

```typescript
import { VaultManager, MacOSKeychainProvider, createVaultRouter } from "tkr-secrets";
import pino from "pino";

const logger = pino();
const manager = new VaultManager({ vaultsDir: "./vaults", logger });
await manager.scanAndRegister();

const router = createVaultRouter({ vaultManager: manager, logger });
```

## Security

- All secrets encrypted at rest with AES-256-GCM (authenticated encryption)
- Password-derived keys via Scrypt (cost=16384, blockSize=8)
- Vault keys zeroed from memory on lock/auto-lock
- Atomic writes (temp file + rename) prevent corruption
- No plaintext export by design

See [docs/SECURITY.md](docs/SECURITY.md) for the full threat model.

## Tech Stack

- **Runtime:** [Bun](https://bun.sh)
- **Language:** TypeScript (strict mode, ES2022)
- **Encryption:** `node:crypto` (AES-256-GCM, Scrypt)
- **Mnemonics:** [bip39](https://github.com/bitcoinjs/bip39)
- **QR Codes:** [qrcode](https://github.com/soldair/node-qrcode)
- **Frontend:** Vanilla TypeScript (no framework)
- **Testing:** `bun:test`
