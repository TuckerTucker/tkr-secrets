/**
 * Integration tests for the stay-authenticated / keychain persistence feature.
 *
 * Verifies that the keychain save/remove lifecycle works correctly
 * across unlock, lock, and auto-unlock operations.
 *
 * @module __tests__/integration/keychain-persistence
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretsStore } from '../../store.js';
import {
  InMemoryKeychainProvider,
  FailingKeychainProvider,
  createNullLogger,
  PASSWORD,
} from '../helpers.js';

const SERVICE = 'test-keychain';
const ACCOUNT = 'test-vault';

describe('keychain persistence', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(opts?: { keychain?: InMemoryKeychainProvider | FailingKeychainProvider }) {
    tmpDir = mkdtempSync(join(tmpdir(), 'tkr-keychain-test-'));
    const keychain = opts?.keychain ?? new InMemoryKeychainProvider();
    const filePath = join(tmpDir, 'secrets-test.enc.json');
    const store = new SecretsStore({
      filePath,
      autoLockMs: 300_000,
      logger: createNullLogger(),
      keychain,
      keychainService: SERVICE,
      keychainAccount: ACCOUNT,
    });
    return { store, keychain: keychain as InMemoryKeychainProvider, filePath };
  }

  test('unlock without stayAuthenticated clears keychain on lock', async () => {
    const { store, keychain } = setup();
    await store.init(PASSWORD);
    store.lock();

    await store.unlock(PASSWORD, false);
    expect(keychain.entries.has(`${SERVICE}:${ACCOUNT}`)).toBe(false);

    store.lock();
    expect(keychain.entries.has(`${SERVICE}:${ACCOUNT}`)).toBe(false);
  });

  test('unlock with stayAuthenticated saves VK to keychain', async () => {
    const { store, keychain } = setup();
    await store.init(PASSWORD);
    store.lock();

    await store.unlock(PASSWORD, true);
    expect(keychain.entries.has(`${SERVICE}:${ACCOUNT}`)).toBe(true);
    expect(keychain.entries.get(`${SERVICE}:${ACCOUNT}`)!.length).toBe(32);
  });

  test('lock with stayAuthenticated preserves keychain entry', async () => {
    const { store, keychain } = setup();
    await store.init(PASSWORD);
    store.lock();

    await store.unlock(PASSWORD, true);
    store.lock();
    expect(keychain.entries.has(`${SERVICE}:${ACCOUNT}`)).toBe(true);
  });

  test('tryAutoUnlock succeeds when keychain has entry', async () => {
    const keychain = new InMemoryKeychainProvider();
    const { store } = setup({ keychain });
    await store.init(PASSWORD);
    store.lock();

    // Unlock with persist to populate keychain
    await store.unlock(PASSWORD, true);
    store.lock();

    // Create a fresh store with the same keychain
    const store2 = new SecretsStore({
      filePath: join(tmpDir, 'secrets-test.enc.json'),
      autoLockMs: 300_000,
      logger: createNullLogger(),
      keychain,
      keychainService: SERVICE,
      keychainAccount: ACCOUNT,
    });

    const unlocked = await store2.tryAutoUnlock();
    expect(unlocked).toBe(true);
    expect(store2.isUnlocked).toBe(true);
  });

  test('tryAutoUnlock fails when keychain is empty', async () => {
    const keychain = new InMemoryKeychainProvider();
    const { store } = setup({ keychain });
    await store.init(PASSWORD);
    store.lock();

    // Unlock without persist — keychain stays empty
    await store.unlock(PASSWORD, false);
    store.lock();

    const store2 = new SecretsStore({
      filePath: join(tmpDir, 'secrets-test.enc.json'),
      autoLockMs: 300_000,
      logger: createNullLogger(),
      keychain,
      keychainService: SERVICE,
      keychainAccount: ACCOUNT,
    });

    const unlocked = await store2.tryAutoUnlock();
    expect(unlocked).toBe(false);
    expect(store2.isUnlocked).toBe(false);
  });

  test('tryAutoUnlock sets persistSession to true', async () => {
    const keychain = new InMemoryKeychainProvider();
    const { store } = setup({ keychain });
    await store.init(PASSWORD);
    store.lock();

    await store.unlock(PASSWORD, true);
    store.lock();

    const store2 = new SecretsStore({
      filePath: join(tmpDir, 'secrets-test.enc.json'),
      autoLockMs: 300_000,
      logger: createNullLogger(),
      keychain,
      keychainService: SERVICE,
      keychainAccount: ACCOUNT,
    });

    await store2.tryAutoUnlock();
    const status = await store2.status();
    expect(status.stayAuthenticated).toBe(true);
  });

  test('status reflects keychainAvailable', async () => {
    const { store } = setup();
    await store.init(PASSWORD);

    const status = await store.status();
    expect(status.keychainAvailable).toBe(true);

    // Store without keychain
    const store2 = new SecretsStore({
      filePath: join(tmpDir, 'secrets-nokey.enc.json'),
      autoLockMs: 300_000,
      logger: createNullLogger(),
    });
    await store2.init(PASSWORD);

    const status2 = await store2.status();
    expect(status2.keychainAvailable).toBe(false);
  });

  test('status reflects stayAuthenticated', async () => {
    const { store } = setup();
    await store.init(PASSWORD);
    store.lock();

    await store.unlock(PASSWORD, false);
    expect((await store.status()).stayAuthenticated).toBe(false);

    store.lock();
    await store.unlock(PASSWORD, true);
    expect((await store.status()).stayAuthenticated).toBe(true);
  });

  test('changing stayAuthenticated on re-unlock updates keychain', async () => {
    const { store, keychain } = setup();
    await store.init(PASSWORD);
    store.lock();

    // First: persist
    await store.unlock(PASSWORD, true);
    expect(keychain.entries.has(`${SERVICE}:${ACCOUNT}`)).toBe(true);
    store.lock();
    expect(keychain.entries.has(`${SERVICE}:${ACCOUNT}`)).toBe(true);

    // Second: don't persist
    await store.unlock(PASSWORD, false);
    expect(keychain.entries.has(`${SERVICE}:${ACCOUNT}`)).toBe(false);
    store.lock();
    expect(keychain.entries.has(`${SERVICE}:${ACCOUNT}`)).toBe(false);
  });

  test('keychain failure on save is non-fatal', async () => {
    const { store } = setup({ keychain: new FailingKeychainProvider() });
    await store.init(PASSWORD);
    store.lock();

    // Should not throw despite keychain.store() failing
    await store.unlock(PASSWORD, true);
    expect(store.isUnlocked).toBe(true);
  });

  test('keychain failure on remove is non-fatal', async () => {
    const { store } = setup({ keychain: new FailingKeychainProvider() });
    await store.init(PASSWORD);
    store.lock();

    await store.unlock(PASSWORD, false);
    // lock() calls removeFromKeychain which will fail — should not throw
    await store.lock();
    expect(store.isUnlocked).toBe(false);
  });

  test('lock awaits keychain removal before completing', async () => {
    let removeResolved = false;
    const slowKeychain = new InMemoryKeychainProvider();
    const originalRemove = slowKeychain.remove.bind(slowKeychain);
    slowKeychain.remove = async (service: string, account: string): Promise<boolean> => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      removeResolved = true;
      return originalRemove(service, account);
    };

    const { store } = setup({ keychain: slowKeychain });
    await store.init(PASSWORD);
    await store.lock();

    await store.unlock(PASSWORD, false);
    // Populate keychain manually to test removal
    await slowKeychain.store(SERVICE, ACCOUNT, Buffer.alloc(32));
    expect(slowKeychain.entries.has(`${SERVICE}:${ACCOUNT}`)).toBe(true);

    await store.lock();
    // lock() should have awaited the slow removal
    expect(removeResolved).toBe(true);
    expect(slowKeychain.entries.has(`${SERVICE}:${ACCOUNT}`)).toBe(false);
  });

  test('tryAutoUnlock cleans stale keychain entry on decryption failure', async () => {
    const keychain = new InMemoryKeychainProvider();
    const { store, filePath } = setup({ keychain });
    await store.init(PASSWORD);
    await store.set('KEY', 'value'); // Need a secret so decryption actually runs
    await store.lock();

    // Store a WRONG VK in keychain (will fail decryption)
    await keychain.store(SERVICE, ACCOUNT, Buffer.alloc(32, 0xab));
    expect(keychain.entries.has(`${SERVICE}:${ACCOUNT}`)).toBe(true);

    const store2 = new SecretsStore({
      filePath,
      autoLockMs: 300_000,
      logger: createNullLogger(),
      keychain,
      keychainService: SERVICE,
      keychainAccount: ACCOUNT,
    });

    const unlocked = await store2.tryAutoUnlock();
    expect(unlocked).toBe(false);
    // Stale entry should be cleaned up
    expect(keychain.entries.has(`${SERVICE}:${ACCOUNT}`)).toBe(false);
  });

  test('recover resets persistSession and clears keychain', async () => {
    const { store, keychain } = setup();
    const recoveryKey = await store.init(PASSWORD);
    await store.lock();

    // Unlock with persist
    await store.unlock(PASSWORD, true);
    expect(keychain.entries.has(`${SERVICE}:${ACCOUNT}`)).toBe(true);
    expect((await store.status()).stayAuthenticated).toBe(true);

    // Recover — should clear persist and keychain
    await store.recover(recoveryKey, 'new-password');
    expect((await store.status()).stayAuthenticated).toBe(false);
    expect(keychain.entries.has(`${SERVICE}:${ACCOUNT}`)).toBe(false);
  });

  test('changePassword preserves valid keychain entry when persisting', async () => {
    const keychain = new InMemoryKeychainProvider();
    const { store, filePath } = setup({ keychain });
    await store.init(PASSWORD);
    await store.lock();

    // Unlock with persist
    await store.unlock(PASSWORD, true);
    const savedVk = Buffer.from(keychain.entries.get(`${SERVICE}:${ACCOUNT}`)!);

    // Change password — VK stays the same
    await store.changePassword(PASSWORD, 'new-password-456');
    await store.lock();

    // Create fresh store, auto-unlock should work (VK unchanged)
    const store2 = new SecretsStore({
      filePath,
      autoLockMs: 300_000,
      logger: createNullLogger(),
      keychain,
      keychainService: SERVICE,
      keychainAccount: ACCOUNT,
    });

    const unlocked = await store2.tryAutoUnlock();
    expect(unlocked).toBe(true);
  });
});
