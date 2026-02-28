/**
 * HTTP router for multi-vault `/api/vaults/*` endpoints.
 *
 * Wires all backend modules (VaultManager, SecretsStore, groups, import,
 * recovery) to the REST API surface defined in `docs/API-SPEC.md`.
 *
 * @module http/vault-router
 */

import type { Logger } from '../types.js';
import type { VaultManager } from '../vault-manager.js';
import type { ImportStore } from '../import.js';
import type { SecretsStore } from '../store.js';
import { validateVaultName } from '../vault-manager.js';
import { writePasswordFile, deletePasswordFile, isPasswordRemembered } from '../password-file.js';
import { buildRecoveryKeyMaterial, parseRecoveryKeyInput } from '../recovery.js';
import { listGroups, createGroup, updateGroup, deleteGroup, reorder, onSecretCreated, onSecretDeleted } from '../groups.js';
import { parseDotEnv, buildImportPreview, applyImport } from '../import.js';

/** Dependencies injected into the vault router. */
export interface VaultRouterDeps {
  readonly vaultManager: VaultManager;
  readonly importStore: ImportStore;
  readonly logger: Logger;
}

/** HTTP router for `/api/vaults` endpoints. */
export interface VaultRouter {
  /** Returns true if this router handles the given method + pathname. */
  match(method: string, pathname: string): boolean;
  /** Handles the request and returns an HTTP response. */
  handle(req: Request): Promise<Response>;
}

/** Parsed route with handler name and extracted path parameters. */
interface ParsedRoute {
  handler: string;
  params: Record<string, string>;
}

const PREFIX = '/api/vaults';

/**
 * Creates a JSON response.
 *
 * @param data - Response body.
 * @param status - HTTP status code.
 * @returns Response object.
 */
function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/**
 * Creates a success envelope response.
 *
 * @param data - Optional response data.
 * @returns Response with `{ success: true, data }`.
 */
function ok(data?: unknown): Response {
  return json({ success: true, data: data ?? {} }, 200);
}

/**
 * Creates an error envelope response.
 *
 * @param error - Human-readable error message.
 * @param status - HTTP status code (default 400).
 * @returns Response with `{ success: false, error }`.
 */
function fail(error: string, status = 400): Response {
  return json({ success: false, error }, status);
}

/**
 * Maps an error message to an HTTP status code.
 *
 * @param message - Error message to inspect.
 * @returns HTTP status code.
 */
function errorToStatus(message: string): number {
  const lower = message.toLowerCase();
  if (lower.includes('locked')) return 423;
  if (lower.includes('not found')) return 404;
  if (lower.includes('already exists')) return 409;
  return 400;
}

/**
 * Parses a request path and method into a handler name and parameters.
 *
 * More specific routes are matched first to avoid ambiguity.
 *
 * @param method - HTTP method.
 * @param path - URL pathname.
 * @returns Parsed route or null if no match.
 */
