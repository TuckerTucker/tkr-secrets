import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../types.js';
import { VaultManager } from '../vault-manager.js';
import { ImportStore } from '../import.js';
import { createVaultRouter } from '../http/vault-router.js';
import type { VaultRouter } from '../http/vault-router.js';

/** No-op logger for tests. */
function createTestLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    trace: noop as Logger['trace'],
    debug: noop as Logger['debug'],
    info: noop as Logger['info'],
    warn: noop as Logger['warn'],
    error: noop as Logger['error'],
    fatal: noop as Logger['fatal'],
    child: () => logger,
  };
  return logger;
}

interface TestHarness {
  router: VaultRouter;
  vaultManager: VaultManager;
  importStore: ImportStore;
  tmpDir: string;
}

function createHarness(): TestHarness {
  const tmpDir = mkdtempSync(join(tmpdir(), 'vault-router-test-'));
  const logger = createTestLogger();
  const vaultManager = new VaultManager({ vaultsDir: tmpDir, autoLockMs: 300_000, logger });
  const importStore = new ImportStore();
  const router = createVaultRouter({ vaultManager, importStore, logger });
  return { router, vaultManager, importStore, tmpDir };
}

function req(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = { method };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers = { 'Content-Type': 'application/json' };
  }
  return new Request(`http://localhost${path}`, opts);
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

const PASSWORD = 'test-password-123';

