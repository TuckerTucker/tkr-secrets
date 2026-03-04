/**
 * Bridges secrets store values into process.env for downstream consumers.
 *
 * Supports two modes:
 * - Mapped: inject specific secrets to specific env vars via SecretMapping[]
 * - Convention: inject ALL secrets as uppercase env vars (secret_name → SECRET_NAME)
 */

import type { Logger } from './types.js';
import type { SecretsStore } from './store.js';
import type { SecretMapping } from './types.js';

/**
 * Injects secret values into process.env based on the provided mappings.
 * Logs warnings for missing required secrets.
 */
export function injectSecretsToEnv(
  store: SecretsStore,
  mappings: readonly SecretMapping[],
  logger: Logger,
): void {
  let injected = 0;
  const missing: string[] = [];

  for (const { secretName, envVar, required } of mappings) {
    const value = store.get(secretName);
    if (value !== undefined) {
      process.env[envVar] = value;
      injected++;
    } else if (required) {
      missing.push(secretName);
    }
  }

  if (missing.length > 0) {
    logger.warn({ missing }, 'required secrets not found');
  }

  if (injected > 0) {
    logger.info({ count: injected }, 'secrets injected to env');
  }
}

/**
 * Injects ALL secrets into process.env using uppercase convention.
 * Secret name "twilio_auth_token" becomes env var "TWILIO_AUTH_TOKEN".
 *
 * Requires the store to be unlocked. After calling this, the store
 * can be safely locked — consumers will read from process.env via
 * the store's get() fallback.
 */
export function injectAllSecretsToEnv(
  store: SecretsStore,
  logger: Logger,
): number {
  const all = store.getAll();
  let count = 0;

  for (const [name, value] of all) {
    const envVar = name.toUpperCase();
    process.env[envVar] = value;
    count++;
  }

  if (count > 0) {
    logger.info({ count }, 'all secrets injected to env');
  }

  return count;
}

/**
 * Syncs a single secret to process.env. Call after set or delete.
 * On set: writes the uppercase env var. On delete: removes it.
 */
export function syncSecretToEnv(name: string, value: string | undefined): void {
  const envVar = name.toUpperCase();
  if (value !== undefined) {
    process.env[envVar] = value;
  } else {
    delete process.env[envVar];
  }
}
