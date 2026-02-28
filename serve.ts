/**
 * Development server for tkr-secrets.
 *
 * Serves the UI on port 3000 with the API backend.
 * TypeScript files under ui/ are transpiled on-the-fly via Bun.build.
 */

import { join } from 'node:path';
import { VaultManager } from './src/vault-manager.js';
import { createVaultRouter } from './src/http/vault-router.js';
import { ImportStore } from './src/import.js';
import type { Logger } from './src/types.js';

const PORT = Number(process.env['PORT'] ?? 3000);
const VAULTS_DIR = process.env['VAULTS_DIR'] ?? join(import.meta.dir, '.data');
const UI_DIR = join(import.meta.dir, 'ui');

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: (msgOrObj: unknown, msg?: string) => console.log(msg ?? msgOrObj),
  warn: (msgOrObj: unknown, msg?: string) => console.warn(msg ?? msgOrObj),
  error: (msgOrObj: unknown, msg?: string) => console.error(msg ?? msgOrObj),
  fatal: (msgOrObj: unknown, msg?: string) => console.error(msg ?? msgOrObj),
  child: () => logger,
} as Logger;

const vaultManager = new VaultManager({
  vaultsDir: VAULTS_DIR,
  autoLockMs: 300_000,
  logger,
});

const importStore = new ImportStore();

const router = createVaultRouter({
  vaultManager,
  importStore,
  logger,
});

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

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (router.match(req.method, url.pathname)) {
      return router.handle(req);
    }

    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = join(UI_DIR, pathname);
    const file = Bun.file(filePath);

    if (await file.exists()) {
      if (filePath.endsWith('.ts')) {
        return transpileTs(filePath);
      }
      return new Response(file);
    }

    // SPA fallback — serve index.html for client-side routes
    return new Response(Bun.file(join(UI_DIR, 'index.html')));
  },
});

console.log(`tkr-secrets dev server running at http://localhost:${server.port}`);
console.log(`Vault data: ${VAULTS_DIR}`);
