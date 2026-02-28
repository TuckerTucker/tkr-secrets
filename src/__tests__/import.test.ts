import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDotEnv,
  buildImportPreview,
  ImportStore,
  applyImport,
} from '../import.js';
import { SecretsStore } from '../store.js';
import type { Logger } from '../types.js';

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

describe('parseDotEnv', () => {
  test('basic key=value', () => {
    const result = parseDotEnv('KEY=value');
    expect(result.entries).toEqual([{ name: 'KEY', value: 'value', line: 1 }]);
    expect(result.skipped).toEqual([]);
  });

  test('quoted value', () => {
    const result = parseDotEnv('KEY="hello world"');
    expect(result.entries[0].value).toBe('hello world');
  });

  test('single quoted value (literal, no escapes)', () => {
    const result = parseDotEnv("KEY='literal\\n'");
    expect(result.entries[0].value).toBe('literal\\n');
  });

  test('double quote escapes', () => {
    const result = parseDotEnv('KEY="a\\"b\\\\c"');
    expect(result.entries[0].value).toBe('a"b\\c');
  });

  test('export prefix', () => {
    const result = parseDotEnv('export KEY=value');
    expect(result.entries).toEqual([{ name: 'KEY', value: 'value', line: 1 }]);
  });

  test('comments are skipped', () => {
    const result = parseDotEnv('# comment\nKEY=value');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe('KEY');
  });

  test('empty value', () => {
    const result = parseDotEnv('KEY=');
    expect(result.entries[0].value).toBe('');
  });

  test('invalid key is skipped', () => {
    const result = parseDotEnv('123BAD=x');
    expect(result.entries).toHaveLength(0);
    expect(result.skipped).toEqual([
      { line: 1, reason: 'invalid key format', content: '123BAD=x' },
    ]);
  });

  test('duplicate keys: last wins', () => {
    const result = parseDotEnv('KEY=first\nKEY=second');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].value).toBe('second');
    expect(result.entries[0].line).toBe(2);
  });

  test('no equals sign is skipped', () => {
    const result = parseDotEnv('NOEQ');
    expect(result.entries).toHaveLength(0);
    expect(result.skipped).toEqual([
      { line: 1, reason: 'no assignment', content: 'NOEQ' },
    ]);
  });

  test('BOM is stripped', () => {
    const result = parseDotEnv('\uFEFFKEY=value');
    expect(result.entries[0]).toEqual({ name: 'KEY', value: 'value', line: 1 });
  });

  test('CRLF line endings', () => {
    const result = parseDotEnv('A=1\r\nB=2\r\n');
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].name).toBe('A');
    expect(result.entries[1].name).toBe('B');
  });

  test('value with equals signs', () => {
    const result = parseDotEnv('KEY=a=b=c');
    expect(result.entries[0].value).toBe('a=b=c');
  });

  test('empty lines and whitespace-only lines are skipped', () => {
    const result = parseDotEnv('\n  \n\nKEY=value\n');
    expect(result.entries).toHaveLength(1);
  });

  test('trailing comment in value is NOT stripped', () => {
    const result = parseDotEnv('KEY=value # comment');
    expect(result.entries[0].value).toBe('value # comment');
  });
});

describe('buildImportPreview', () => {
  test('new keys classified as add', () => {
    const parsed = parseDotEnv('NEW_KEY=value');
    const existing = new Map<string, string>();
    const { preview } = buildImportPreview(parsed, existing);
    expect(preview.add).toEqual([{ name: 'NEW_KEY' }]);
    expect(preview.update).toEqual([]);
    expect(preview.unchanged).toEqual([]);
  });

  test('changed values classified as update', () => {
    const parsed = parseDotEnv('KEY=new_value');
    const existing = new Map([['KEY', 'old_value']]);
    const { preview } = buildImportPreview(parsed, existing);
    expect(preview.add).toEqual([]);
    expect(preview.update).toEqual([{ name: 'KEY' }]);
    expect(preview.unchanged).toEqual([]);
  });

  test('same values classified as unchanged', () => {
    const parsed = parseDotEnv('KEY=same');
    const existing = new Map([['KEY', 'same']]);
    const { preview } = buildImportPreview(parsed, existing);
    expect(preview.add).toEqual([]);
    expect(preview.update).toEqual([]);
    expect(preview.unchanged).toEqual([{ name: 'KEY' }]);
  });

  test('skipped lines are passed through', () => {
    const parsed = parseDotEnv('123BAD=x\nGOOD=y');
    const { preview } = buildImportPreview(parsed, new Map());
    expect(preview.skipped).toHaveLength(1);
    expect(preview.add).toEqual([{ name: 'GOOD' }]);
  });
});

describe('ImportStore', () => {
  test('create and consume round-trip', () => {
    const store = new ImportStore();
    const entries = [{ name: 'A', value: '1', line: 1 }];
    const preview = { add: [{ name: 'A' }], update: [], unchanged: [], skipped: [] };
    const id = store.create(entries, preview);
    const result = store.consume(id);
    expect(result).not.toBeNull();
    expect(result!.entries).toEqual(entries);
    expect(result!.preview).toEqual(preview);
    expect(typeof result!.createdAt).toBe('number');
  });

  test('consume returns null for unknown ID', () => {
    const store = new ImportStore();
    expect(store.consume('nonexistent')).toBeNull();
  });

  test('second consume returns null (one-time)', () => {
    const store = new ImportStore();
    const id = store.create([], { add: [], update: [], unchanged: [], skipped: [] });
    expect(store.consume(id)).not.toBeNull();
    expect(store.consume(id)).toBeNull();
  });

  test('expired entries return null', async () => {
    const store = new ImportStore(50); // 50ms TTL
    const id = store.create([], { add: [], update: [], unchanged: [], skipped: [] });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(store.consume(id)).toBeNull();
  });
});

describe('applyImport', () => {
  let tmpDir: string;
  let filePath: string;
  const password = 'test-password-123';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tkr-import-test-'));
    filePath = join(tmpDir, 'secrets-test.enc.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('adds new secrets and updates changed ones', async () => {
    const store = new SecretsStore({
      filePath,
      autoLockMs: 60_000,
      logger: createTestLogger(),
    });
    await store.init(password);
    await store.set('EXISTING', 'old');
    await store.set('SAME', 'unchanged');

    const entries = [
      { name: 'NEW_KEY', value: 'new', line: 1 },
      { name: 'EXISTING', value: 'updated', line: 2 },
      { name: 'SAME', value: 'unchanged', line: 3 },
    ];

    const result = await applyImport(store, entries);

    expect(result).toEqual({ added: 1, updated: 1, unchanged: 1 });
    expect(store.get('NEW_KEY')).toBe('new');
    expect(store.get('EXISTING')).toBe('updated');
    expect(store.get('SAME')).toBe('unchanged');

    store.lock();
  });
});
