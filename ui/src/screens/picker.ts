/**
 * Vault picker screen.
 *
 * Displays a grid of vault cards with status indicators and a create vault card.
 * Polls the API every 30 seconds for state updates.
 *
 * @module screens/picker
 */

import { api } from "../api.js";
import { ICON_LOCK, ICON_UNLOCK, setIcon } from "../icons.js";

/** Shape of a single vault returned by GET /api/vaults. */
export interface VaultSummary {
  name: string;
  fileExists: boolean;
  unlocked: boolean;
  secretCount: number;
  groupCount: number;
  lastAccessed: string | null;
}

/** Callbacks the picker delegates to its parent. */
export interface PickerOptions {
  onSelectVault: (name: string, unlocked: boolean) => void;
  onCreateVault: () => void;
}

const POLL_INTERVAL_MS = 30_000;
const VAULT_NAME_RE = /^[a-z][a-z0-9-]*$/;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let containerRef: HTMLElement | null = null;
let currentOptions: PickerOptions | null = null;
/** Tracks which vault card is in the "confirm delete" state. */
let pendingDeleteName: string | null = null;

/**
 * Formats a timestamp as a human-readable relative string.
 *
 * @param isoDate - ISO 8601 date string, or null.
 * @returns A relative time string like "2 min ago", "yesterday", or "Never".
 */
function relativeTime(isoDate: string | null): string {
  if (!isoDate) return "Never";
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffSec = Math.floor((now - then) / 1000);

  if (diffSec < 60) return "Just now";
  if (diffSec < 3600) {
    const mins = Math.floor(diffSec / 60);
    return `${mins} min ago`;
  }
  if (diffSec < 86400) {
    const hrs = Math.floor(diffSec / 3600);
    return `${hrs}h ago`;
  }
  if (diffSec < 172800) return "Yesterday";
  const days = Math.floor(diffSec / 86400);
  if (days < 30) return `${days}d ago`;
  return new Date(isoDate).toLocaleDateString();
}

/**
 * Creates a vault card DOM element.
 *
 * @param vault - Vault metadata.
 * @param opts - Picker callbacks.
 * @returns The card element.
 */
function createVaultCard(vault: VaultSummary, opts: PickerOptions): HTMLElement {
  const card = document.createElement("div");
  card.className = `card${vault.unlocked ? " card--unlocked" : ""}`;
  card.setAttribute("role", "button");
  card.setAttribute("tabindex", "0");
  card.dataset.vault = vault.name;
  card.setAttribute("aria-label", `${vault.name} vault, ${vault.unlocked ? "unlocked" : "locked"}`);

  // Lock icon
  const icon = document.createElement("span");
  icon.style.marginBottom = "var(--space-2)";
  icon.style.display = "flex";
  icon.style.justifyContent = "center";
  setIcon(icon, vault.unlocked ? ICON_UNLOCK : ICON_LOCK);

  // Name
  const name = document.createElement("div");
  name.style.fontWeight = "var(--font-weight-semibold)";
  name.style.color = "var(--color-text-primary)";
  name.style.fontSize = "var(--font-size-lg)";
  name.textContent = vault.name;

  // Badge
  const badge = document.createElement("span");
  badge.className = vault.unlocked ? "badge badge--success" : "badge badge--default";
  badge.textContent = vault.unlocked ? "Unlocked" : "Locked";

  // Counts
  const counts = document.createElement("div");
  counts.style.fontSize = "var(--font-size-sm)";
  counts.style.color = "var(--color-text-secondary)";
  counts.textContent = vault.unlocked
    ? `${vault.secretCount} secret${vault.secretCount !== 1 ? "s" : ""} \u00B7 ${vault.groupCount} group${vault.groupCount !== 1 ? "s" : ""}`
    : "";

  // Last accessed
  const accessed = document.createElement("div");
  accessed.style.fontSize = "var(--font-size-xs)";
  accessed.style.color = "var(--color-text-secondary)";
  accessed.style.marginTop = "var(--space-2)";
  accessed.textContent = `Last accessed: ${relativeTime(vault.lastAccessed)}`;

  // Delete button
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn btn--secondary";
  deleteBtn.style.marginTop = "var(--space-3)";
  deleteBtn.style.fontSize = "var(--font-size-xs)";
  deleteBtn.style.padding = "var(--space-1) var(--space-3)";
  deleteBtn.style.alignSelf = "flex-end";
  deleteBtn.textContent = "Delete";
  deleteBtn.setAttribute("aria-label", `Delete vault ${vault.name}`);

  deleteBtn.addEventListener("click", (e: MouseEvent) => {
    e.stopPropagation();
    if (pendingDeleteName === vault.name) {
      performDelete(vault.name);
    } else {
      // Reset any other pending delete
      clearPendingDelete();
      pendingDeleteName = vault.name;
      deleteBtn.textContent = `Remove ${vault.name} permanently?`;
      deleteBtn.className = "btn btn--danger";
    }
  });

  card.style.display = "flex";
  card.style.flexDirection = "column";

  card.append(icon, name, badge, counts, accessed, deleteBtn);

  const handleSelect = (): void => {
    opts.onSelectVault(vault.name, vault.unlocked);
  };
  card.addEventListener("click", handleSelect);
  card.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleSelect();
    }
  });

  return card;
}

