import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { VaultManager, validateVaultName } from '../vault-manager.js';
import type { Logger } from '../types.js';

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

describe('validateVaultName', () => {
  test('accepts valid names', () => {
    expect(() => validateVaultName('myapp')).not.toThrow();
    expect(() => validateVaultName('my-app')).not.toThrow();
    expect(() => validateVaultName('a123')).not.toThrow();
    expect(() => validateVaultName('x')).not.toThrow();
  });

  test('rejects empty name', () => {
    expect(() => validateVaultName('')).toThrow('must not be empty');
  });

  test('rejects names starting with digit', () => {
    expect(() => validateVaultName('1abc')).toThrow();
  });

  test('rejects names starting with hyphen', () => {
    expect(() => validateVaultName('-abc')).toThrow();
  });

  test('rejects uppercase names', () => {
    expect(() => validateVaultName('MyApp')).toThrow();
  });

  test('rejects names with underscores', () => {
    expect(() => validateVaultName('my_app')).toThrow();
  });

  test('rejects names exceeding 64 characters', () => {
    expect(() => validateVaultName('a'.repeat(65))).toThrow('at most 64');
  });

  test('rejects reserved name "default"', () => {
    expect(() => validateVaultName('default')).toThrow('reserved');
  });
});

describe('VaultManager', () => {
  let tmpDir: string;
  const password = 'test-password-123';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tkr-secrets-vm-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createManager(): VaultManager {
    return new VaultManager({
      vaultsDir: tmpDir,
      autoLockMs: 300_000,
      logger: createTestLogger(),
    });
  }

  test('create registers vault and returns store + recovery key', async () => {
    const vm = createManager();
    const { store, recoveryKey } = await vm.create('myapp', password);

    expect(store).toBeDefined();
    expect(store.isUnlocked).toBe(true);
    expect(Buffer.isBuffer(recoveryKey)).toBe(true);
    expect(recoveryKey.length).toBe(32);

    const vaultFile = join(tmpDir, 'secrets-myapp.enc.json');
    expect(existsSync(vaultFile)).toBe(true);
  });

  test('create throws 409 on duplicate name', async () => {
    const vm = createManager();
    await vm.create('myapp', password);

    try {
      await vm.create('myapp', password);
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect((err as Error).message).toContain('already exists');
      expect((err as Record<string, unknown>)['status']).toBe(409);
    }
  });

  test('create throws on invalid name', async () => {
    const vm = createManager();
    await expect(vm.create('', password)).rejects.toThrow();
    await expect(vm.create('MyApp', password)).rejects.toThrow();
    await expect(vm.create('default', password)).rejects.toThrow();
    await expect(vm.create('1bad', password)).rejects.toThrow();
  });

  test('get returns registered store', async () => {
    const vm = createManager();
    const { store } = await vm.create('myapp', password);

    expect(vm.get('myapp')).toBe(store);
    expect(vm.get('nonexistent')).toBeUndefined();
  });

  test('delete removes files and registry entry', async () => {
    const vm = createManager();
    await vm.create('myapp', password);

    // Create a fake password file to verify deletion
    const pwFile = vm.getPasswordFilePath('myapp');
    writeFileSync(pwFile, 'test');
    expect(existsSync(pwFile)).toBe(true);

    await vm.delete('myapp');

    expect(vm.get('myapp')).toBeUndefined();
    expect(existsSync(join(tmpDir, 'secrets-myapp.enc.json'))).toBe(false);
    expect(existsSync(pwFile)).toBe(false);
  });

  test('delete throws on unknown vault', async () => {
    const vm = createManager();
    await expect(vm.delete('nonexistent')).rejects.toThrow('not found');
  });

  test('list returns summaries for all registered vaults', async () => {
    const vm = createManager();
    await vm.create('alpha', password);
    const { store: betaStore } = await vm.create('beta', password);
    await betaStore.set('KEY', 'val');

    const summaries = await vm.list();
    expect(summaries.length).toBe(2);

    const alpha = summaries.find(s => s.name === 'alpha')!;
    expect(alpha.fileExists).toBe(true);
    expect(alpha.unlocked).toBe(true);
    expect(alpha.secretCount).toBe(0);

    const beta = summaries.find(s => s.name === 'beta')!;
    expect(beta.fileExists).toBe(true);
    expect(beta.unlocked).toBe(true);
    expect(beta.secretCount).toBe(1);
  });

  test('list shows locked vaults with zero counts', async () => {
    const vm = createManager();
    const { store } = await vm.create('myapp', password);
    await store.set('A', '1');
    store.lock();

    const summaries = await vm.list();
    expect(summaries[0].unlocked).toBe(false);
    expect(summaries[0].secretCount).toBe(0);
    expect(summaries[0].groupCount).toBe(0);
  });

  test('getPasswordFilePath returns correct path', () => {
    const vm = createManager();
    const path = vm.getPasswordFilePath('myapp');
    expect(path).toBe(join(tmpDir, '.secrets-password-myapp'));
  });
});
