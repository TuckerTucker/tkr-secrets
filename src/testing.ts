/**
 * Test utilities for tkr-secrets.
 */

import type { Logger } from './types.js';

/** Creates a no-op logger for testing. */
export function createNullLogger(): Logger {
  const noop = (): void => {};
  const nullLogger: Logger = {
    trace: noop as Logger['trace'],
    debug: noop as Logger['debug'],
    info: noop as Logger['info'],
    warn: noop as Logger['warn'],
    error: noop as Logger['error'],
    fatal: noop as Logger['fatal'],
    child: (): Logger => nullLogger,
  };
  return nullLogger;
}
