# Integration & E2E Testing Plan

## Overview

The existing test suite is entirely unit tests — components are tested in isolation with temp directories and no-op loggers. This plan adds two new layers:

1. **Integration tests** — verify that wired-together backend components work correctly (VaultManager + Keychain + Store + Router as a single system)
2. **E2E tests** — verify the full HTTP server serves requests correctly and the UI interacts with the API as a real user would

No new dependencies are required. Bun's native test runner and `fetch` are sufficient for both layers.

---

## Test File Structure

```
src/__tests__/
  integration/
    keychain-persistence.test.ts    # Keychain + Store + VaultManager wiring
    vault-lifecycle.test.ts         # Multi-vault create → use → lock → unlock → delete
    auto-unlock.test.ts             # scanAndRegister + tryAutoUnlockAll
    import-roundtrip.test.ts        # Import .env → verify secrets → lock → unlock → verify
  e2e/
    server.test.ts                  # Full Bun.serve HTTP tests against real server
    vault-api-flows.test.ts         # Complete user journeys through the API
```

---

## Integration Tests

### 1. `keychain-persistence.test.ts`

Tests the stay-authenticated feature end-to-end at the backend level, using a fake in-memory keychain provider.

**Test Keychain Stub:**
```typescript
class InMemoryKeychainProvider implements KeychainProvider {
  private store = new Map<string, Buffer>();

  isAvailable(): boolean { return true; }

  async store(service: string, account: string, key: Buffer): Promise<void> {
    this.store.set(`${service}:${account}`, Buffer.from(key));
  }

  async retrieve(service: string, account: string): Promise<Buffer | null> {
    return this.store.get(`${service}:${account}`) ?? null;
  }

  async remove(service: string, account: string): Promise<boolean> {
    return this.store.delete(`${service}:${account}`);
  }
}
```

**Tests:**

| Test | Description |
|------|-------------|
| unlock without stayAuthenticated clears keychain on lock | Create vault, unlock with `stayAuthenticated=false`, lock, verify keychain entry removed |
| unlock with stayAuthenticated saves VK to keychain | Create vault, unlock with `stayAuthenticated=true`, verify keychain has entry |
| lock with stayAuthenticated preserves keychain entry | Unlock with persist, lock, verify keychain entry still present |
| tryAutoUnlock succeeds when keychain has entry | Unlock with persist, lock, create new store with same keychain, call `tryAutoUnlock()`, verify unlocked |
| tryAutoUnlock fails when keychain is empty | Lock without persist (clears keychain), create new store, call `tryAutoUnlock()`, verify still locked |
| tryAutoUnlock sets persistSession to true | Auto-unlock via keychain, verify `status().stayAuthenticated === true` |
| status reflects keychainAvailable | Create store with keychain, verify `status().keychainAvailable === true`; create without, verify `false` |
| status reflects stayAuthenticated | Unlock with/without persist, check `status().stayAuthenticated` matches |
| changing stayAuthenticated on re-unlock | Unlock with persist=true, lock, unlock with persist=false, verify keychain cleared |
| keychain failure on save is non-fatal | Use a keychain stub that throws on `store()`, verify unlock still succeeds |
| keychain failure on remove is non-fatal | Use a keychain stub that throws on `remove()`, verify lock still succeeds |

### 2. `auto-unlock.test.ts`

Tests the VaultManager `scanAndRegister()` and `tryAutoUnlockAll()` methods.

**Tests:**

| Test | Description |
|------|-------------|
| scanAndRegister discovers vault files on disk | Create vault files in temp dir, call `scanAndRegister()`, verify `get()` returns stores |
| scanAndRegister skips already-registered vaults | Register vault via `create()`, call `scanAndRegister()`, verify no duplicate |
| scanAndRegister ignores non-vault files | Place random `.json` files in dir, verify they're not registered |
| scanAndRegister handles empty directory | Call on empty dir, verify no error |
| scanAndRegister handles missing directory | Call with nonexistent dir path, verify no error |
| tryAutoUnlockAll unlocks vaults with keychain entries | Create 2 vaults, persist both, lock both, create new manager with same keychain, scan, auto-unlock, verify both unlocked |
| tryAutoUnlockAll skips vaults without keychain entries | Create 2 vaults, persist only one, lock both, new manager, scan, auto-unlock, verify only one unlocked |
| tryAutoUnlockAll returns correct count | Verify return value matches number of vaults actually unlocked |
| discovered vaults have keychain wired | `scanAndRegister()` passes keychain to new stores, verify via `status().keychainAvailable` |

### 3. `vault-lifecycle.test.ts`

Tests multi-component interactions through the full vault lifecycle.

**Tests:**

| Test | Description |
|------|-------------|
| create → add secrets → lock → unlock → secrets intact | Full CRUD round-trip verifying encryption/decryption |
| create → add secrets → change password → lock → unlock with new password | Password change preserves data |
| create → add secrets → recover → verify secrets | Recovery key restores access to all secrets |
| create → groups + secrets → lock → unlock → groups intact | Group assignments survive lock/unlock |
| create → import .env → lock → unlock → imported secrets intact | Import data persists through lock cycle |
| multiple vaults operate independently | Operations on vault A don't affect vault B |
| delete vault clears keychain entry | Create with persist, delete, verify keychain entry removed |
| auto-lock timer triggers lock | Create with short autoLockMs (50ms), unlock, wait, verify locked |

### 4. `import-roundtrip.test.ts`

Tests the import flow end-to-end through VaultRouter.