/**
 * Creates the "Create New Vault" card.
 *
 * @param opts - Picker callbacks.
 * @returns The create card element.
 */
function createNewVaultCard(opts: PickerOptions): HTMLElement {
  const card = document.createElement("div");
  card.className = "card card--create";
  card.setAttribute("role", "button");
  card.setAttribute("tabindex", "0");
  card.setAttribute("aria-label", "Create new vault");

  const icon = document.createElement("span");
  icon.style.fontSize = "var(--font-size-2xl)";
  icon.textContent = "+";
  icon.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.style.fontWeight = "var(--font-weight-medium)";
  label.textContent = "Create New Vault";

  card.append(icon, label);

  const handleCreate = (): void => {
    opts.onCreateVault();
  };
  card.addEventListener("click", handleCreate);
  card.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleCreate();
    }
  });

  return card;
}

/**
 * Resets any pending delete confirmation state in the UI.
 */
function clearPendingDelete(): void {
  if (!pendingDeleteName || !containerRef) return;
  const card = containerRef.querySelector(`[data-vault="${pendingDeleteName}"]`);
  if (card) {
    const btn = card.querySelector("button");
    if (btn) {
      btn.textContent = "Delete";
      btn.className = "btn btn--secondary";
    }
  }
  pendingDeleteName = null;
}

/**
 * Deletes a vault and removes its card from the grid.
 *
 * @param name - The vault name to delete.
 */
async function performDelete(name: string): Promise<void> {
  try {
    await api<void>("DELETE", `/api/vaults/${encodeURIComponent(name)}`);
    const card = containerRef?.querySelector(`[data-vault="${name}"]`);
    if (card) {
      card.remove();
    }
    pendingDeleteName = null;
    // Check if we need to show empty state
    const remaining = containerRef?.querySelectorAll("[data-vault]");
    if (remaining && remaining.length === 0) {
      await loadAndRender();
    }
  } catch {
    // Revert the button on failure
    clearPendingDelete();
  }
}

/**
 * Updates existing vault cards in place without a full re-render.
 * Falls back to full render if the vault list has changed.
 *
 * @param vaults - Fresh vault data from the API.
 */
