import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SecretsStore } from './store.js';
import { writePasswordFile } from './password-file.js';
import { createNullLogger } from './testing.js';

function makeDeps(dir: string) {
  return {
    filePath: join(dir, 'secrets.enc.json'),
    autoLockMs: 60_000,
    logger: createNullLogger(),
  };
}

describe('SecretsStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'secrets-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('init creates file and allows CRUD', async () => {
    const store = new SecretsStore(makeDeps(dir));
    await store.init('pw123');

    expect(store.isUnlocked).toBe(true);
    expect(store.list()).toEqual([]);

    await store.set('API_KEY', 'sk-abc');
    expect(store.get('API_KEY')).toBe('sk-abc');
    expect(store.list()).toEqual(['API_KEY']);

    await store.set('DB_URL', 'postgres://...');
    expect(store.list()).toEqual(['API_KEY', 'DB_URL']);

    const deleted = await store.delete('API_KEY');
    expect(deleted).toBe(true);
    expect(store.list()).toEqual(['DB_URL']);

    const notFound = await store.delete('NOPE');
    expect(notFound).toBe(false);
  });

  test('lock and unlock round-trip preserves data', async () => {
    const deps = makeDeps(dir);
    const store = new SecretsStore(deps);
    await store.init('pw');
    await store.set('KEY', 'val');
    store.lock();

    expect(store.isUnlocked).toBe(false);
    // When locked, get() falls back to process.env (returns undefined if not set)
    expect(store.get('KEY')).toBeUndefined();

    await store.unlock('pw');
    expect(store.get('KEY')).toBe('val');
  });

  test('unlock with wrong password throws', async () => {
    const store = new SecretsStore(makeDeps(dir));
    await store.init('correct');
    await store.set('X', 'y');
    store.lock();

    await expect(store.unlock('wrong')).rejects.toThrow('invalid password');
  });

  test('init on existing file throws', async () => {
    const deps = makeDeps(dir);
    const store = new SecretsStore(deps);
    await store.init('pw');
    store.lock();

    const store2 = new SecretsStore(deps);
    await expect(store2.init('pw2')).rejects.toThrow('already exists');
  });

  test('name validation rejects invalid names', async () => {
    const store = new SecretsStore(makeDeps(dir));
    await store.init('pw');
    await expect(store.set('123bad', 'v')).rejects.toThrow('invalid secret name');
    await expect(store.set('has-dash', 'v')).rejects.toThrow('invalid secret name');
    await expect(store.set('has space', 'v')).rejects.toThrow('invalid secret name');
  });

  test('status reflects state', async () => {
    const store = new SecretsStore(makeDeps(dir));

    let s = await store.status();
    expect(s.fileExists).toBe(false);
    expect(s.unlocked).toBe(false);

    await store.init('pw');
    s = await store.status();
    expect(s.fileExists).toBe(true);
    expect(s.unlocked).toBe(true);
    expect(s.timeoutRemaining).toBeDefined();

    store.lock();
    s = await store.status();
    expect(s.unlocked).toBe(false);
  });

  test('tryAutoUnlock works with password file', async () => {
    const deps = makeDeps(dir);
    const store = new SecretsStore(deps);
    await store.init('auto-pw');
    await store.set('SECRET', 'value');
    store.lock();

    const pwFile = join(dir, '.pw');
    await writePasswordFile(pwFile, 'auto-pw');

    const store2 = new SecretsStore(deps);
    const ok = await store2.tryAutoUnlock(pwFile);
    expect(ok).toBe(true);
    expect(store2.get('SECRET')).toBe('value');
  });

  test('tryAutoUnlock returns false without password file', async () => {
    const store = new SecretsStore(makeDeps(dir));
    await store.init('pw');
    store.lock();

    const store2 = new SecretsStore(makeDeps(dir));
    const ok = await store2.tryAutoUnlock(join(dir, 'nonexistent'));
    expect(ok).toBe(false);
  });
});
