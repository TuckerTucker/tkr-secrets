/**
 * Groups logic: CRUD operations, secret-group assignment, and ordering.
 *
 * Pure functions that operate on a {@link SecretsStore} instance via its
 * group/order accessors and mutators. No direct file I/O.
 *
 * @module groups
 */

import { randomUUID } from 'node:crypto';
import type { SecretsStore } from './store.js';
import type { GroupMeta } from './types.js';

/** A group with its resolved list of secret names. */
export interface GroupWithSecrets {
  id: string;
  name: string;
  order: number;
  secrets: string[];
}

/** Result of listing all groups and ungrouped secrets. */
export interface GroupList {
  groups: GroupWithSecrets[];
  ungrouped: string[];
}

/** Partial update payload for {@link updateGroup}. */
export interface GroupUpdate {
  name?: string;
  addSecrets?: string[];
  removeSecrets?: string[];
}

/** Entry for reordering groups. */
export interface GroupOrderEntry {
  id: string;
  order: number;
}

/**
 * Lists all groups with their secrets, plus ungrouped secrets.
 *
 * Groups are sorted by their `order` field. Secrets within each group
 * and in the ungrouped list are sorted by their position in the vault
 * order array.
 *
 * @param store - Unlocked secrets store.
 * @returns Groups sorted by order, and ungrouped secret names in vault order.
 */
export function listGroups(store: SecretsStore): GroupList {
  const groups = store.getGroups();
  const secretGroups = store.getSecretGroups();
  const order = store.getOrder();

  // Build a set of all secret names for order lookup
  const orderIndex = new Map<string, number>();
  for (let i = 0; i < order.length; i++) {
    orderIndex.set(order[i], i);
  }

  // Partition secrets into groups
  const groupSecrets = new Map<string, string[]>();
  for (const [groupId] of groups) {
    groupSecrets.set(groupId, []);
  }

  const ungrouped: string[] = [];
  const allSecretNames = store.list();

  for (const name of allSecretNames) {
    const groupId = secretGroups.get(name);
    if (groupId && groupSecrets.has(groupId)) {
      groupSecrets.get(groupId)!.push(name);
    } else {
      ungrouped.push(name);
    }
  }

  // Sort by vault order
  const byOrder = (a: string, b: string): number =>
    (orderIndex.get(a) ?? Infinity) - (orderIndex.get(b) ?? Infinity);

  ungrouped.sort(byOrder);

  const result: GroupWithSecrets[] = [];
  for (const [id, meta] of groups) {
    const secrets = groupSecrets.get(id)!;
    secrets.sort(byOrder);
    result.push({ id, name: meta.name, order: meta.order, secrets });
  }

  result.sort((a, b) => a.order - b.order);

  return { groups: result, ungrouped };
}

/**
 * Creates a new group, optionally assigning secrets to it.
 *
 * @param store - Unlocked secrets store.
 * @param name - Group name (must be non-empty, trimmed, unique case-insensitively).
 * @param secretNames - Optional secret names to assign to the new group.
 * @returns The newly created group with its secrets list.
 * @throws Error with status 400 if name is empty or duplicate.
 * @throws Error with status 404 if any secret name does not exist.
 */
export async function createGroup(
  store: SecretsStore,
  name: string,
  secretNames?: string[],
): Promise<GroupWithSecrets> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    const err = new Error('group name must not be empty');
    (err as NodeJS.ErrnoException).code = '400';
    throw err;
  }

  const groups = new Map(store.getGroups());
  const nameLower = trimmed.toLowerCase();

  for (const [, meta] of groups) {
    if (meta.name.toLowerCase() === nameLower) {
      const err = new Error(`group name already exists: ${trimmed}`);
      (err as NodeJS.ErrnoException).code = '400';
      throw err;
    }
  }

  if (secretNames) {
    const existing = store.list();
    const existingSet = new Set(existing);
    for (const sn of secretNames) {
      if (!existingSet.has(sn)) {
        const err = new Error(`secret not found: ${sn}`);
        (err as NodeJS.ErrnoException).code = '404';
        throw err;
      }
    }
  }

  const id = randomUUID();
  let maxOrder = -1;
  for (const [, meta] of groups) {
    if (meta.order > maxOrder) maxOrder = meta.order;
  }
  const order = maxOrder + 1;

  groups.set(id, { name: trimmed, order });
  await store.setGroups(groups);

  if (secretNames && secretNames.length > 0) {
    const secretGroupsMap = new Map(store.getSecretGroups());
    for (const sn of secretNames) {
      secretGroupsMap.set(sn, id);
    }
    await store.setSecretGroups(secretGroupsMap);
  }

  const assignedSecrets = secretNames ?? [];
  return { id, name: trimmed, order, secrets: assignedSecrets };
}

/**
 * Updates an existing group (rename, add/remove secrets).
 *
 * @param store - Unlocked secrets store.
 * @param groupId - ID of the group to update.
 * @param updates - Partial update fields.
 * @returns The updated group with its current secrets list.
 * @throws Error with status 404 if group does not exist or secrets not found.
 * @throws Error with status 400 if new name is duplicate.
 */