describe('vault-router', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createHarness();
  });

  afterEach(() => {
    rmSync(h.tmpDir, { recursive: true, force: true });
  });

  // --- match ---

  test('match returns true for /api/vaults paths', () => {
    expect(h.router.match('GET', '/api/vaults')).toBe(true);
    expect(h.router.match('POST', '/api/vaults')).toBe(true);
    expect(h.router.match('GET', '/api/vaults/myapp/status')).toBe(true);
  });

  test('match returns false for non-vault paths', () => {
    expect(h.router.match('GET', '/api/secrets')).toBe(false);
    expect(h.router.match('GET', '/other')).toBe(false);
  });

  // --- Create vault ---

  test('POST /api/vaults creates vault and returns recovery key', async () => {
    const res = await h.router.handle(req('POST', '/api/vaults', { name: 'myapp', password: PASSWORD }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.success).toBe(true);
    const data = body.data as Record<string, unknown>;
    expect(data.name).toBe('myapp');
    const rk = data.recoveryKey as Record<string, unknown>;
    expect(rk.mnemonic).toBeDefined();
    expect(rk.raw).toBeDefined();
    expect(rk.qr).toBeDefined();
    expect(typeof rk.mnemonic).toBe('string');
    expect((rk.raw as string).length).toBe(64);
  });

  test('POST /api/vaults with invalid name returns 400', async () => {
    const res = await h.router.handle(req('POST', '/api/vaults', { name: 'INVALID', password: PASSWORD }));
    expect(res.status).toBe(400);
  });

  test('POST /api/vaults duplicate returns 409', async () => {
    await h.router.handle(req('POST', '/api/vaults', { name: 'myapp', password: PASSWORD }));
    const res = await h.router.handle(req('POST', '/api/vaults', { name: 'myapp', password: PASSWORD }));
    expect(res.status).toBe(409);
  });

  test('POST /api/vaults missing password returns 400', async () => {
    const res = await h.router.handle(req('POST', '/api/vaults', { name: 'myapp' }));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toBe('password required');
  });

  // --- List vaults ---

  test('GET /api/vaults lists registered vaults', async () => {
    await h.router.handle(req('POST', '/api/vaults', { name: 'aaa', password: PASSWORD }));
    await h.router.handle(req('POST', '/api/vaults', { name: 'bbb', password: PASSWORD }));

    const res = await h.router.handle(req('GET', '/api/vaults'));
    expect(res.status).toBe(200);
    const body = await json(res);
    const data = body.data as { vaults: Array<{ name: string }> };
    expect(data.vaults.length).toBe(2);
    const names = data.vaults.map((v) => v.name).sort();
    expect(names).toEqual(['aaa', 'bbb']);
  });

  // --- Delete vault ---

  test('DELETE /api/vaults/:name deletes vault', async () => {
    await h.router.handle(req('POST', '/api/vaults', { name: 'myapp', password: PASSWORD }));
    const res = await h.router.handle(req('DELETE', '/api/vaults/myapp'));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect((body.data as Record<string, unknown>).name).toBe('myapp');

    // Verify it's gone
    const list = await h.router.handle(req('GET', '/api/vaults'));
    const listBody = await json(list);
    expect((listBody.data as { vaults: unknown[] }).vaults.length).toBe(0);
  });

  test('DELETE /api/vaults/:name not found returns 404', async () => {
    const res = await h.router.handle(req('DELETE', '/api/vaults/nope'));
    expect(res.status).toBe(404);
  });

  // --- Unlock / Lock ---

  test('POST unlock then lock', async () => {
    // Create vault (auto-unlocked), then lock it
    await h.router.handle(req('POST', '/api/vaults', { name: 'myapp', password: PASSWORD }));
    await h.router.handle(req('POST', '/api/vaults/myapp/lock'));

    // Unlock
    const res = await h.router.handle(req('POST', '/api/vaults/myapp/unlock', { password: PASSWORD }));
    expect(res.status).toBe(200);
    const body = await json(res);
    const data = body.data as { secretCount: number; groupCount: number };
    expect(data.secretCount).toBe(0);
    expect(data.groupCount).toBe(0);

    // Lock
    const lockRes = await h.router.handle(req('POST', '/api/vaults/myapp/lock'));
    expect(lockRes.status).toBe(200);
  });

  test('POST unlock wrong password returns 400', async () => {
    await h.router.handle(req('POST', '/api/vaults', { name: 'myapp', password: PASSWORD }));
    await h.router.handle(req('POST', '/api/vaults/myapp/lock'));

    const res = await h.router.handle(req('POST', '/api/vaults/myapp/unlock', { password: 'wrong' }));
    expect(res.status).toBe(400);
  });

  test('POST unlock vault not found returns 404', async () => {
    const res = await h.router.handle(req('POST', '/api/vaults/nope/unlock', { password: PASSWORD }));
    expect(res.status).toBe(404);
  });

  // --- Vault status ---

  test('GET /api/vaults/:name/status returns status', async () => {
    await h.router.handle(req('POST', '/api/vaults', { name: 'myapp', password: PASSWORD }));
    const res = await h.router.handle(req('GET', '/api/vaults/myapp/status'));
    expect(res.status).toBe(200);
    const body = await json(res);
    const data = body.data as Record<string, unknown>;
    expect(data.name).toBe('myapp');
    expect(data.unlocked).toBe(true);
    expect(data.fileExists).toBe(true);
    expect(data.version).toBe(2);
  });

  // --- Secret CRUD ---

  test('secret CRUD lifecycle', async () => {
    await h.router.handle(req('POST', '/api/vaults', { name: 'myapp', password: PASSWORD }));

    // Set secret
    const setRes = await h.router.handle(req('POST', '/api/vaults/myapp/secrets/MY_KEY', { value: 'hello' }));
    expect(setRes.status).toBe(200);
    const setData = (await json(setRes)).data as { name: string; created: boolean };
    expect(setData.created).toBe(true);

    // Get secret
    const getRes = await h.router.handle(req('GET', '/api/vaults/myapp/secrets/MY_KEY'));
    expect(getRes.status).toBe(200);
    const getData = (await json(getRes)).data as { name: string; value: string };
    expect(getData.value).toBe('hello');

    // Update secret
    const updateRes = await h.router.handle(req('POST', '/api/vaults/myapp/secrets/MY_KEY', { value: 'world' }));
    const updateData = (await json(updateRes)).data as { created: boolean };
    expect(updateData.created).toBe(false);

    // List secrets
    const listRes = await h.router.handle(req('GET', '/api/vaults/myapp/secrets'));
    expect(listRes.status).toBe(200);
    const listData = (await json(listRes)).data as { secrets: Array<{ name: string }> };
    expect(listData.secrets.length).toBe(1);
    expect(listData.secrets[0].name).toBe('MY_KEY');

    // Delete secret
    const delRes = await h.router.handle(req('DELETE', '/api/vaults/myapp/secrets/MY_KEY'));
    expect(delRes.status).toBe(200);

    // Delete again => 404
    const delRes2 = await h.router.handle(req('DELETE', '/api/vaults/myapp/secrets/MY_KEY'));
    expect(delRes2.status).toBe(404);

    // Get missing => 404
    const getRes2 = await h.router.handle(req('GET', '/api/vaults/myapp/secrets/MY_KEY'));
    expect(getRes2.status).toBe(404);
  });

  // --- Secrets when locked => 423 ---

  test('secret operations when locked return 423', async () => {
    await h.router.handle(req('POST', '/api/vaults', { name: 'myapp', password: PASSWORD }));
    await h.router.handle(req('POST', '/api/vaults/myapp/lock'));

    const listRes = await h.router.handle(req('GET', '/api/vaults/myapp/secrets'));
    expect(listRes.status).toBe(423);

    const setRes = await h.router.handle(req('POST', '/api/vaults/myapp/secrets/KEY', { value: 'v' }));
    expect(setRes.status).toBe(423);

    const getRes = await h.router.handle(req('GET', '/api/vaults/myapp/secrets/KEY'));
    expect(getRes.status).toBe(423);

    const delRes = await h.router.handle(req('DELETE', '/api/vaults/myapp/secrets/KEY'));
    expect(delRes.status).toBe(423);
  });

  // --- Group CRUD ---

  test('group CRUD lifecycle', async () => {
    await h.router.handle(req('POST', '/api/vaults', { name: 'myapp', password: PASSWORD }));
    await h.router.handle(req('POST', '/api/vaults/myapp/secrets/KEY_A', { value: 'a' }));
    await h.router.handle(req('POST', '/api/vaults/myapp/secrets/KEY_B', { value: 'b' }));

    // Create group
    const createRes = await h.router.handle(req('POST', '/api/vaults/myapp/groups', { name: 'My Group', secrets: ['KEY_A'] }));
    expect(createRes.status).toBe(200);
    const createData = (await json(createRes)).data as { id: string; name: string; order: number };
    expect(createData.name).toBe('My Group');
    expect(typeof createData.id).toBe('string');

    // List groups
    const listRes = await h.router.handle(req('GET', '/api/vaults/myapp/groups'));
    expect(listRes.status).toBe(200);
    const listData = (await json(listRes)).data as { groups: Array<{ id: string; name: string; secrets: string[] }>; ungrouped: string[] };
    expect(listData.groups.length).toBe(1);
    expect(listData.groups[0].secrets).toContain('KEY_A');
    expect(listData.ungrouped).toContain('KEY_B');

    // Update group
    const updateRes = await h.router.handle(req('PATCH', `/api/vaults/myapp/groups/${createData.id}`, { name: 'Renamed', addSecrets: ['KEY_B'] }));
    expect(updateRes.status).toBe(200);
    const updateData = (await json(updateRes)).data as { id: string; name: string };
    expect(updateData.name).toBe('Renamed');

    // Delete group
    const delRes = await h.router.handle(req('DELETE', `/api/vaults/myapp/groups/${createData.id}`));
    expect(delRes.status).toBe(200);
    const delData = (await json(delRes)).data as { id: string; ungroupedSecrets: string[] };
    expect(delData.ungroupedSecrets).toContain('KEY_A');
    expect(delData.ungroupedSecrets).toContain('KEY_B');
  });

  // --- Groups when locked => 423 ---

  test('group operations when locked return 423', async () => {
    await h.router.handle(req('POST', '/api/vaults', { name: 'myapp', password: PASSWORD }));
    await h.router.handle(req('POST', '/api/vaults/myapp/lock'));

    const listRes = await h.router.handle(req('GET', '/api/vaults/myapp/groups'));
    expect(listRes.status).toBe(423);

    const createRes = await h.router.handle(req('POST', '/api/vaults/myapp/groups', { name: 'G' }));
    expect(createRes.status).toBe(423);
  });

  // --- Reorder ---

  test('PUT /api/vaults/:name/order reorders secrets', async () => {
    await h.router.handle(req('POST', '/api/vaults', { name: 'myapp', password: PASSWORD }));
    await h.router.handle(req('POST', '/api/vaults/myapp/secrets/A', { value: '1' }));
    await h.router.handle(req('POST', '/api/vaults/myapp/secrets/B', { value: '2' }));

    const res = await h.router.handle(req('PUT', '/api/vaults/myapp/order', { secretOrder: ['B', 'A'] }));
    expect(res.status).toBe(200);
  });

  // --- Change password ---

  test('POST change-password works', async () => {
    await h.router.handle(req('POST', '/api/vaults', { name: 'myapp', password: PASSWORD }));
    await h.router.handle(req('POST', '/api/vaults/myapp/secrets/KEY', { value: 'v' }));

    const res = await h.router.handle(req('POST', '/api/vaults/myapp/change-password', {
      currentPassword: PASSWORD,
      newPassword: 'new-pw-456',
    }));
    expect(res.status).toBe(200);

    // Lock and unlock with new password
    await h.router.handle(req('POST', '/api/vaults/myapp/lock'));
    const unlockRes = await h.router.handle(req('POST', '/api/vaults/myapp/unlock', { password: 'new-pw-456' }));
    expect(unlockRes.status).toBe(200);
  });

  // --- Recovery ---

  test('POST recover resets password and returns new recovery key', async () => {
    // Create vault, capture recovery key
    const createRes = await h.router.handle(req('POST', '/api/vaults', { name: 'myapp', password: PASSWORD }));
    const createData = (await json(createRes)).data as { recoveryKey: { raw: string } };
    const recoveryHex = createData.recoveryKey.raw;

    // Add a secret
    await h.router.handle(req('POST', '/api/vaults/myapp/secrets/KEY', { value: 'secret-val' }));
    await h.router.handle(req('POST', '/api/vaults/myapp/lock'));

    // Recover
    const recoverRes = await h.router.handle(req('POST', '/api/vaults/myapp/recover', {
      recoveryKey: recoveryHex,
      newPassword: 'recovered-pw',
    }));
    expect(recoverRes.status).toBe(200);
    const recoverData = (await json(recoverRes)).data as { recoveryKey: { raw: string; mnemonic: string } };
    expect(recoverData.recoveryKey.raw.length).toBe(64);

    // Verify we can access the secret with new password
    // Store is auto-unlocked after recovery, so just read
    const getRes = await h.router.handle(req('GET', '/api/vaults/myapp/secrets/KEY'));
    expect(getRes.status).toBe(200);
    expect(((await json(getRes)).data as { value: string }).value).toBe('secret-val');
  });

  // --- Import preview/confirm ---

  test('import preview and confirm workflow', async () => {
    await h.router.handle(req('POST', '/api/vaults', { name: 'myapp', password: PASSWORD }));
    await h.router.handle(req('POST', '/api/vaults/myapp/secrets/EXISTING', { value: 'old' }));

    // Preview
    const previewRes = await h.router.handle(req('POST', '/api/vaults/myapp/import', {
      content: 'NEW_KEY=hello\nEXISTING=updated\n',
    }));
    expect(previewRes.status).toBe(200);
    const previewBody = await json(previewRes);
    const previewData = previewBody.data as { preview: { add: unknown[]; update: unknown[] }; importId: string };
    expect(previewData.preview.add.length).toBe(1);
    expect(previewData.preview.update.length).toBe(1);
    expect(typeof previewData.importId).toBe('string');

    // Confirm
    const confirmRes = await h.router.handle(req('POST', '/api/vaults/myapp/import/confirm', {
      importId: previewData.importId,
    }));
    expect(confirmRes.status).toBe(200);
    const confirmData = (await json(confirmRes)).data as { added: number; updated: number };
    expect(confirmData.added).toBe(1);
    expect(confirmData.updated).toBe(1);

    // Verify import applied
    const getRes = await h.router.handle(req('GET', '/api/vaults/myapp/secrets/NEW_KEY'));
    expect(getRes.status).toBe(200);
    expect(((await json(getRes)).data as { value: string }).value).toBe('hello');
  });

  test('import confirm with expired/invalid importId returns 400', async () => {
    await h.router.handle(req('POST', '/api/vaults', { name: 'myapp', password: PASSWORD }));

    const res = await h.router.handle(req('POST', '/api/vaults/myapp/import/confirm', {
      importId: 'nonexistent-uuid',
    }));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toBe('import expired or not found');
  });

  // --- 404 for unknown routes ---

  test('unknown route returns 404', async () => {
    const res = await h.router.handle(req('GET', '/api/vaults/myapp/nonexistent'));
    expect(res.status).toBe(404);
  });
});