function parseRoute(method: string, path: string): ParsedRoute | null {
  // Strip trailing slash for consistency
  const p = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;

  // Exact prefix matches first
  if (method === 'GET' && p === PREFIX) {
    return { handler: 'listVaults', params: {} };
  }
  if (method === 'POST' && p === PREFIX) {
    return { handler: 'createVault', params: {} };
  }

  // Everything else starts with /api/vaults/:name
  const afterPrefix = p.slice(PREFIX.length);
  // afterPrefix should be "/:name" or "/:name/..."
  if (!afterPrefix.startsWith('/')) return null;

  const segments = afterPrefix.slice(1).split('/');
  if (segments.length === 0 || !segments[0]) return null;

  const name = decodeURIComponent(segments[0]);

  // /api/vaults/:name
  if (segments.length === 1) {
    if (method === 'DELETE') return { handler: 'deleteVault', params: { name } };
    return null;
  }

  const sub = segments[1];

  // /api/vaults/:name/import/confirm
  if (segments.length === 3 && sub === 'import' && segments[2] === 'confirm') {
    if (method === 'POST') return { handler: 'importConfirm', params: { name } };
    return null;
  }

  // /api/vaults/:name/secrets/:secret
  if (segments.length === 3 && sub === 'secrets') {
    const secret = decodeURIComponent(segments[2]);
    if (method === 'GET') return { handler: 'getSecret', params: { name, secret } };
    if (method === 'POST') return { handler: 'setSecret', params: { name, secret } };
    if (method === 'DELETE') return { handler: 'deleteSecret', params: { name, secret } };
    return null;
  }

  // /api/vaults/:name/groups/:group
  if (segments.length === 3 && sub === 'groups') {
    const group = decodeURIComponent(segments[2]);
    if (method === 'PATCH') return { handler: 'updateGroup', params: { name, group } };
    if (method === 'DELETE') return { handler: 'deleteGroup', params: { name, group } };
    return null;
  }

  // Two-segment sub-paths: /api/vaults/:name/<action>
  if (segments.length === 2) {
    if (sub === 'status' && method === 'GET') return { handler: 'vaultStatus', params: { name } };
    if (sub === 'unlock' && method === 'POST') return { handler: 'unlock', params: { name } };
    if (sub === 'lock' && method === 'POST') return { handler: 'lock', params: { name } };
    if (sub === 'remember' && method === 'POST') return { handler: 'remember', params: { name } };
    if (sub === 'remember' && method === 'DELETE') return { handler: 'forgetPassword', params: { name } };
    if (sub === 'change-password' && method === 'POST') return { handler: 'changePassword', params: { name } };
    if (sub === 'recover' && method === 'POST') return { handler: 'recover', params: { name } };
    if (sub === 'secrets' && method === 'GET') return { handler: 'listSecrets', params: { name } };
    if (sub === 'groups' && method === 'GET') return { handler: 'listGroups', params: { name } };
    if (sub === 'groups' && method === 'POST') return { handler: 'createGroup', params: { name } };
    if (sub === 'order' && method === 'PUT') return { handler: 'reorder', params: { name } };
    if (sub === 'import' && method === 'POST') return { handler: 'importPreview', params: { name } };
  }

  return null;
}

/**
 * Resolves a vault store by name, throwing a 404-compatible error if not found.
 *
 * @param vaultManager - The vault manager instance.
 * @param name - Vault name.
 * @returns The SecretsStore for the vault.
 * @throws Error with "not found" in the message if vault is not registered.
 */
function getStore(vaultManager: VaultManager, name: string): SecretsStore {
  const store = vaultManager.get(name);
  if (!store) {
    throw new Error(`vault '${name}' not found`);
  }
  return store;
}

/**
 * Creates the vault router that handles all `/api/vaults/*` endpoints.
 *
 * @param deps - Injected dependencies.
 * @returns A VaultRouter instance.
 */
