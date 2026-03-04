/**
 * Integration tests for scanAndRegister() and tryAutoUnlockAll().
 *
 * Verifies vault discovery from disk and batch auto-unlock behavior.
 *
 * @module __tests__/integration/auto-unlock
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultManager } from '../../vault-manager.js';
import {
  InMemoryKeychainProvider,
  createNullLogger,
  PASSWORD,
} from '../helpers.js';

const SERVICE = 'test-service';

describe('scanAndRegister', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function createManager(keychain?: InMemoryKeychainProvider): VaultManager {
    return new VaultManager({
      vaultsDir: tmpDir,
      autoLockMs: 300_000,
      logger: createNullLogger(),
      keychain: keychain ?? new InMemoryKeychainProvider(),
      keychainService: SERVICE,
    });
  }

  test('discovers vault files on disk', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tkr-scan-'));
    const vm = createManager();

    // Create a vault to produce a real file
    await vm.create('alpha', PASSWORD);
    const { store: betaStore } = await vm.create('beta', PASSWORD);
    betaStore.lock();

    // New manager — no vaults registered yet
    const vm2 = createManager();
    vm2.scanAndRegister();

    expect(vm2.get('alpha')).toBeDefined();
    expect(vm2.get('beta')).toBeDefined();
  });

  test('skips already-registered vaults', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tkr-scan-'));
    const vm = createManager();
    const { store } = await vm.create('myapp', PASSWORD);

    // scanAndRegister should not overwrite the existing store
    vm.scanAndRegister();
    expect(vm.get('myapp')).toBe(store);
  });

  test('ignores non-vault files', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tkr-scan-'));
    writeFileSync(join(tmpDir, 'readme.txt'), 'hello');
    writeFileSync(join(tmpDir, 'data.json'), '{}');
    writeFileSync(join(tmpDir, 'secrets-.enc.json'), '{}'); // invalid name (empty)

    const vm = createManager();
    vm.scanAndRegister();

    const vaults = await vm.list();
    expect(vaults).toHaveLength(0);
  });

  test('handles empty directory', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tkr-scan-'));
    const vm = createManager();
    vm.scanAndRegister(); // should not throw

    const vaults = await vm.list();
    expect(vaults).toHaveLength(0);
  });

  test('handles missing directory', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tkr-scan-'));
    rmSync(tmpDir, { recursive: true, force: true });

    const vm = new VaultManager({
      vaultsDir: join(tmpDir, 'nonexistent'),
      autoLockMs: 300_000,
      logger: createNullLogger(),
    });
    vm.scanAndRegister(); // should not throw
    tmpDir = mkdtempSync(join(tmpdir(), 'tkr-scan-')); // recreate for cleanup
  });
});

describe('tryAutoUnlockAll', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('unlocks vaults with keychain entries', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tkr-autounlock-'));
    const keychain = new InMemoryKeychainProvider();

    const vm = new VaultManager({
      vaultsDir: tmpDir,
      autoLockMs: 300_000,
      logger: createNullLogger(),
      keychain,
      keychainService: SERVICE,
    });

    // Create two vaults, both with persist
    await vm.create('alpha', PASSWORD);
    const alphaStore = vm.get('alpha')!;
    alphaStore.lock();
    await alphaStore.unlock(PASSWORD, true);
    alphaStore.lock();

    await vm.create('beta', PASSWORD);
    const betaStore = vm.get('beta')!;
    betaStore.lock();
    await betaStore.unlock(PASSWORD, true);
    betaStore.lock();

    // New manager with same keychain
    const vm2 = new VaultManager({
      vaultsDir: tmpDir,
      autoLockMs: 300_000,
      logger: createNullLogger(),
      keychain,
      keychainService: SERVICE,
    });
    vm2.scanAndRegister();

    const count = await vm2.tryAutoUnlockAll();
    expect(count).toBe(2);
    expect(vm2.get('alpha')!.isUnlocked).toBe(true);
    expect(vm2.get('beta')!.isUnlocked).toBe(true);
  });

  test('skips vaults without keychain entries', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tkr-autounlock-'));
    const keychain = new InMemoryKeychainProvider();

    const vm = new VaultManager({
      vaultsDir: tmpDir,
      autoLockMs: 300_000,
      logger: createNullLogger(),
      keychain,
      keychainService: SERVICE,
    });

    // Alpha: persist, Beta: no persist
    await vm.create('alpha', PASSWORD);
    vm.get('alpha')!.lock();
    await vm.get('alpha')!.unlock(PASSWORD, true);
    vm.get('alpha')!.lock();

    await vm.create('beta', PASSWORD);
    vm.get('beta')!.lock();
    await vm.get('beta')!.unlock(PASSWORD, false);
    vm.get('beta')!.lock();

    // New manager
    const vm2 = new VaultManager({
      vaultsDir: tmpDir,
      autoLockMs: 300_000,
      logger: createNullLogger(),
      keychain,
      keychainService: SERVICE,
    });
    vm2.scanAndRegister();

    const count = await vm2.tryAutoUnlockAll();
    expect(count).toBe(1);
    expect(vm2.get('alpha')!.isUnlocked).toBe(true);
    expect(vm2.get('beta')!.isUnlocked).toBe(false);
  });

  test('returns correct count', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tkr-autounlock-'));
    const keychain = new InMemoryKeychainProvider();

    const vm = new VaultManager({
      vaultsDir: tmpDir,
      autoLockMs: 300_000,
      logger: createNullLogger(),
      keychain,
      keychainService: SERVICE,
    });

    await vm.create('only', PASSWORD);
    vm.get('only')!.lock();

    const count = await vm.tryAutoUnlockAll();
    expect(count).toBe(0);
  });

  test('discovered vaults have keychain wired', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tkr-autounlock-'));
    const keychain = new InMemoryKeychainProvider();

    // Create vault with first manager
    const vm = new VaultManager({
      vaultsDir: tmpDir,
      autoLockMs: 300_000,
      logger: createNullLogger(),
      keychain,
      keychainService: SERVICE,
    });
    await vm.create('myapp', PASSWORD);
    vm.get('myapp')!.lock();

    // Discover with second manager
    const vm2 = new VaultManager({
      vaultsDir: tmpDir,
      autoLockMs: 300_000,
      logger: createNullLogger(),
      keychain,
      keychainService: SERVICE,
    });
    vm2.scanAndRegister();

    const store = vm2.get('myapp')!;
    const status = await store.status();
    expect(status.keychainAvailable).toBe(true);
  });
});
