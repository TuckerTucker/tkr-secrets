import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SecretsStore } from './store.js';
import { createSecretsRouter } from './http/router.js';
import { createNullLogger } from './testing.js';

function makeRouter(dir: string) {
  const store = new SecretsStore({
    filePath: join(dir, 'secrets.enc.json'),
    autoLockMs: 60_000,
    logger: createNullLogger(),
  });
  const router = createSecretsRouter({
    store,
    logger: createNullLogger(),
  });
  return { store, router };
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('secrets router', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'secrets-router-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('match recognizes secrets paths', () => {
    const { router } = makeRouter(dir);
    expect(router.match('GET', '/api/secrets')).toBe(true);
    expect(router.match('GET', '/api/secrets/status')).toBe(true);
    expect(router.match('POST', '/api/secrets/init')).toBe(true);
    expect(router.match('GET', '/api/sessions')).toBe(false);
    expect(router.match('GET', '/health')).toBe(false);
  });

  test('status returns file state', async () => {
    const { router } = makeRouter(dir);
    const res = await router.handle(req('GET', '/api/secrets/status'));
    const body = await res.json() as Record<string, unknown>;
    expect(body.success).toBe(true);
    const data = body.data as Record<string, unknown>;
    expect(data.fileExists).toBe(false);
    expect(data.unlocked).toBe(false);
  });

  test('init + list + set + get + delete flow', async () => {
    const { router } = makeRouter(dir);

    // Init
    const initRes = await router.handle(req('POST', '/api/secrets/init', { password: 'pw' }));
    expect((await initRes.json() as Record<string, unknown>).success).toBe(true);

    // List empty
    const listRes = await router.handle(req('GET', '/api/secrets'));
    const list = await listRes.json() as Record<string, unknown>;
    expect((list.data as Record<string, unknown>).names).toEqual([]);

    // Set
    const setRes = await router.handle(req('POST', '/api/secrets/MY_KEY', { value: 'abc' }));
    expect((await setRes.json() as Record<string, unknown>).success).toBe(true);

    // Get
    const getRes = await router.handle(req('GET', '/api/secrets/MY_KEY'));
    const got = await getRes.json() as Record<string, unknown>;
    expect((got.data as Record<string, unknown>).value).toBe('abc');

    // List with item
    const list2 = await (await router.handle(req('GET', '/api/secrets'))).json() as Record<string, unknown>;
    expect((list2.data as Record<string, unknown>).names).toEqual(['MY_KEY']);

    // Delete
    const delRes = await router.handle(req('DELETE', '/api/secrets/MY_KEY'));
    expect((await delRes.json() as Record<string, unknown>).success).toBe(true);

    // Get after delete
    const gone = await router.handle(req('GET', '/api/secrets/MY_KEY'));
    expect(gone.status).toBe(404);
  });

  test('operations on locked store return 423', async () => {
    const { router, store } = makeRouter(dir);
    await store.init('pw');
    store.lock();

    const res = await router.handle(req('GET', '/api/secrets'));
    expect(res.status).toBe(423);
  });

  test('init without password returns 400', async () => {
    const { router } = makeRouter(dir);
    const res = await router.handle(req('POST', '/api/secrets/init', {}));
    const body = await res.json() as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect(body.error).toBe('password required');
  });

  test('envelope shape: success response', async () => {
    const { router } = makeRouter(dir);
    const res = await router.handle(req('GET', '/api/secrets/status'));
    const body = await res.json();
    expect(body).toHaveProperty('success', true);
    expect(body).toHaveProperty('data');
    expect(body).not.toHaveProperty('error');
  });

  test('envelope shape: error response', async () => {
    const { router } = makeRouter(dir);
    const res = await router.handle(req('POST', '/api/secrets/init', {}));
    const body = await res.json();
    expect(body).toHaveProperty('success', false);
    expect(body).toHaveProperty('error');
  });
});
