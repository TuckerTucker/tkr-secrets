/**
 * Shared test utilities for integration and E2E tests.
 *
 * Provides in-memory keychain stubs, HTTP request factories,
 * and harness builders to eliminate duplication across test files.
 *
 * @module __tests__/helpers
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNullLogger } from '../testing.js';
import { VaultManager } from '../vault-manager.js';
import { ImportStore } from '../import.js';
import { createVaultRouter } from '../http/vault-router.js';
import { createServer } from '../server.js';
import type { VaultRouter } from '../http/vault-router.js';
import type { KeychainProvider } from '../keychain.js';
import type { Logger } from '../types.js';
import type { Server } from 'bun';

export { createNullLogger } from '../testing.js';

// ── Keychain Stubs ──

/**
 * In-memory keychain provider for testing.
 *
 * Stores keys in a Map, enabling tests to verify keychain
 * save/remove behavior without touching the real macOS Keychain.
 */
export class InMemoryKeychainProvider implements KeychainProvider {
  readonly entries = new Map<string, Buffer>();

  isAvailable(): boolean {
    return true;
  }

  async store(service: string, account: string, key: Buffer): Promise<void> {
    this.entries.set(`${service}:${account}`, Buffer.from(key));
  }

  async retrieve(service: string, account: string): Promise<Buffer | null> {
    return this.entries.get(`${service}:${account}`) ?? null;
  }

  async remove(service: string, account: string): Promise<boolean> {
    return this.entries.delete(`${service}:${account}`);
  }
}

/**
 * Keychain provider that throws on mutating operations.
 *
 * Used to verify that keychain failures are handled gracefully
 * and don't prevent unlock/lock from succeeding.
 */
export class FailingKeychainProvider implements KeychainProvider {
  isAvailable(): boolean {
    return true;
  }

  async store(_service: string, _account: string, _key: Buffer): Promise<void> {
    throw new Error('keychain store failed');
  }

  async retrieve(_service: string, _account: string): Promise<Buffer | null> {
    return null;
  }

  async remove(_service: string, _account: string): Promise<boolean> {
    throw new Error('keychain remove failed');
  }
}

// ── HTTP Request Helpers ──

/**
 * Creates a Request object for testing router handlers.
 *
 * @param method - HTTP method.
 * @param path - URL path (e.g., '/api/vaults').
 * @param body - Optional JSON body.
 * @returns A Request object.
 */
export function req(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = { method };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers = { 'Content-Type': 'application/json' };
  }
  return new Request(`http://localhost${path}`, opts);
}

/**
 * Parses a Response as JSON.
 *
 * @param res - HTTP Response.
 * @returns Parsed JSON object.
 */
export async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

// ── Integration Test Harness ──

/** Integration test harness with router, vault manager, and cleanup. */
export interface IntegrationHarness {
  readonly router: VaultRouter;
  readonly vaultManager: VaultManager;
  readonly importStore: ImportStore;
  readonly keychain: InMemoryKeychainProvider;
  readonly tmpDir: string;
  readonly logger: Logger;
  /** Removes the temp directory. Call in afterEach. */
  cleanup(): void;
}

/** Options for creating an integration test harness. */
export interface IntegrationHarnessOptions {
  /** Keychain provider to use. Defaults to InMemoryKeychainProvider. */
  readonly keychain?: KeychainProvider;
  /** Auto-lock timeout in milliseconds. Defaults to 300_000. */
  readonly autoLockMs?: number;
  /** Keychain service name. Defaults to 'test-service'. */
  readonly keychainService?: string;
}

/**
 * Creates a fully wired integration test harness.
 *
 * Includes VaultManager with keychain, router, import store, and temp directory.
 * Call `cleanup()` in afterEach to remove temp files.
 *
 * @param opts - Optional configuration overrides.
 * @returns The test harness.
 */
export function createIntegrationHarness(opts?: IntegrationHarnessOptions): IntegrationHarness {
  const tmpDir = mkdtempSync(join(tmpdir(), 'tkr-integration-'));
  const logger = createNullLogger();
  const keychain = (opts?.keychain ?? new InMemoryKeychainProvider()) as InMemoryKeychainProvider;

  const vaultManager = new VaultManager({
    vaultsDir: tmpDir,
    autoLockMs: opts?.autoLockMs ?? 300_000,
    logger,
    keychain,
    keychainService: opts?.keychainService ?? 'test-service',
  });

  const importStore = new ImportStore();
  const router = createVaultRouter({ vaultManager, importStore, logger });

  return {
    router,
    vaultManager,
    importStore,
    keychain,
    tmpDir,
    logger,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

// ── E2E Server Helpers ──

/** E2E test server with base URL and cleanup. */
export interface E2EServer {
  readonly server: Server;
  readonly baseUrl: string;
  readonly vaultManager: VaultManager;
  readonly keychain: InMemoryKeychainProvider;
  readonly tmpDir: string;
  /** Stops the server and removes the temp directory. */
  cleanup(): void;
}

/**
 * Creates a real Bun.serve instance on an OS-assigned port for E2E testing.
 *
 * @returns Server instance with base URL and cleanup function.
 */
export function createE2EServer(): E2EServer {
  const tmpDir = mkdtempSync(join(tmpdir(), 'tkr-e2e-'));
  const keychain = new InMemoryKeychainProvider();
  const uiDir = join(import.meta.dir, '..', '..', 'ui');

  const { server, vaultManager } = createServer({
    port: 0,
    vaultsDir: tmpDir,
    uiDir,
    keychain,
    keychainService: 'test-service',
  });

  return {
    server,
    baseUrl: `http://localhost:${server.port}`,
    vaultManager,
    keychain,
    tmpDir,
    cleanup: () => {
      server.stop();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

/**
 * Fetch helper for E2E tests against a running server.
 *
 * @param baseUrl - Server base URL (e.g., 'http://localhost:12345').
 * @param method - HTTP method.
 * @param path - URL path (e.g., '/api/vaults').
 * @param body - Optional JSON body.
 * @returns The fetch Response.
 */
export async function apiFetch(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const opts: RequestInit = { method };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers = { 'Content-Type': 'application/json' };
  }
  return fetch(`${baseUrl}${path}`, opts);
}

/** Default test password used across test files. */
export const PASSWORD = 'test-password-123';