export function createVaultRouter(deps: VaultRouterDeps): VaultRouter {
  const { vaultManager, importStore, logger } = deps;
  const log = logger.child({ component: 'vault-router' });

  return {
    match(_method: string, pathname: string): boolean {
      return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
    },

    async handle(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const route = parseRoute(req.method, url.pathname);

      if (!route) {
        return fail('not found', 404);
      }

      try {
        return await dispatch(route, req);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, handler: route.handler }, 'vault endpoint error');
        return fail(message, errorToStatus(message));
      }
    },
  };

  /**
   * Dispatches to the appropriate handler based on the parsed route.
   *
   * @param route - Parsed route with handler name and params.
   * @param req - Original HTTP request.
   * @returns HTTP response.
   */
  async function dispatch(route: ParsedRoute, req: Request): Promise<Response> {
    const { handler, params } = route;

    switch (handler) {
      case 'listVaults': {
        const summaries = await vaultManager.list();
        return ok({ vaults: summaries });
      }

      case 'createVault': {
        const body = await req.json() as { name?: string; password?: string; remember?: boolean };
        if (!body.name) return fail('name required');
        if (!body.password) return fail('password required');
        validateVaultName(body.name);
        const { recoveryKey } = await vaultManager.create(body.name, body.password);
        if (body.remember) {
          await writePasswordFile(vaultManager.getPasswordFilePath(body.name), body.password);
        }
        const material = await buildRecoveryKeyMaterial(body.name, recoveryKey);
        return ok({ name: body.name, recoveryKey: material });
      }

      case 'deleteVault': {
        const { name } = params;
        await vaultManager.delete(name);
        return ok({ name });
      }

      case 'vaultStatus': {
        const { name } = params;
        const store = getStore(vaultManager, name);
        const status = await store.status();
        const remembered = await isPasswordRemembered(vaultManager.getPasswordFilePath(name));
        return ok({
          name,
          ...status,
          secretCount: store.isUnlocked ? store.getSecretCount() : 0,
          groupCount: store.isUnlocked ? store.getGroupCount() : 0,
          remembered,
          version: 2,
        });
      }

      case 'unlock': {
        const { name } = params;
        const store = getStore(vaultManager, name);
        const body = await req.json() as { password?: string; remember?: boolean };
        if (!body.password) return fail('password required');
        await store.unlock(body.password);
        if (body.remember) {
          await writePasswordFile(vaultManager.getPasswordFilePath(name), body.password);
        }
        return ok({
          secretCount: store.getSecretCount(),
          groupCount: store.getGroupCount(),
        });
      }

      case 'lock': {
        const { name } = params;
        const store = getStore(vaultManager, name);
        store.lock();
        return ok({});
      }

      case 'remember': {
        const { name } = params;
        getStore(vaultManager, name); // verify exists
        const body = await req.json() as { password?: string };
        if (!body.password) return fail('password required');
        await writePasswordFile(vaultManager.getPasswordFilePath(name), body.password);
        return ok({});
      }

      case 'forgetPassword': {
        const { name } = params;
        getStore(vaultManager, name); // verify exists
        deletePasswordFile(vaultManager.getPasswordFilePath(name));
        return ok({});
      }

      case 'changePassword': {
        const { name } = params;
        const store = getStore(vaultManager, name);
        const body = await req.json() as { currentPassword?: string; newPassword?: string; remember?: boolean };
        if (!body.currentPassword) return fail('currentPassword required');
        if (!body.newPassword) return fail('newPassword required');
        await store.changePassword(body.currentPassword, body.newPassword);
        if (body.remember) {
          await writePasswordFile(vaultManager.getPasswordFilePath(name), body.newPassword);
        }
        return ok({});
      }

      case 'recover': {
        const { name } = params;
        const store = getStore(vaultManager, name);
        const body = await req.json() as { recoveryKey?: string; newPassword?: string; remember?: boolean };
        if (!body.recoveryKey) return fail('recoveryKey required');
        if (!body.newPassword) return fail('newPassword required');
        const rk = parseRecoveryKeyInput(body.recoveryKey);
        const newRk = await store.recover(rk, body.newPassword);
        if (body.remember) {
          await writePasswordFile(vaultManager.getPasswordFilePath(name), body.newPassword);
        }
        const material = await buildRecoveryKeyMaterial(name, newRk);
        return ok({ recoveryKey: material });
      }

      case 'listSecrets': {
        const { name } = params;
        const store = getStore(vaultManager, name);
        const secretNames = store.list();
        const secretGroupsMap = store.getSecretGroups();
        const groups = store.getGroups();
        const order = store.getOrder();

        // Build ordered list
        const orderIndex = new Map<string, number>();
        for (let i = 0; i < order.length; i++) {
          orderIndex.set(order[i], i);
        }
        const sorted = [...secretNames].sort((a, b) =>
          (orderIndex.get(a) ?? Infinity) - (orderIndex.get(b) ?? Infinity)
        );

        const secrets = sorted.map((sn) => {
          const groupId = secretGroupsMap.get(sn) ?? null;
          const groupName = groupId ? (groups.get(groupId)?.name ?? null) : null;
          return { name: sn, group: groupId, groupName };
        });

        return ok({ secrets, order: [...order] });
      }

      case 'getSecret': {
        const { name, secret } = params;
        const store = getStore(vaultManager, name);
        // getAll() asserts unlocked, then we check the specific secret
        const allSecrets = store.getAll();
        const value = allSecrets.get(secret);
        if (value === undefined) return fail('secret not found', 404);
        const secretGroupsMap = store.getSecretGroups();
        const groups = store.getGroups();
        const groupId = secretGroupsMap.get(secret) ?? null;
        const groupName = groupId ? (groups.get(groupId)?.name ?? null) : null;
        return ok({ name: secret, value, group: groupId, groupName });
      }

      case 'setSecret': {
        const { name, secret } = params;
        const store = getStore(vaultManager, name);
        const body = await req.json() as { value?: string; group?: string };
        if (body.value === undefined) return fail('value required');
        const allSecrets = store.getAll();
        const existed = allSecrets.has(secret);
        await store.set(secret, body.value);
        if (!existed) {
          await onSecretCreated(store, secret, body.group);
        }
        return ok({ name: secret, created: !existed });
      }

      case 'deleteSecret': {
        const { name, secret } = params;
        const store = getStore(vaultManager, name);
        const existed = await store.delete(secret);
        if (!existed) return fail('secret not found', 404);
        await onSecretDeleted(store, secret);
        return ok({ name: secret });
      }

      case 'listGroups': {
        const { name } = params;
        const store = getStore(vaultManager, name);
        const result = listGroups(store);
        return ok(result);
      }

      case 'createGroup': {
        const { name } = params;
        const store = getStore(vaultManager, name);
        const body = await req.json() as { name?: string; secrets?: string[] };
        if (!body.name) return fail('name required');
        const group = await createGroup(store, body.name, body.secrets);
        return ok({ id: group.id, name: group.name, order: group.order });
      }

      case 'updateGroup': {
        const { name, group: groupId } = params;
        const store = getStore(vaultManager, name);
        const body = await req.json() as { name?: string; addSecrets?: string[]; removeSecrets?: string[] };
        const result = await updateGroup(store, groupId, body);
        return ok({ id: result.id, name: result.name });
      }

      case 'deleteGroup': {
        const { name, group: groupId } = params;
        const store = getStore(vaultManager, name);
        const ungroupedSecrets = await deleteGroup(store, groupId);
        return ok({ id: groupId, ungroupedSecrets });
      }

      case 'reorder': {
        const { name } = params;
        const store = getStore(vaultManager, name);
        const body = await req.json() as { secretOrder?: string[]; groupOrder?: Array<{ id: string; order: number }> };
        await reorder(store, body.secretOrder, body.groupOrder);
        return ok({});
      }

      case 'importPreview': {
        const { name } = params;
        const store = getStore(vaultManager, name);
        const body = await req.json() as { content?: string };
        if (!body.content) return fail('content required');
        const parsed = parseDotEnv(body.content);
        const { preview, entries } = buildImportPreview(parsed, store.getAll());
        if (entries.length === 0) return fail('no valid entries found');
        const importId = importStore.create(entries, preview);
        return ok({ preview, importId });
      }

      case 'importConfirm': {
        const { name } = params;
        const store = getStore(vaultManager, name);
        const body = await req.json() as { importId?: string };
        if (!body.importId) return fail('importId required');
        const pending = importStore.consume(body.importId);
        if (!pending) return fail('import expired or not found');
        const result = await applyImport(store, pending.entries);
        return ok(result);
      }

      default:
        return fail('not found', 404);
    }
  }
}