export async function updateGroup(
  store: SecretsStore,
  groupId: string,
  updates: GroupUpdate,
): Promise<GroupWithSecrets> {
  const groups = new Map(store.getGroups());
  const meta = groups.get(groupId);
  if (!meta) {
    const err = new Error(`group not found: ${groupId}`);
    (err as NodeJS.ErrnoException).code = '404';
    throw err;
  }

  let updatedName = meta.name;

  if (updates.name !== undefined) {
    const trimmed = updates.name.trim();
    if (trimmed.length === 0) {
      const err = new Error('group name must not be empty');
      (err as NodeJS.ErrnoException).code = '400';
      throw err;
    }
    const nameLower = trimmed.toLowerCase();
    for (const [id, m] of groups) {
      if (id !== groupId && m.name.toLowerCase() === nameLower) {
        const err = new Error(`group name already exists: ${trimmed}`);
        (err as NodeJS.ErrnoException).code = '400';
        throw err;
      }
    }
    updatedName = trimmed;
    groups.set(groupId, { name: updatedName, order: meta.order });
    await store.setGroups(groups);
  }

  const secretGroupsMap = new Map(store.getSecretGroups());
  let changed = false;

  if (updates.addSecrets) {
    const existing = new Set(store.list());
    for (const sn of updates.addSecrets) {
      if (!existing.has(sn)) {
        const err = new Error(`secret not found: ${sn}`);
        (err as NodeJS.ErrnoException).code = '404';
        throw err;
      }
      secretGroupsMap.set(sn, groupId);
      changed = true;
    }
  }

  if (updates.removeSecrets) {
    for (const sn of updates.removeSecrets) {
      if (secretGroupsMap.get(sn) === groupId) {
        secretGroupsMap.delete(sn);
        changed = true;
      }
    }
  }

  if (changed) {
    await store.setSecretGroups(secretGroupsMap);
  }

  // Build current secrets list for this group
  const order = store.getOrder();
  const orderIndex = new Map<string, number>();
  for (let i = 0; i < order.length; i++) {
    orderIndex.set(order[i], i);
  }

  const secrets: string[] = [];
  for (const [sn, gid] of secretGroupsMap) {
    if (gid === groupId) secrets.push(sn);
  }
  secrets.sort((a, b) => (orderIndex.get(a) ?? Infinity) - (orderIndex.get(b) ?? Infinity));

  return { id: groupId, name: updatedName, order: meta.order, secrets };
}

/**
 * Deletes a group, ungrouping all its secrets (secrets are not deleted).
 *
 * @param store - Unlocked secrets store.
 * @param groupId - ID of the group to delete.
 * @returns Array of secret names that were ungrouped.
 * @throws Error with status 404 if group does not exist.
 */
export async function deleteGroup(store: SecretsStore, groupId: string): Promise<string[]> {
  const groups = new Map(store.getGroups());
  if (!groups.has(groupId)) {
    const err = new Error(`group not found: ${groupId}`);
    (err as NodeJS.ErrnoException).code = '404';
    throw err;
  }

  const secretGroupsMap = new Map(store.getSecretGroups());
  const ungrouped: string[] = [];

  for (const [sn, gid] of secretGroupsMap) {
    if (gid === groupId) {
      ungrouped.push(sn);
      secretGroupsMap.delete(sn);
    }
  }

  groups.delete(groupId);
  await store.setGroups(groups);
  await store.setSecretGroups(secretGroupsMap);

  return ungrouped;
}

/**
 * Reorders secrets and/or groups.
 *
 * @param store - Unlocked secrets store.
 * @param secretOrder - New secret order. Secrets not listed are appended alphabetically.
 * @param groupOrder - New group order entries.
 * @throws Error with status 404 if any group ID in groupOrder is not found.
 */
export async function reorder(
  store: SecretsStore,
  secretOrder?: string[],
  groupOrder?: GroupOrderEntry[],
): Promise<void> {
  if (secretOrder) {
    const currentOrder = store.getOrder();
    const provided = new Set(secretOrder);
    const missing = currentOrder.filter((n) => !provided.has(n));
    missing.sort((a, b) => a.localeCompare(b));
    const newOrder = [...secretOrder, ...missing];
    await store.setOrder(newOrder);
  }

  if (groupOrder) {
    const groups = new Map(store.getGroups());
    for (const entry of groupOrder) {
      const meta = groups.get(entry.id);
      if (!meta) {
        const err = new Error(`group not found: ${entry.id}`);
        (err as NodeJS.ErrnoException).code = '404';
        throw err;
      }
      groups.set(entry.id, { name: meta.name, order: entry.order });
    }
    await store.setGroups(groups);
  }
}

/**
 * Hook called when a secret is created. Appends to order and optionally assigns to a group.
 *
 * @param store - Unlocked secrets store.
 * @param name - Name of the newly created secret.
 * @param groupId - Optional group to assign the secret to.
 */
export async function onSecretCreated(
  store: SecretsStore,
  name: string,
  groupId?: string,
): Promise<void> {
  const order = [...store.getOrder()];
  if (!order.includes(name)) {
    order.push(name);
    await store.setOrder(order);
  }

  if (groupId) {
    const secretGroupsMap = new Map(store.getSecretGroups());
    secretGroupsMap.set(name, groupId);
    await store.setSecretGroups(secretGroupsMap);
  }
}

/**
 * Hook called when a secret is deleted. Removes from order and secretGroups.
 *
 * @param store - Unlocked secrets store.
 * @param name - Name of the deleted secret.
 */
export async function onSecretDeleted(store: SecretsStore, name: string): Promise<void> {
  const order = [...store.getOrder()];
  const idx = order.indexOf(name);
  if (idx !== -1) {
    order.splice(idx, 1);
    await store.setOrder(order);
  }

  const secretGroupsMap = new Map(store.getSecretGroups());
  if (secretGroupsMap.has(name)) {
    secretGroupsMap.delete(name);
    await store.setSecretGroups(secretGroupsMap);
  }
}
