/**
 * Integration tests for the .env import pipeline.
 *
 * Verifies preview → confirm → verify round-trips through the full
 * VaultRouter → VaultManager → SecretsStore stack.
 *
 * @module __tests__/integration/import-roundtrip
 */

import { describe, expect, test, afterEach } from 'bun:test';
import {
  createIntegrationHarness,
  req,
  json,
  PASSWORD,
} from '../helpers.js';
import type { IntegrationHarness } from '../helpers.js';

describe('import roundtrip', () => {
  let h: IntegrationHarness;

  afterEach(() => {
    if (h) h.cleanup();
  });

  test('preview → confirm → secrets available', async () => {
    h = createIntegrationHarness();

    await h.router.handle(req('POST', '/api/vaults', { name: 'myapp', password: PASSWORD }));

    const previewRes = await h.router.handle(req('POST', '/api/vaults/myapp/import', {
      content: 'API_KEY=secret123\nDATABASE_URL=postgres://localhost/db\n',
    }));
    expect(previewRes.status).toBe(200);
    const preview = (await json(previewRes)).data as { importId: string; preview: { add: unknown[] } };
    expect(preview.preview.add).toHaveLength(2);

    const confirmRes = await h.router.handle(req('POST', '/api/vaults/myapp/import/confirm', {
      importId: preview.importId,
    }));
    expect(confirmRes.status).toBe(200);

    const getRes = await h.router.handle(req('GET', '/api/vaults/myapp/secrets/API_KEY'));
    expect(((await json(getRes)).data as { value: string }).value).toBe('secret123');
  });

  test('imported data persists through lock/unlock', async () => {
    h = createIntegrationHarness();

    await h.router.handle(req('POST', '/api/vaults', { name: 'myapp', password: PASSWORD }));

    const previewRes = await h.router.handle(req('POST', '/api/vaults/myapp/import', {
      content: 'PERSISTENT_KEY=keep-this\n',
    }));
    const preview = (await json(previewRes)).data as { importId: string };
    await h.router.handle(req('POST', '/api/vaults/myapp/import/confirm', { importId: preview.importId }));

    await h.router.handle(req('POST', '/api/vaults/myapp/lock'));
    await h.router.handle(req('POST', '/api/vaults/myapp/unlock', { password: PASSWORD }));

    const getRes = await h.router.handle(req('GET', '/api/vaults/myapp/secrets/PERSISTENT_KEY'));
    expect(getRes.status).toBe(200);
    expect(((await json(getRes)).data as { value: string }).value).toBe('keep-this');
  });

  test('import with conflicts shows correct add/update counts', async () => {
    h = createIntegrationHarness();

    await h.router.handle(req('POST', '/api/vaults', { name: 'myapp', password: PASSWORD }));
    await h.router.handle(req('POST', '/api/vaults/myapp/secrets/EXISTING', { value: 'old' }));

    const previewRes = await h.router.handle(req('POST', '/api/vaults/myapp/import', {
      content: 'NEW_KEY=hello\nEXISTING=updated\n',
    }));
    const preview = (await json(previewRes)).data as {
      importId: string;
      preview: { add: unknown[]; update: unknown[]; skip: unknown[] };
    };

    expect(preview.preview.add).toHaveLength(1);
    expect(preview.preview.update).toHaveLength(1);

    const confirmRes = await h.router.handle(req('POST', '/api/vaults/myapp/import/confirm', {
      importId: preview.importId,
    }));
    const result = (await json(confirmRes)).data as { added: number; updated: number };
    expect(result.added).toBe(1);
    expect(result.updated).toBe(1);
  });

  test('confirm with invalid importId returns 400', async () => {
    h = createIntegrationHarness();

    await h.router.handle(req('POST', '/api/vaults', { name: 'myapp', password: PASSWORD }));

    const res = await h.router.handle(req('POST', '/api/vaults/myapp/import/confirm', {
      importId: 'nonexistent-id',
    }));
    expect(res.status).toBe(400);
  });

  test('double-confirm same importId fails', async () => {
    h = createIntegrationHarness();

    await h.router.handle(req('POST', '/api/vaults', { name: 'myapp', password: PASSWORD }));

    const previewRes = await h.router.handle(req('POST', '/api/vaults/myapp/import', {
      content: 'KEY=value\n',
    }));
    const preview = (await json(previewRes)).data as { importId: string };

    // First confirm succeeds
    const first = await h.router.handle(req('POST', '/api/vaults/myapp/import/confirm', {
      importId: preview.importId,
    }));
    expect(first.status).toBe(200);

    // Second confirm fails
    const second = await h.router.handle(req('POST', '/api/vaults/myapp/import/confirm', {
      importId: preview.importId,
    }));
    expect(second.status).toBe(400);
  });
});
