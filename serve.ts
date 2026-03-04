/**
 * Development server entry point for tkr-secrets.
 *
 * Serves the UI on port 3000 with the API backend.
 * TypeScript files under ui/ are transpiled on-the-fly via Bun.build.
 */

import { join } from 'node:path';
import { MacOSKeychainProvider } from './src/keychain.js';
import { createServer } from './src/server.js';
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

const keychain = new MacOSKeychainProvider();

const { server, vaultManager } = createServer({
  port: PORT,
  vaultsDir: VAULTS_DIR,
  uiDir: UI_DIR,
  keychain,
  keychainService: 'tkr-secrets',
  logger,
});

vaultManager.tryAutoUnlockAll().then((count) => {
  if (count > 0) {
    console.log(`Auto-unlocked ${count} vault(s) via keychain`);
  }
});

console.log(`tkr-secrets dev server running at http://localhost:${server.port}`);
console.log(`Vault data: ${VAULTS_DIR}`);