function updateCardsInPlace(vaults: VaultSummary[]): void {
  if (!containerRef || !currentOptions) return;

  const existingCards = containerRef.querySelectorAll("[data-vault]");
  const existingNames = new Set<string>();
  existingCards.forEach((el) => {
    existingNames.add((el as HTMLElement).dataset.vault ?? "");
  });

  const freshNames = new Set(vaults.map((v) => v.name));

  // If the vault list changed structurally, do a full re-render
  if (existingNames.size !== freshNames.size || ![...existingNames].every((n) => freshNames.has(n))) {
    renderVaults(vaults);
    return;
  }

  // Update each card's mutable fields in place
  for (const vault of vaults) {
    const card = containerRef.querySelector(`[data-vault="${vault.name}"]`) as HTMLElement | null;
    if (!card) continue;

    // Update class for unlocked border
    card.className = `card${vault.unlocked ? " card--unlocked" : ""}`;
    card.setAttribute("aria-label", `${vault.name} vault, ${vault.unlocked ? "unlocked" : "locked"}`);

    const children = card.children;
    // children[0] = icon, [1] = name, [2] = badge, [3] = counts, [4] = accessed
    if (children[0]) {
      setIcon(children[0] as HTMLElement, vault.unlocked ? ICON_UNLOCK : ICON_LOCK);
    }
    if (children[2]) {
      const badge = children[2] as HTMLElement;
      badge.className = vault.unlocked ? "badge badge--success" : "badge badge--default";
      badge.textContent = vault.unlocked ? "Unlocked" : "Locked";
    }
    if (children[3]) {
      (children[3] as HTMLElement).textContent = vault.unlocked
        ? `${vault.secretCount} secret${vault.secretCount !== 1 ? "s" : ""} \u00B7 ${vault.groupCount} group${vault.groupCount !== 1 ? "s" : ""}`
        : "";
    }
    if (children[4]) {
      (children[4] as HTMLElement).textContent = `Last accessed: ${relativeTime(vault.lastAccessed)}`;
    }
  }
}

/**
 * Renders the vault grid into the container.
 *
 * @param vaults - List of vaults to render.
 */
function renderVaults(vaults: VaultSummary[]): void {
  if (!containerRef || !currentOptions) return;

  containerRef.innerHTML = "";

  const isEmpty = vaults.length === 0;

  // Title
  const title = document.createElement("h1");
  title.style.fontSize = "var(--font-size-xl)";
  title.style.fontWeight = "var(--font-weight-semibold)";
  title.style.color = "var(--color-text-primary)";
  title.style.marginBottom = "var(--space-6)";
  title.textContent = isEmpty ? "Get Started" : "Your Vaults";

  if (isEmpty) {
    const subtitle = document.createElement("p");
    subtitle.style.fontSize = "var(--font-size-sm)";
    subtitle.style.color = "var(--color-text-secondary)";
    subtitle.style.marginTop = "calc(-1 * var(--space-4))";
    subtitle.style.marginBottom = "var(--space-6)";
    subtitle.textContent = "Create your first vault to begin.";
    containerRef.append(title, subtitle);
  } else {
    containerRef.append(title);
  }

  const grid = document.createElement("div");
  grid.className = "vault-grid";

  for (const vault of vaults) {
    grid.appendChild(createVaultCard(vault, currentOptions));
  }

  grid.appendChild(createNewVaultCard(currentOptions));
  containerRef.appendChild(grid);
}

/**
 * Fetches vault data from the API and renders (or updates) the picker.
 *
 * @param isPolling - If true, updates in place rather than full re-render.
 */
async function loadAndRender(isPolling = false): Promise<void> {
  try {
    const data = await api<{ vaults: VaultSummary[] }>("GET", "/api/vaults");
    const vaults = data.vaults;
    if (isPolling) {
      updateCardsInPlace(vaults);
    } else {
      renderVaults(vaults);
    }
  } catch {
    if (!containerRef) return;
    if (!isPolling) {
      containerRef.innerHTML = "";
      const alert = document.createElement("div");
      alert.className = "alert alert--error";
      alert.setAttribute("role", "alert");
      alert.textContent = "Could not load vaults. Check your connection.";
      containerRef.appendChild(alert);
    }
  }
}

/**
 * Renders the vault picker screen into the given container.
 *
 * @param container - The DOM element to render into.
 * @param options - Callbacks for vault selection and creation.
 */
export function render(container: HTMLElement, options: PickerOptions): void {
  destroy();
  containerRef = container;
  currentOptions = options;
  pendingDeleteName = null;

  container.innerHTML = "";
  container.style.maxWidth = "960px";
  container.style.marginInline = "auto";

  loadAndRender(false);

  pollTimer = setInterval(() => {
    loadAndRender(true);
  }, POLL_INTERVAL_MS);
}

/**
 * Cleans up polling intervals and references held by the picker.
 */
export function destroy(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  containerRef = null;
  currentOptions = null;
  pendingDeleteName = null;
}
