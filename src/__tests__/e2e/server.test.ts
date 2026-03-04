/**
 * E2E tests for the full HTTP server.
 *
 * Starts a real Bun.serve on an OS-assigned port and tests
 * the complete request/response cycle via fetch().
 *
 * @module __tests__/e2e/server
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { createE2EServer, apiFetch, PASSWORD } from '../helpers.js';
import type { E2EServer } from '../helpers.js';

describe('E2E server', () => {
  let e2e: E2EServer;

  beforeAll(() => {
    e2e = createE2EServer();
  });

  afterAll(() => {
    e2e.cleanup();
  });

  test('GET /api/vaults returns empty list initially', async () => {
    const res = await apiFetch(e2e.baseUrl, 'GET', '/api/vaults');
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { vaults: unknown[] } };
    expect(body.success).toBe(true);
    expect(body.data.vaults).toHaveLength(0);
  });

  test('POST /api/vaults creates vault', async () => {
    const res = await apiFetch(e2e.baseUrl, 'POST', '/api/vaults', { name: 'e2e-create', password: PASSWORD });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { name: string; recoveryKey: { raw: string; mnemonic: string; qr: string } } };
    expect(body.success).toBe(true);
    expect(body.data.name).toBe('e2e-create');
    expect(body.data.recoveryKey.raw).toHaveLength(64);
    expect(body.data.recoveryKey.mnemonic).toBeDefined();
    expect(body.data.recoveryKey.qr).toBeDefined();
  });

  test('GET /api/vaults/:name/status returns correct shape', async () => {
    const res = await apiFetch(e2e.baseUrl, 'GET', '/api/vaults/e2e-create/status');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, unknown> };
    const data = body.data;

    expect(data.name).toBe('e2e-create');
    expect(data.fileExists).toBe(true);
    expect(data.unlocked).toBe(true);
    expect(data.version).toBe(2);
    expect(typeof data.keychainAvailable).toBe('boolean');
    expect(typeof data.stayAuthenticated).toBe('boolean');
    expect(typeof data.timeoutRemaining).toBe('number');
  });

  test('unlock → secrets → lock lifecycle', async () => {
    // Create fresh vault
    await apiFetch(e2e.baseUrl, 'POST', '/api/vaults', { name: 'e2e-lifecycle', password: PASSWORD });

    // Set a secret
    const setRes = await apiFetch(e2e.baseUrl, 'POST', '/api/vaults/e2e-lifecycle/secrets/MY_KEY', { value: 'hello' });
    expect(setRes.status).toBe(200);

    // Lock
    const lockRes = await apiFetch(e2e.baseUrl, 'POST', '/api/vaults/e2e-lifecycle/lock');
    expect(lockRes.status).toBe(200);

    // Secrets should be locked
    const lockedRes = await apiFetch(e2e.baseUrl, 'GET', '/api/vaults/e2e-lifecycle/secrets/MY_KEY');
    expect(lockedRes.status).toBe(423);

    // Unlock
    const unlockRes = await apiFetch(e2e.baseUrl, 'POST', '/api/vaults/e2e-lifecycle/unlock', { password: PASSWORD });
    expect(unlockRes.status).toBe(200);

    // Secret accessible again
    const getRes = await apiFetch(e2e.baseUrl, 'GET', '/api/vaults/e2e-lifecycle/secrets/MY_KEY');
    expect(getRes.status).toBe(200);
    const getData = await getRes.json() as { data: { value: string } };
    expect(getData.data.value).toBe('hello');
  });

  test('unlock with stayAuthenticated is accepted and reflected in status', async () => {
    await apiFetch(e2e.baseUrl, 'POST', '/api/vaults', { name: 'e2e-persist', password: PASSWORD });
    await apiFetch(e2e.baseUrl, 'POST', '/api/vaults/e2e-persist/lock');

    const unlockRes = await apiFetch(e2e.baseUrl, 'POST', '/api/vaults/e2e-persist/unlock', {
      password: PASSWORD,
      stayAuthenticated: true,
    });
    expect(unlockRes.status).toBe(200);

    const statusRes = await apiFetch(e2e.baseUrl, 'GET', '/api/vaults/e2e-persist/status');
    const status = await statusRes.json() as { data: { stayAuthenticated: boolean } };
    expect(status.data.stayAuthenticated).toBe(true);
  });

  test('404 for unknown vault', async () => {
    const res = await apiFetch(e2e.baseUrl, 'GET', '/api/vaults/nonexistent/status');
    expect(res.status).toBe(404);
  });

  test('SPA fallback serves HTML for client routes', async () => {
    const res = await fetch(`${e2e.baseUrl}/vault/myapp`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('<!DOCTYPE html');
  });

  test('static file serving works for CSS', async () => {
    const res = await fetch(`${e2e.baseUrl}/src/styles/tokens.css`);
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toContain('css');
  });

  test('JSON responses have correct content-type', async () => {
    const res = await apiFetch(e2e.baseUrl, 'GET', '/api/vaults');
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toContain('application/json');
  });

  test('concurrent requests to different vaults', async () => {
    // Create two vaults
    await apiFetch(e2e.baseUrl, 'POST', '/api/vaults', { name: 'e2e-concurrent-a', password: PASSWORD });
    await apiFetch(e2e.baseUrl, 'POST', '/api/vaults', { name: 'e2e-concurrent-b', password: PASSWORD });

    // Concurrent secret writes
    const [resA, resB] = await Promise.all([
      apiFetch(e2e.baseUrl, 'POST', '/api/vaults/e2e-concurrent-a/secrets/KEY', { value: 'aaa' }),
      apiFetch(e2e.baseUrl, 'POST', '/api/vaults/e2e-concurrent-b/secrets/KEY', { value: 'bbb' }),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // Concurrent reads
    const [getA, getB] = await Promise.all([
      apiFetch(e2e.baseUrl, 'GET', '/api/vaults/e2e-concurrent-a/secrets/KEY'),
      apiFetch(e2e.baseUrl, 'GET', '/api/vaults/e2e-concurrent-b/secrets/KEY'),
    ]);
    const dataA = await getA.json() as { data: { value: string } };
    const dataB = await getB.json() as { data: { value: string } };
    expect(dataA.data.value).toBe('aaa');
    expect(dataB.data.value).toBe('bbb');
  });

  test('large secret value round-trip', async () => {
    await apiFetch(e2e.baseUrl, 'POST', '/api/vaults', { name: 'e2e-large', password: PASSWORD });

    const largeValue = 'x'.repeat(100_000);
    const setRes = await apiFetch(e2e.baseUrl, 'POST', '/api/vaults/e2e-large/secrets/BIG', { value: largeValue });
    expect(setRes.status).toBe(200);

    const getRes = await apiFetch(e2e.baseUrl, 'GET', '/api/vaults/e2e-large/secrets/BIG');
    const data = await getRes.json() as { data: { value: string } };
    expect(data.data.value).toBe(largeValue);
    expect(data.data.value).toHaveLength(100_000);
  });
});
