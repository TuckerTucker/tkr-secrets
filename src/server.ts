/**
 * Server factory for tkr-secrets.
 *
 * Creates a Bun HTTP server with the vault API and static file serving.
 * Extracted from serve.ts to enable E2E testing with configurable options.
 *
 * @module server
 */

import { join } from 'node:path';
import { VaultManager } from './vault-manager.js';
import { createVaultRouter } from './http/vault-router.js';
import { ImportStore } from './import.js';
import { createNullLogger } from './testing.js';
import type { KeychainProvider } from './keychain.js';
import type { Logger } from './types.js';
import type { Server } from 'bun';

/** Configuration for creating a tkr-secrets server. */
export interface ServerOptions {
  /** Port to listen on. Use 0 for OS-assigned port. */
  readonly port?: number;
  /** Directory where vault files are stored. */
  readonly vaultsDir: string;
  /** Directory containing the UI static files. */
  readonly uiDir: string;
  /** Auto-lock timeout in milliseconds. Defaults to 300_000 (5 minutes). */
  readonly autoLockMs?: number;
  /** Optional keychain provider for auto-unlock. */
  readonly keychain?: KeychainProvider;
  /** Keychain service name. */
  readonly keychainService?: string;
  /** Structured logger. Defaults to a no-op logger. */
  readonly logger?: Logger;
}

/** Result of creating a server, with references for testing and cleanup. */
export interface ServerInstance {
  /** The running Bun HTTP server. */
  readonly server: Server;
  /** The vault manager instance. */
  readonly vaultManager: VaultManager;
}

/**
 * Creates and starts a tkr-secrets HTTP server.
 *
 * @param opts - Server configuration.
 * @returns The running server and vault manager.
 */
export function createServer(opts: ServerOptions): ServerInstance {
  const logger = opts.logger ?? createNullLogger();
  const autoLockMs = opts.autoLockMs ?? 300_000;

  const vaultManager = new VaultManager({
    vaultsDir: opts.vaultsDir,
    autoLockMs,
    logger,
    keychain: opts.keychain,
    keychainService: opts.keychainService,
  });

  vaultManager.scanAndRegister();

  const importStore = new ImportStore();

  const router = createVaultRouter({
    vaultManager,
    importStore,
    logger,
  });

  const uiDir = opts.uiDir;

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (router.match(req.method, url.pathname)) {
        return router.handle(req);
      }

      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = join(uiDir, pathname);
      const file = Bun.file(filePath);

      if (await file.exists()) {
        if (filePath.endsWith('.ts')) {
          return transpileTs(filePath);
        }
        return new Response(file);
      }

      // SPA fallback — serve index.html for client-side routes
      return new Response(Bun.file(join(uiDir, 'index.html')));
    },
  });

  return { server, vaultManager };
}

/** Transpile a TypeScript file to JavaScript for the browser. */
async function transpileTs(filePath: string): Promise<Response> {
  const result = await Bun.build({
    entrypoints: [filePath],
    target: 'browser',
    sourcemap: 'inline',
  });

  if (!result.success) {
    const errors = result.logs.map((l) => l.message).join('\n');
    return new Response(`// Build error:\n// ${errors}`, {
      status: 500,
      headers: { 'content-type': 'application/javascript' },
    });
  }

  const output = result.outputs[0];
  return new Response(output, {
    headers: { 'content-type': 'application/javascript' },
  });
}
