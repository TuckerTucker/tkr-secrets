import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { SecretsStore } from '../store.js';
import type { Logger, VaultFileFormat } from '../types.js';

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

describe('SecretsStore v2', () => {
  let tmpDir: string;
  let filePath: string;
  const password = 'test-password-123';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tkr-secrets-store-test-'));
    filePath = join(tmpDir, 'secrets-test.enc.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createStore(): SecretsStore {
    return new SecretsStore({
      filePath,
      autoLockMs: 300_000,
      logger: createTestLogger(),
    });
  }

  test('init creates v2 file and returns recovery key buffer', async () => {
    const store = createStore();
    const rk = await store.init(password);

    expect(Buffer.isBuffer(rk)).toBe(true);
    expect(rk.length).toBe(32);
    expect(store.isUnlocked).toBe(true);
    expect(existsSync(filePath)).toBe(true);

    const data: VaultFileFormat = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(data.version).toBe(2);
    expect(typeof data.salt).toBe('string');
    expect(typeof data.passwordWrappedKey).toBe('string');
    expect(typeof data.recoveryWrappedKey).toBe('string');
    expect(data.groups).toEqual({});
    expect(data.order).toEqual([]);
    expect(data.secretGroups).toEqual({});
    expect(data.secrets).toEqual({});
  });

  test('unlock decrypts secrets and loads groups/order', async () => {
    const store1 = createStore();
    await store1.init(password);
    await store1.set('API_KEY', 'secret-value');
    await store1.setGroups(new Map([['g1', { name: 'Group 1', order: 0 }]]));
    await store1.setOrder(['API_KEY']);
    await store1.setSecretGroups(new Map([['API_KEY', 'g1']]));
    store1.lock();

    const store2 = createStore();
    await store2.unlock(password);

    expect(store2.isUnlocked).toBe(true);
    expect(store2.get('API_KEY')).toBe('secret-value');
    expect(store2.getGroups().get('g1')).toEqual({ name: 'Group 1', order: 0 });
    expect([...store2.getOrder()]).toEqual(['API_KEY']);
    expect(store2.getSecretGroups().get('API_KEY')).toBe('g1');
    store2.lock();
  });

  test('unlock with wrong password throws', async () => {
    const store = createStore();
    await store.init(password);
    store.lock();

    const store2 = createStore();
    await expect(store2.unlock('wrong-password')).rejects.toThrow('invalid password');
    expect(store2.isUnlocked).toBe(false);
  });

  test('persist writes v2 format with all fields', async () => {
    const store = createStore();
    await store.init(password);
    await store.set('MY_SECRET', 'hello');

    const data: VaultFileFormat = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(data.version).toBe(2);
    expect(data.salt).toBeTruthy();
    expect(data.passwordWrappedKey).toBeTruthy();
    expect(data.recoveryWrappedKey).toBeTruthy();
    expect(Object.keys(data.secrets)).toEqual(['MY_SECRET']);
    expect(typeof data.secrets['MY_SECRET']).toBe('string');
    // Encrypted value should not be plaintext
    expect(data.secrets['MY_SECRET']).not.toBe('hello');
    store.lock();
  });

  test('changePassword makes old password fail and new password work', async () => {
    const store = createStore();
    await store.init(password);
    await store.set('KEY', 'value');
    store.lock();

    const store2 = createStore();
    await store2.unlock(password);
    store2.lock();

    await createStore().unlock(password).then(s => {
      // Just verifying old password still works before change
    });
    (createStore()).lock?.();

    // Change password
    const changer = createStore();
    await changer.changePassword(password, 'new-password-456');

    // Old password should fail
    const store3 = createStore();
    await expect(store3.unlock(password)).rejects.toThrow('invalid password');

    // New password should work
    const store4 = createStore();
    await store4.unlock('new-password-456');
    expect(store4.get('KEY')).toBe('value');
    store4.lock();
  });

  test('changePassword with wrong current password throws', async () => {
    const store = createStore();
    await store.init(password);
    store.lock();

    await expect(createStore().changePassword('wrong', 'new')).rejects.toThrow('invalid password');
  });

  test('recover unlocks vault and returns new recovery key', async () => {
    const store = createStore();
    const rk = await store.init(password);
    await store.set('SECRET', 'data');
    store.lock();

    const store2 = createStore();
    const newRk = await store2.recover(rk, 'new-password');

    expect(Buffer.isBuffer(newRk)).toBe(true);
    expect(newRk.length).toBe(32);
    expect(newRk.equals(rk)).toBe(false);
    expect(store2.isUnlocked).toBe(true);
    expect(store2.get('SECRET')).toBe('data');
    store2.lock();

    // New password should work
    const store3 = createStore();
    await store3.unlock('new-password');
    expect(store3.get('SECRET')).toBe('data');
    store3.lock();
  });

  test('recover with invalid recovery key throws', async () => {
    const store = createStore();
    await store.init(password);
    store.lock();

    const fakeRk = Buffer.alloc(32, 0xff);
    const store2 = createStore();
    await expect(store2.recover(fakeRk, 'new-password')).rejects.toThrow('invalid recovery key');
  });

  test('lock zeros the vault key and clears state', async () => {
    const store = createStore();
    await store.init(password);
    await store.set('KEY', 'val');
    expect(store.isUnlocked).toBe(true);

    store.lock();
    expect(store.isUnlocked).toBe(false);
    expect(() => store.getAll()).toThrow('secrets store is locked');
    expect(() => store.getGroups()).toThrow('secrets store is locked');
    expect(() => store.getOrder()).toThrow('secrets store is locked');
    expect(() => store.getSecretGroups()).toThrow('secrets store is locked');
    expect(() => store.getSecretCount()).toThrow('secrets store is locked');
    expect(() => store.getGroupCount()).toThrow('secrets store is locked');
  });

  test('group and order accessors return correct data', async () => {
    const store = createStore();
    await store.init(password);

    expect(store.getSecretCount()).toBe(0);
    expect(store.getGroupCount()).toBe(0);
    expect([...store.getOrder()]).toEqual([]);

    await store.set('A', '1');
    await store.set('B', '2');
    await store.setGroups(new Map([
      ['g1', { name: 'Dev', order: 0 }],
      ['g2', { name: 'Prod', order: 1 }],
    ]));
    await store.setOrder(['B', 'A']);
    await store.setSecretGroups(new Map([['A', 'g1'], ['B', 'g2']]));

    expect(store.getSecretCount()).toBe(2);
    expect(store.getGroupCount()).toBe(2);
    expect([...store.getOrder()]).toEqual(['B', 'A']);
    expect(store.getSecretGroups().get('A')).toBe('g1');
    expect(store.getGroups().get('g2')).toEqual({ name: 'Prod', order: 1 });
    store.lock();
  });

  test('existing public API (get, getAll, set, delete, list) still works', async () => {
    const store = createStore();
    await store.init(password);

    await store.set('FOO', 'bar');
    expect(store.get('FOO')).toBe('bar');
    expect([...store.getAll().entries()]).toEqual([['FOO', 'bar']]);
    expect(store.list()).toEqual(['FOO']);

    const deleted = await store.delete('FOO');
    expect(deleted).toBe(true);
    expect(store.get('FOO')).toBeUndefined();
    expect(store.list()).toEqual([]);

    const deletedAgain = await store.delete('FOO');
    expect(deletedAgain).toBe(false);

    store.lock();
  });

  test('status reports correct state', async () => {
    const store = createStore();

    const s1 = await store.status();
    expect(s1.fileExists).toBe(false);
    expect(s1.unlocked).toBe(false);

    await store.init(password);
    const s2 = await store.status();
    expect(s2.fileExists).toBe(true);
    expect(s2.unlocked).toBe(true);
    expect(typeof s2.timeoutRemaining).toBe('number');

    store.lock();
    const s3 = await store.status();
    expect(s3.fileExists).toBe(true);
    expect(s3.unlocked).toBe(false);
  });
});
