/**
 * `.env` file parser and two-phase import flow for ingesting plaintext
 * secrets into an encrypted vault.
 *
 * @module import
 */

import { randomUUID } from 'node:crypto';
import type { SecretsStore } from './store.js';
import { onSecretCreated } from './groups.js';

/** A successfully parsed key-value entry from a `.env` file. */
export interface ParsedEntry {
  name: string;
  value: string;
  line: number;
}

/** A line that was skipped during parsing, with a reason. */
export interface SkippedLine {
  line: number;
  reason: string;
  content: string;
}

/** Result of parsing a `.env` file. */
export interface ParseResult {
  entries: ParsedEntry[];
  skipped: SkippedLine[];
}

/** An entry in the import preview categorization. */
export interface ImportPreviewEntry {
  name: string;
}

/** Categorized preview of what an import would do. */
export interface ImportPreview {
  add: ImportPreviewEntry[];
  update: ImportPreviewEntry[];
  unchanged: ImportPreviewEntry[];
  skipped: SkippedLine[];
}

/** A pending import awaiting confirmation. */
export interface PendingImport {
  entries: ParsedEntry[];
  preview: ImportPreview;
  createdAt: number;
}

/** Counts of secrets affected by an import. */
export interface ImportResult {
  added: number;
  updated: number;
  unchanged: number;
}

/** Valid key pattern for `.env` variable names. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parses `.env` file content into structured entries.
 *
 * Handles comments, empty lines, `export` prefix stripping, quoted values
 * (double and single), escape sequences in double-quoted values, BOM
 * stripping, and CRLF normalization. Duplicate keys are resolved by
 * last-occurrence-wins.
 *
 * @param content - Raw `.env` file content.
 * @returns Parsed entries and skipped lines with reasons.
 */
export function parseDotEnv(content: string): ParseResult {
  // Strip UTF-8 BOM if present
  const cleaned = content.startsWith('\uFEFF') ? content.slice(1) : content;

  // Normalize CRLF to LF
  const normalized = cleaned.replace(/\r\n/g, '\n');

  const lines = normalized.split('\n');
  const skipped: SkippedLine[] = [];
  const entryMap = new Map<string, ParsedEntry>();

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const raw = lines[i];
    const trimmed = raw.trim();

    // Skip empty lines, whitespace-only lines, and comments
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    // Strip export prefix
    let line = trimmed;
    if (line.startsWith('export ')) {
      line = line.slice(7);
    }

    // Split on first =
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) {
      skipped.push({ line: lineNumber, reason: 'no assignment', content: raw });
      continue;
    }

    const key = line.slice(0, eqIndex);
    const rawValue = line.slice(eqIndex + 1);

    // Validate key
    if (!KEY_RE.test(key)) {
      skipped.push({ line: lineNumber, reason: 'invalid key format', content: raw });
      continue;
    }

    // Parse value
    const value = parseValue(rawValue.trim());

    // Last occurrence wins — overwrite earlier entries
    entryMap.set(key, { name: key, value, line: lineNumber });
  }

  const entries = [...entryMap.values()];
  return { entries, skipped };
}

/**
 * Parses a raw value string, handling double-quoted, single-quoted, and
 * unquoted forms.
 *
 * @param raw - Trimmed raw value from `.env` line.
 * @returns Resolved value string.
 */
function parseValue(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    // Double-quoted: unescape \" and \\
    const inner = raw.slice(1, -1);
    return inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }

  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    // Single-quoted: literal, no escape processing
    return raw.slice(1, -1);
  }

  // Unquoted: use as-is
  return raw;
}

/**
 * Builds a preview of what importing the parsed entries would do, by
 * comparing against existing secrets in the vault.
 *
 * @param parsed - Result from {@link parseDotEnv}.
 * @param existingSecrets - Current secrets in the vault (name to value).
 * @returns Categorized preview and the deduplicated entries to import.
 */
export function buildImportPreview(
  parsed: ParseResult,
  existingSecrets: ReadonlyMap<string, string>,
): { preview: ImportPreview; entries: ParsedEntry[] } {
  const add: ImportPreviewEntry[] = [];
  const update: ImportPreviewEntry[] = [];
  const unchanged: ImportPreviewEntry[] = [];

  for (const entry of parsed.entries) {
    const existing = existingSecrets.get(entry.name);
    if (existing === undefined) {
      add.push({ name: entry.name });
    } else if (existing !== entry.value) {
      update.push({ name: entry.name });
    } else {
      unchanged.push({ name: entry.name });
    }
  }

  return {
    preview: { add, update, unchanged, skipped: parsed.skipped },
    entries: parsed.entries,
  };
}

/**
 * In-memory store for pending imports with TTL-based expiration.
 *
 * Each pending import is stored with a UUID identifier and can only be
 * consumed once (destructive read). Expired entries are cleaned up on
 * every {@link create} and {@link consume} call.
 */
export class ImportStore {
  private pending: Map<string, PendingImport> = new Map();
  private readonly ttlMs: number;

  /**
   * Creates a new ImportStore.
   *
   * @param ttlMs - Time-to-live for pending imports in milliseconds. Defaults to 5 minutes.
   */
  constructor(ttlMs: number = 300_000) {
    this.ttlMs = ttlMs;
  }

  /**
   * Stores a pending import and returns its unique identifier.
   *
   * @param entries - Parsed entries to import.
   * @param preview - Categorized preview of the import.
   * @returns UUID identifier for the pending import.
   */
  create(entries: ParsedEntry[], preview: ImportPreview): string {
    this.cleanup();
    const id = randomUUID();
    this.pending.set(id, {
      entries,
      preview,
      createdAt: Date.now(),
    });
    return id;
  }

  /**
   * Retrieves and removes a pending import. Returns null if the import
   * has expired or does not exist. This is a destructive operation — the
   * import can only be consumed once.
   *
   * @param importId - UUID of the pending import.
   * @returns The pending import, or null if not found or expired.
   */
  consume(importId: string): PendingImport | null {
    this.cleanup();
    const pending = this.pending.get(importId);
    if (!pending) {
      return null;
    }
    this.pending.delete(importId);
    return pending;
  }

  /** Removes all expired entries from the store. */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, entry] of this.pending) {
      if (now - entry.createdAt >= this.ttlMs) {
        this.pending.delete(id);
      }
    }
  }
}

/**
 * Applies parsed entries to the secrets store, creating new secrets and
 * updating changed ones. Secrets with identical values are skipped.
 *
 * @param store - The unlocked secrets store to apply entries to.
 * @param entries - Parsed entries from a `.env` file.
 * @returns Counts of added, updated, and unchanged secrets.
 */
export async function applyImport(
  store: SecretsStore,
  entries: ParsedEntry[],
): Promise<ImportResult> {
  let added = 0;
  let updated = 0;
  let unchanged = 0;

  for (const entry of entries) {
    const existing = store.get(entry.name);
    if (existing === undefined) {
      await store.set(entry.name, entry.value);
      await onSecretCreated(store, entry.name);
      added++;
    } else if (existing !== entry.value) {
      await store.set(entry.name, entry.value);
      updated++;
    } else {
      unchanged++;
    }
  }

  return { added, updated, unchanged };
}
