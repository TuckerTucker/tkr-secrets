# Contributing

## Prerequisites

- [Bun](https://bun.sh) (runtime and build tool)
- Node.js 18+ (for `node:crypto` compatibility — Bun provides this natively)

## Setup

```bash
git clone <repo-url>
cd tkr-secrets
bun install
```

## Development

```bash
# Start dev server with hot reload (port 3000)
bun run dev

# UI is at http://localhost:3000
# API is at http://localhost:3000/api/vaults
```

The dev server (`serve.ts`) uses `Bun.serve()` with on-the-fly TypeScript transpilation for UI files.

## Build

```bash
bun run build        # Build lib + UI
bun run build:lib    # Library only → dist/lib/
bun run build:ui     # UI only → dist/ui/
```

## Type Checking

```bash
bun run typecheck
```

Runs `tsc --noEmit` with strict mode for both the library and UI source.

## Testing

```bash
bun test
```

Tests use Bun's built-in test runner across three layers:

```bash
bun test                          # All tests
bun test src/__tests__/integration/  # Integration only
bun test src/__tests__/e2e/          # E2E only
```

| Layer | Test Files | Covers |
|-------|-----------|--------|
| Unit | `src/__tests__/crypto.test.ts` | Encryption, key derivation, key wrapping |
| Unit | `src/__tests__/store.test.ts` | SecretsStore CRUD, auto-lock, atomic writes |
| Unit | `src/__tests__/vault-router.test.ts` | HTTP API routes, status codes, envelopes |
| Integration | `src/__tests__/integration/keychain-persistence.test.ts` | Stay-authenticated keychain lifecycle |
| Integration | `src/__tests__/integration/auto-unlock.test.ts` | Vault discovery and auto-unlock |
| Integration | `src/__tests__/integration/vault-lifecycle.test.ts` | Multi-vault create/lock/unlock/delete |
| Integration | `src/__tests__/integration/import-roundtrip.test.ts` | Import pipeline end-to-end |
| E2E | `src/__tests__/e2e/server.test.ts` | Real HTTP server, static files, SPA fallback |
| E2E | `src/__tests__/e2e/vault-api-flows.test.ts` | Complete user journeys through the API |

Shared test utilities (in-memory keychain, request helpers, harness factories) are in `src/__tests__/helpers.ts`.

### Test Patterns

- Table-driven tests with `describe` / `test` blocks
- Isolated temp directories per test (no shared state)
- Constructor-injected test logger (suppresses output)
- `InMemoryKeychainProvider` for platform-independent keychain testing
- E2E tests use `Bun.serve` on port 0 (OS-assigned) with real `fetch()`

## Code Conventions

### TypeScript

- **Strict mode** — `"strict": true` in tsconfig
- **ES Modules** — `"type": "module"` in package.json, `import`/`export` syntax
- **Named exports** — no default exports
- **Explicit return types** on exported functions
- **`async`/`await`** over raw Promises

### Logging

- Use the injected `Logger` interface (pino-compatible)
- Log function entry/exit for significant operations
- Log errors with context (vault name, operation, relevant IDs)
- Use `.child()` to create scoped loggers per component

### File Organization

- One module per concern (crypto, store, groups, recovery, import)
- Types in `types.ts`, re-exported from `index.ts`
- HTTP layer in `src/http/` — separated from core logic
- UI screens in `ui/src/screens/` — one file per screen

### Error Handling

- Throw descriptive errors in core modules
- HTTP layer catches and wraps in `{ success: false, error: "..." }` envelope
- Never swallow errors silently — log and propagate

### Security

- Never log secret values
- Zero sensitive buffers after use (`buffer.fill(0)`)
- Atomic writes for all file mutations
- Keychain operations are non-fatal (failures logged, not thrown)
- Validate all input at the API boundary

### Bash Scripts

- Bash 3.2 compatible (macOS default)
