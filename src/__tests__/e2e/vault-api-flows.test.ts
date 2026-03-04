/**
 * E2E tests for complete user journeys through the vault API.
 *
 * Each test represents a realistic multi-step user workflow,
 * verifying the system behaves correctly end-to-end.
 *
 * @module __tests__/e2e/vault-api-flows
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultManager } from '../../vault-manager.js';
import { createServer } from '../../server.js';
import {
  InMemoryKeychainProvider,
  createNullLogger,
  apiFetch,
  PASSWORD,
} from '../helpers.js';
import type { Server } from 'bun';

describe('vault API flows', () => {
  let server: Server;
  let baseUrl: string;
  let tmpDir: string;
  let keychain: InMemoryKeychainProvider;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tkr-flow-'));
    keychain = new InMemoryKeychainProvider();
    const result = createServer({
      port: 0,
      vaultsDir: tmpDir,
      uiDir: join(import.meta.dir, '..', '..', '..', 'ui'),
      keychain,
      keychainService: 'test-flow',
    });
    server = result.server;
    baseUrl = `http://localhost:${server.port}`;
  });

  afterEach(() => {
    server.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('new user onboarding: create → secrets → lock → unlock → verify', async () => {
    // Create vault
    const createRes = await apiFetch(baseUrl, 'POST', '/api/vaults', { name: 'production', password: PASSWORD });
    expect(createRes.status).toBe(200);
    const createData = await createRes.json() as { data: { recoveryKey: { raw: string } } };
    expect(createData.data.recoveryKey.raw).toHaveLength(64);

    // Add secrets
    await apiFetch(baseUrl, 'POST', '/api/vaults/production/secrets/DB_URL', { value: 'postgres://prod' });
    await apiFetch(baseUrl, 'POST', '/api/vaults/production/secrets/API_KEY', { value: 'sk-prod-123' });

    // Lock
    await apiFetch(baseUrl, 'POST', '/api/vaults/production/lock');

    // Verify locked
    const lockedRes = await apiFetch(baseUrl, 'GET', '/api/vaults/production/secrets');
    expect(lockedRes.status).toBe(423);

    // Unlock
    await apiFetch(baseUrl, 'POST', '/api/vaults/production/unlock', { password: PASSWORD });

    // Verify secrets
    const dbRes = await apiFetch(baseUrl, 'GET', '/api/vaults/production/secrets/DB_URL');
    const dbData = await dbRes.json() as { data: { value: string } };
    expect(dbData.data.value).toBe('postgres://prod');
  });

  test('password recovery flow', async () => {
    // Create vault with secrets
    const createRes = await apiFetch(baseUrl, 'POST', '/api/vaults', { name: 'recoverable', password: PASSWORD });
    const createData = await createRes.json() as { data: { recoveryKey: { raw: string } } };
    const originalRecoveryKey = createData.data.recoveryKey.raw;

    await apiFetch(baseUrl, 'POST', '/api/vaults/recoverable/secrets/IMPORTANT', { value: 'critical-data' });
    await apiFetch(baseUrl, 'POST', '/api/vaults/recoverable/lock');

    // Recover with new password
    const recoverRes = await apiFetch(baseUrl, 'POST', '/api/vaults/recoverable/recover', {
      recoveryKey: originalRecoveryKey,
      newPassword: 'new-secure-pw',
    });
    expect(recoverRes.status).toBe(200);
    const recoverData = await recoverRes.json() as { data: { recoveryKey: { raw: string } } };

    // New recovery key should be different
    expect(recoverData.data.recoveryKey.raw).not.toBe(originalRecoveryKey);

    // Secret should still be accessible
    const getRes = await apiFetch(baseUrl, 'GET', '/api/vaults/recoverable/secrets/IMPORTANT');
    const getData = await getRes.json() as { data: { value: string } };
    expect(getData.data.value).toBe('critical-data');

    // Old password should not work
    await apiFetch(baseUrl, 'POST', '/api/vaults/recoverable/lock');
    const oldPwRes = await apiFetch(baseUrl, 'POST', '/api/vaults/recoverable/unlock', { password: PASSWORD });
    expect(oldPwRes.status).toBe(400);

    // New password works
    const newPwRes = await apiFetch(baseUrl, 'POST', '/api/vaults/recoverable/unlock', { password: 'new-secure-pw' });
    expect(newPwRes.status).toBe(200);
  });

  test('stay authenticated: opt-in → lock → restart → auto-unlock', async () => {
    // Create and unlock with persist
    await apiFetch(baseUrl, 'POST', '/api/vaults', { name: 'persistent', password: PASSWORD });
    await apiFetch(baseUrl, 'POST', '/api/vaults/persistent/secrets/DATA', { value: 'keep-me' });
    await apiFetch(baseUrl, 'POST', '/api/vaults/persistent/lock');
    await apiFetch(baseUrl, 'POST', '/api/vaults/persistent/unlock', {
      password: PASSWORD,
      stayAuthenticated: true,
    });

    // Verify keychain has entry
    expect(keychain.entries.size).toBeGreaterThan(0);

    // Lock — keychain should be preserved
    await apiFetch(baseUrl, 'POST', '/api/vaults/persistent/lock');

    // Simulate restart: stop server, create new one with same keychain and data dir
    server.stop();
    const result2 = createServer({
      port: 0,
      vaultsDir: tmpDir,
      uiDir: join(import.meta.dir, '..', '..', '..', 'ui'),
      keychain,
      keychainService: 'test-flow',
    });
    server = result2.server;
    const baseUrl2 = `http://localhost:${server.port}`;

    // Auto-unlock should have happened via scanAndRegister
    await result2.vaultManager.tryAutoUnlockAll();

    const statusRes = await apiFetch(baseUrl2, 'GET', '/api/vaults/persistent/status');
    const status = await statusRes.json() as { data: { unlocked: boolean } };
    expect(status.data.unlocked).toBe(true);

    // Data should be accessible
    const dataRes = await apiFetch(baseUrl2, 'GET', '/api/vaults/persistent/secrets/DATA');
    const data = await dataRes.json() as { data: { value: string } };
    expect(data.data.value).toBe('keep-me');
  });

  test('stay authenticated: opt-out → restart → NOT auto-unlocked', async () => {
    // Create, persist, then opt out
    await apiFetch(baseUrl, 'POST', '/api/vaults', { name: 'transient', password: PASSWORD });
    await apiFetch(baseUrl, 'POST', '/api/vaults/transient/lock');
    await apiFetch(baseUrl, 'POST', '/api/vaults/transient/unlock', {
      password: PASSWORD,
      stayAuthenticated: true,
    });
    await apiFetch(baseUrl, 'POST', '/api/vaults/transient/lock');

    // Now opt out
    await apiFetch(baseUrl, 'POST', '/api/vaults/transient/unlock', {
      password: PASSWORD,
      stayAuthenticated: false,
    });
    await apiFetch(baseUrl, 'POST', '/api/vaults/transient/lock');

    // Simulate restart
    server.stop();
    const result2 = createServer({
      port: 0,
      vaultsDir: tmpDir,
      uiDir: join(import.meta.dir, '..', '..', '..', 'ui'),
      keychain,
      keychainService: 'test-flow',
    });
    server = result2.server;
    const baseUrl2 = `http://localhost:${server.port}`;

    await result2.vaultManager.tryAutoUnlockAll();

    const statusRes = await apiFetch(baseUrl2, 'GET', '/api/vaults/transient/status');
    const status = await statusRes.json() as { data: { unlocked: boolean } };
    expect(status.data.unlocked).toBe(false);
  });

  test('multi-vault management: independent operations', async () => {
    await apiFetch(baseUrl, 'POST', '/api/vaults', { name: 'vault-alpha', password: PASSWORD });
    await apiFetch(baseUrl, 'POST', '/api/vaults', { name: 'vault-beta', password: 'beta-pw' });

    await apiFetch(baseUrl, 'POST', '/api/vaults/vault-alpha/secrets/KEY', { value: 'alpha-val' });
    await apiFetch(baseUrl, 'POST', '/api/vaults/vault-beta/secrets/KEY', { value: 'beta-val' });

    // Lock alpha, beta stays unlocked
    await apiFetch(baseUrl, 'POST', '/api/vaults/vault-alpha/lock');

    const betaRes = await apiFetch(baseUrl, 'GET', '/api/vaults/vault-beta/secrets/KEY');
    expect(betaRes.status).toBe(200);

    // Delete beta
    await apiFetch(baseUrl, 'DELETE', '/api/vaults/vault-beta');

    // Alpha unaffected
    await apiFetch(baseUrl, 'POST', '/api/vaults/vault-alpha/unlock', { password: PASSWORD });
    const alphaRes = await apiFetch(baseUrl, 'GET', '/api/vaults/vault-alpha/secrets/KEY');
    const alphaData = await alphaRes.json() as { data: { value: string } };
    expect(alphaData.data.value).toBe('alpha-val');
  });

  test('import → organize into groups → lock → unlock → verify', async () => {
    await apiFetch(baseUrl, 'POST', '/api/vaults', { name: 'organized', password: PASSWORD });

    // Import
    const previewRes = await apiFetch(baseUrl, 'POST', '/api/vaults/organized/import', {
      content: 'DB_HOST=localhost\nDB_PORT=5432\nAPI_KEY=secret\n',
    });
    const preview = await previewRes.json() as { data: { importId: string } };
    await apiFetch(baseUrl, 'POST', '/api/vaults/organized/import/confirm', { importId: preview.data.importId });

    // Create group
    const groupRes = await apiFetch(baseUrl, 'POST', '/api/vaults/organized/groups', {
      name: 'Database',
      secrets: ['DB_HOST', 'DB_PORT'],
    });
    expect(groupRes.status).toBe(200);

    // Lock and unlock
    await apiFetch(baseUrl, 'POST', '/api/vaults/organized/lock');
    await apiFetch(baseUrl, 'POST', '/api/vaults/organized/unlock', { password: PASSWORD });

    // Verify groups preserved
    const listRes = await apiFetch(baseUrl, 'GET', '/api/vaults/organized/groups');
    const listData = await listRes.json() as { data: { groups: Array<{ name: string; secrets: string[] }>; ungrouped: string[] } };
    expect(listData.data.groups).toHaveLength(1);
    expect(listData.data.groups[0].name).toBe('Database');
    expect(listData.data.groups[0].secrets).toContain('DB_HOST');
    expect(listData.data.groups[0].secrets).toContain('DB_PORT');
    expect(listData.data.ungrouped).toContain('API_KEY');
  });

  test('password change preserves keychain auto-unlock', async () => {
    // Create and persist
    await apiFetch(baseUrl, 'POST', '/api/vaults', { name: 'pw-change', password: PASSWORD });
    await apiFetch(baseUrl, 'POST', '/api/vaults/pw-change/secrets/DATA', { value: 'important' });
    await apiFetch(baseUrl, 'POST', '/api/vaults/pw-change/lock');
    await apiFetch(baseUrl, 'POST', '/api/vaults/pw-change/unlock', {
      password: PASSWORD,
      stayAuthenticated: true,
    });

    // Change password — VK stays the same, so keychain entry should still work
    await apiFetch(baseUrl, 'POST', '/api/vaults/pw-change/change-password', {
      currentPassword: PASSWORD,
      newPassword: 'changed-pw-789',
    });

    await apiFetch(baseUrl, 'POST', '/api/vaults/pw-change/lock');

    // Simulate restart
    server.stop();
    const result2 = createServer({
      port: 0,
      vaultsDir: tmpDir,
      uiDir: join(import.meta.dir, '..', '..', '..', 'ui'),
      keychain,
      keychainService: 'test-flow',
    });
    server = result2.server;
    const baseUrl2 = `http://localhost:${server.port}`;

    await result2.vaultManager.tryAutoUnlockAll();

    // Should auto-unlock because VK in keychain didn't change
    const statusRes = await apiFetch(baseUrl2, 'GET', '/api/vaults/pw-change/status');
    const status = await statusRes.json() as { data: { unlocked: boolean } };
    expect(status.data.unlocked).toBe(true);
  });

  test('concurrent vault operations', async () => {
    // Create 3 vaults concurrently
    await Promise.all([
      apiFetch(baseUrl, 'POST', '/api/vaults', { name: 'concurrent-a', password: PASSWORD }),
      apiFetch(baseUrl, 'POST', '/api/vaults', { name: 'concurrent-b', password: PASSWORD }),
      apiFetch(baseUrl, 'POST', '/api/vaults', { name: 'concurrent-c', password: PASSWORD }),
    ]);

    // Add secrets concurrently
    await Promise.all([
      apiFetch(baseUrl, 'POST', '/api/vaults/concurrent-a/secrets/KEY', { value: 'aaa' }),
      apiFetch(baseUrl, 'POST', '/api/vaults/concurrent-b/secrets/KEY', { value: 'bbb' }),
      apiFetch(baseUrl, 'POST', '/api/vaults/concurrent-c/secrets/KEY', { value: 'ccc' }),
    ]);

    // Read all concurrently
    const [resA, resB, resC] = await Promise.all([
      apiFetch(baseUrl, 'GET', '/api/vaults/concurrent-a/secrets/KEY'),
      apiFetch(baseUrl, 'GET', '/api/vaults/concurrent-b/secrets/KEY'),
      apiFetch(baseUrl, 'GET', '/api/vaults/concurrent-c/secrets/KEY'),
    ]);

    const dataA = await resA.json() as { data: { value: string } };
    const dataB = await resB.json() as { data: { value: string } };
    const dataC = await resC.json() as { data: { value: string } };

    expect(dataA.data.value).toBe('aaa');
    expect(dataB.data.value).toBe('bbb');
    expect(dataC.data.value).toBe('ccc');
  });
});
