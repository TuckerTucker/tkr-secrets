/**
 * HTTP router for secrets management endpoints.
 * All endpoints require bearer token authentication.
 */

import type { Logger } from '../types.js';
import type { SecretsStore } from '../store.js';
import { injectAllSecretsToEnv } from '../env-bridge.js';
import {
  writePasswordFile,
  deletePasswordFile,
  isPasswordRemembered,
} from '../password-file.js';

export interface SecretsRouterDeps {
  readonly store: SecretsStore;
  readonly passwordFilePath: string;
  readonly logger: Logger;
}

export interface SecretsRouter {
  match(method: string, pathname: string): boolean;
  handle(req: Request): Promise<Response>;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function ok(data?: unknown): Response {
  return json({ success: true, data });
}

function fail(error: string, status = 400): Response {
  return json({ success: false, error }, status);
}

export function createSecretsRouter(deps: SecretsRouterDeps): SecretsRouter {
  const { store, passwordFilePath, logger } = deps;
  const log = logger.child({ component: 'secrets-router' });

  const PREFIX = '/api/secrets';

  return {
    match(method: string, pathname: string): boolean {
      return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
    },

    async handle(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      try {
        // GET /api/secrets/status
        if (method === 'GET' && path === `${PREFIX}/status`) {
          const status = await store.status();
          const remembered = await isPasswordRemembered(passwordFilePath);
          return ok({ ...status, remembered });
        }

        // POST /api/secrets/init
        if (method === 'POST' && path === `${PREFIX}/init`) {
          const body = await req.json() as { password?: string; remember?: boolean };
          if (!body.password) return fail('password required');
          await store.init(body.password);
          if (body.remember) {
            await writePasswordFile(passwordFilePath, body.password);
          }
          return ok();
        }

        // POST /api/secrets/unlock — decrypt, inject to env, lock immediately
        if (method === 'POST' && path === `${PREFIX}/unlock`) {
          const body = await req.json() as { password?: string; remember?: boolean };
          if (!body.password) return fail('password required');
          await store.unlock(body.password);
          const count = injectAllSecretsToEnv(store, log);
          store.lock();
          if (body.remember) {
            await writePasswordFile(passwordFilePath, body.password);
          }
          return ok({ injected: count });
        }

        // POST /api/secrets/lock
        if (method === 'POST' && path === `${PREFIX}/lock`) {
          store.lock();
          return ok();
        }

        // GET /api/secrets
        if (method === 'GET' && path === PREFIX) {
          const names = store.list();
          return ok({ names });
        }

        // GET /api/secrets/:name
        if (method === 'GET' && path.startsWith(`${PREFIX}/`) && !path.includes('/', PREFIX.length + 1)) {
          const name = path.slice(PREFIX.length + 1);
          if (['status', 'init', 'unlock', 'lock', 'remember'].includes(name)) {
            return fail('not found', 404);
          }
          const value = store.get(name);
          if (value === undefined) return fail('secret not found', 404);
          return ok({ name, value });
        }

        // POST /api/secrets/:name
        if (method === 'POST' && path.startsWith(`${PREFIX}/`)) {
          const name = path.slice(PREFIX.length + 1);
          if (['status', 'init', 'unlock', 'lock', 'remember'].includes(name)) {
            // handled above
            return fail('not found', 404);
          }
          const body = await req.json() as { value?: string };
          if (body.value === undefined) return fail('value required');
          await store.set(name, body.value);
          return ok({ name });
        }

        // DELETE /api/secrets/:name
        if (method === 'DELETE' && path.startsWith(`${PREFIX}/`)) {
          const name = path.slice(PREFIX.length + 1);
          const existed = await store.delete(name);
          if (!existed) return fail('secret not found', 404);
          return ok({ name });
        }

        // POST /api/secrets/remember
        if (method === 'POST' && path === `${PREFIX}/remember`) {
          const body = await req.json() as { password?: string };
          if (!body.password) return fail('password required');
          await writePasswordFile(passwordFilePath, body.password);
          return ok();
        }

        // DELETE /api/secrets/remember
        if (method === 'DELETE' && path === `${PREFIX}/remember`) {
          deletePasswordFile(passwordFilePath);
          return ok();
        }

        return fail('not found', 404);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err }, 'secrets endpoint error');
        return fail(message, message.includes('locked') ? 423 : 400);
      }
    },
  };
}
