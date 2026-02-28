import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretsStore } from '../store.js';
import type { Logger } from '../types.js';
import {
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  reorder,
  onSecretCreated,
  onSecretDeleted,
} from '../groups.js';

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

describe('groups', () => {
  let tmpDir: string;
  let store: SecretsStore;
  const password = 'test-password-123';

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tkr-groups-test-'));
    store = new SecretsStore({
      filePath: join(tmpDir, 'secrets.enc.json'),
      autoLockMs: 300_000,
      logger: createTestLogger(),
    });
    await store.init(password);
  });

  afterEach(() => {
    store.lock();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Helper: add a secret and register it in order. */
  async function addSecret(name: string, value: string = 'val'): Promise<void> {
    await store.set(name, value);
    await onSecretCreated(store, name);
  }

  describe('listGroups', () => {
    test('empty — no groups, all secrets ungrouped', async () => {
      await addSecret('A');
      await addSecret('B');

      const result = listGroups(store);
      expect(result.groups).toEqual([]);
      expect(result.ungrouped).toEqual(['A', 'B']);
    });

    test('with groups — secrets correctly partitioned and sorted by order', async () => {
      await addSecret('X');
      await addSecret('Y');
      await addSecret('Z');

      const g1 = await createGroup(store, 'Alpha', ['X', 'Z']);
      const g2 = await createGroup(store, 'Beta', ['Y']);

      const result = listGroups(store);
      expect(result.groups).toHaveLength(2);
      expect(result.groups[0].name).toBe('Alpha');
      expect(result.groups[0].secrets).toEqual(['X', 'Z']);
      expect(result.groups[1].name).toBe('Beta');
      expect(result.groups[1].secrets).toEqual(['Y']);
      expect(result.ungrouped).toEqual([]);
    });
  });

  describe('createGroup', () => {
    test('creates group with correct order and secrets assigned', async () => {
      await addSecret('S1');
      await addSecret('S2');

      const g = await createGroup(store, 'MyGroup', ['S1']);
      expect(g.name).toBe('MyGroup');
      expect(g.order).toBe(0);
      expect(g.secrets).toEqual(['S1']);
      expect(g.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      const g2 = await createGroup(store, 'Second');
      expect(g2.order).toBe(1);
    });

    test('throws on case-insensitive duplicate name', async () => {
      await createGroup(store, 'Dev');
      await expect(createGroup(store, 'dev')).rejects.toThrow('group name already exists');
    });

    test('throws 404 on nonexistent secret', async () => {
      await expect(createGroup(store, 'G', ['NOPE'])).rejects.toThrow('secret not found: NOPE');
    });

    test('throws on empty name', async () => {
      await expect(createGroup(store, '  ')).rejects.toThrow('group name must not be empty');
    });
  });

  describe('updateGroup', () => {
    test('rename updates name and enforces uniqueness', async () => {
      const g = await createGroup(store, 'Original');
      await createGroup(store, 'Other');

      const updated = await updateGroup(store, g.id, { name: 'Renamed' });
      expect(updated.name).toBe('Renamed');
      expect(updated.id).toBe(g.id);

      // Uniqueness check
      await expect(
        updateGroup(store, g.id, { name: 'other' }),
      ).rejects.toThrow('group name already exists');
    });

    test('addSecrets moves secrets into group', async () => {
      await addSecret('A');
      await addSecret('B');
      const g = await createGroup(store, 'G');

      const updated = await updateGroup(store, g.id, { addSecrets: ['A', 'B'] });
      expect(updated.secrets).toEqual(['A', 'B']);
    });

    test('removeSecrets ungroups secrets (does not delete)', async () => {
      await addSecret('A');
      const g = await createGroup(store, 'G', ['A']);

      const updated = await updateGroup(store, g.id, { removeSecrets: ['A'] });
      expect(updated.secrets).toEqual([]);

      // Secret still exists
      expect(store.get('A')).toBe('val');
    });

    test('throws 404 on nonexistent group', async () => {
      await expect(
        updateGroup(store, 'bad-id', { name: 'X' }),
      ).rejects.toThrow('group not found');
    });

    test('throws 404 on nonexistent secret in addSecrets', async () => {
      const g = await createGroup(store, 'G');
      await expect(
        updateGroup(store, g.id, { addSecrets: ['MISSING'] }),
      ).rejects.toThrow('secret not found: MISSING');
    });
  });

  describe('deleteGroup', () => {
    test('removes group and ungroups secrets, returns affected names', async () => {
      await addSecret('S1');
      await addSecret('S2');
      const g = await createGroup(store, 'ToDelete', ['S1', 'S2']);

      const ungrouped = await deleteGroup(store, g.id);
      expect(ungrouped.sort()).toEqual(['S1', 'S2']);

      // Group is gone
      const result = listGroups(store);
      expect(result.groups).toHaveLength(0);
      expect(result.ungrouped).toContain('S1');
      expect(result.ungrouped).toContain('S2');

      // Secrets still exist
      expect(store.get('S1')).toBe('val');
    });

    test('throws 404 on nonexistent group', async () => {
      await expect(deleteGroup(store, 'nonexistent')).rejects.toThrow('group not found');
    });
  });

  describe('reorder', () => {
    test('secrets — replaces order, appends missing alphabetically', async () => {
      await addSecret('C');
      await addSecret('A');
      await addSecret('B');

      await reorder(store, ['B']);

      const order = store.getOrder();
      expect(order[0]).toBe('B');
      // A and C appended alphabetically
      expect(order.slice(1).sort()).toEqual(['A', 'C']);
      expect(order[1]).toBe('A');
      expect(order[2]).toBe('C');
    });

    test('groups — updates order fields', async () => {
      const g1 = await createGroup(store, 'First');
      const g2 = await createGroup(store, 'Second');

      await reorder(store, undefined, [
        { id: g2.id, order: 0 },
        { id: g1.id, order: 1 },
      ]);

      const result = listGroups(store);
      expect(result.groups[0].name).toBe('Second');
      expect(result.groups[1].name).toBe('First');
    });

    test('throws 404 for unknown group ID in groupOrder', async () => {
      await expect(
        reorder(store, undefined, [{ id: 'bad', order: 0 }]),
      ).rejects.toThrow('group not found');
    });
  });

  describe('onSecretCreated', () => {
    test('adds to order array', async () => {
      await store.set('NEW', 'val');
      await onSecretCreated(store, 'NEW');

      expect(store.getOrder()).toContain('NEW');
    });

    test('assigns to group when groupId provided', async () => {
      const g = await createGroup(store, 'G');
      await store.set('NEW', 'val');
      await onSecretCreated(store, 'NEW', g.id);

      expect(store.getOrder()).toContain('NEW');
      expect(store.getSecretGroups().get('NEW')).toBe(g.id);
    });

    test('does not duplicate if already in order', async () => {
      await store.set('DUP', 'val');
      await onSecretCreated(store, 'DUP');
      await onSecretCreated(store, 'DUP');

      const count = store.getOrder().filter((n) => n === 'DUP').length;
      expect(count).toBe(1);
    });
  });

  describe('onSecretDeleted', () => {
    test('removes from order and secretGroups', async () => {
      await addSecret('GONE');
      const g = await createGroup(store, 'G', ['GONE']);

      await store.delete('GONE');
      await onSecretDeleted(store, 'GONE');

      expect(store.getOrder()).not.toContain('GONE');
      expect(store.getSecretGroups().has('GONE')).toBe(false);
    });

    test('no-op if secret was not in order or groups', async () => {
      // Should not throw
      await onSecretDeleted(store, 'NEVER_EXISTED');
    });
  });
});