**Tests:**

| Test | Description |
|------|-------------|
| import preview → confirm → secrets available | Full import pipeline |
| import preview → confirm → lock → unlock → secrets still there | Imported data persists through lock cycle |
| import with conflicts shows correct add/update counts | Verify preview correctly classifies new vs existing keys |
| import confirm with wrong importId fails | Verify error handling for stale/invalid import IDs |
| double-confirm same importId fails | Prevent duplicate imports |

---

## E2E Tests

### 5. `server.test.ts`

Starts a real `Bun.serve` instance and tests against it with `fetch()`. Tests the full stack: HTTP server → router → vault manager → store → file system.

**Setup/Teardown:**
```typescript
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tkr-e2e-'));
  // Start server on random port
  server = Bun.serve({
    port: 0, // OS-assigned
    fetch: /* same handler as serve.ts */
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
  rmSync(tmpDir, { recursive: true, force: true });
});
```

**Tests:**

| Test | Description |
|------|-------------|
| GET /api/vaults returns empty list initially | Verify clean startup |
| POST /api/vaults creates vault | Verify 200, response contains recovery key material |
| GET /api/vaults/:name/status returns correct shape | Verify all fields including `keychainAvailable`, `stayAuthenticated` |
| POST unlock → GET secrets → POST lock lifecycle | Full HTTP round-trip |
| POST unlock with stayAuthenticated in body | Verify the parameter is accepted and reflected in status |
| 404 for unknown vault | Verify error handling through the full stack |
| SPA fallback serves index.html for client routes | `GET /vault/myapp` returns HTML, not 404 |
| Static file serving works | `GET /src/styles/main.css` returns CSS content |
| TypeScript transpilation works | `GET /src/main.ts` returns JavaScript |
| CORS / Content-Type headers are correct | Verify JSON responses have correct content type |
| Concurrent requests to different vaults | Verify request isolation |
| Large secret value round-trip | Store and retrieve a 100KB secret value |

### 6. `vault-api-flows.test.ts`

Tests complete user journeys — sequences of API calls that mirror real usage patterns.

**Flows:**

| Flow | Steps |
|------|-------|
| **New user onboarding** | Create vault → save recovery key → add secrets → lock → unlock → verify |
| **Password recovery** | Create vault → add secrets → lock → recover with recovery key → verify secrets → verify new recovery key is different |
| **Stay authenticated journey** | Create → unlock with `stayAuthenticated=true` → lock → verify status shows `stayAuthenticated=true` → simulate restart (new manager + scan + auto-unlock) → verify unlocked |
| **Opt out of stay authenticated** | Previous flow → unlock with `stayAuthenticated=false` → lock → simulate restart → verify NOT auto-unlocked |
| **Multi-vault management** | Create vault A and B → add secrets to both → lock A → verify B still accessible → unlock A → delete B → verify A unaffected |
| **Import and organize** | Create vault → import .env → create groups → assign secrets to groups → lock → unlock → verify grouping preserved |
| **Password change preserves keychain** | Unlock with persist → change password → lock → auto-unlock still works (VK unchanged by password change) |
| **Concurrent vault operations** | Create 3 vaults → add secrets to all concurrently → verify all data correct |

---

## Shared Test Utilities

Create `src/__tests__/helpers.ts`:

```typescript
// Re-export existing null logger
export { createNullLogger } from '../testing.js';

// In-memory keychain for integration tests
export class InMemoryKeychainProvider implements KeychainProvider { ... }

// HTTP request factory (already exists in vault-router.test.ts, extract and share)
export function req(method: string, path: string, body?: unknown): Request { ... }
export async function json(res: Response): Promise<Record<string, unknown>> { ... }

// E2E fetch helper
export function apiFetch(baseUrl: string, method: string, path: string, body?: unknown): Promise<Response> { ... }

// Harness factory for integration tests (with keychain support)
export function createIntegrationHarness(opts?: { keychain?: KeychainProvider }): TestHarness { ... }
```

---

## Test Configuration

No `bunfig.toml` changes needed. Bun discovers `*.test.ts` files automatically. To run specific layers:

```bash
# All tests
bun test

# Unit only
bun test src/__tests__/store.test.ts src/__tests__/crypto.test.ts ...

# Integration only
bun test src/__tests__/integration/

# E2E only
bun test src/__tests__/e2e/
```

Optionally add package.json scripts:

```json
"test:unit": "bun test --filter 'src/__tests__/[^ie]'",
"test:integration": "bun test src/__tests__/integration/",
"test:e2e": "bun test src/__tests__/e2e/"
```

---

## Test Execution Notes

- **No external services required** — all tests use temp dirs, in-memory keychain, and `Bun.serve` on port 0
- **Parallel-safe** — each test uses isolated temp directories and random ports
- **Fast** — no Playwright/browser needed; E2E tests use `fetch()` against the real server
- **macOS Keychain tests** — integration tests use `InMemoryKeychainProvider` so they run on any platform; a separate optional test file can test `MacOSKeychainProvider` directly on macOS CI

---

## Priority Order

1. `keychain-persistence.test.ts` — validates the new stay-authenticated feature
2. `auto-unlock.test.ts` — validates the new scanAndRegister + tryAutoUnlockAll
3. `server.test.ts` — validates the real HTTP server
4. `vault-api-flows.test.ts` — validates complete user journeys
5. `vault-lifecycle.test.ts` — validates multi-component interactions
6. `import-roundtrip.test.ts` — validates import pipeline
