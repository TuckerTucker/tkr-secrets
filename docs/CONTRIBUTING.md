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

Tests use Bun's built-in test runner. Test files are colocated with source:

| Test File | Covers |
|-----------|--------|
| `src/crypto.test.ts` | Encryption, key derivation, key wrapping |
| `src/store.test.ts` | SecretsStore CRUD, auto-lock, atomic writes |
| `src/router.test.ts` | HTTP API integration (routes, status codes, envelopes) |

### Test Patterns

- Table-driven tests with `describe` / `it` blocks
- Isolated temp directories per test (no shared state)
- Constructor-injected test logger (suppresses output)

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
- File permissions `0o600` for password files
- Validate all input at the API boundary

### Bash Scripts

- Bash 3.2 compatible (macOS default)
