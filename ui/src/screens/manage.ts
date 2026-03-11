/**
 * Vault manage screen.
 *
 * Displays secrets, groups, drag-and-drop reorder, import, and settings
 * for an unlocked vault. Polls status every 10 seconds for auto-lock
 * detection and progress bar updates.
 *
 * @module screens/manage
 */

import { api, ApiError } from "../api.js";
import { ICON_LOCK, ICON_EYE, ICON_EYE_OFF, ICON_TRASH, ICON_ARROW_LEFT, setIcon } from "../icons.js";

// ── Types ────────────────────────────────────────────────────────────

/** Status response from GET /api/vaults/:name/status. */
interface VaultStatus {
  name: string;
  unlocked: boolean;
  timeoutRemaining: number;
  secretCount: number;
  groupCount: number;
}

/** Single secret from the list endpoint. */
interface SecretEntry {
  name: string;
  group: string | null;
  groupName: string | null;
}

/** Secrets list response. */
interface SecretsListResponse {
  secrets: SecretEntry[];
  order: string[];
}

/** Single secret value response. */
interface SecretValueResponse {
  name: string;
  value: string;
  group: string | null;
  groupName: string | null;
}

/** Group from the groups endpoint. */
interface GroupEntry {
  id: string;
  name: string;
  order: number;
  secrets: string[];
}

/** Groups list response. */
interface GroupsListResponse {
  groups: GroupEntry[];
  ungrouped: string[];
}

/** Import preview response. */
interface ImportPreviewResponse {
  preview: {
    add: Array<{ name: string }>;
    update: Array<{ name: string }>;
    unchanged: Array<{ name: string }>;
    skipped: Array<{ line: number; reason: string; content: string }>;
  };
  importId: string;
}

/** Import confirm response. */
interface ImportConfirmResponse {
  added: number;
  updated: number;
  unchanged: number;
}

/** Callbacks and configuration for the manage screen. */
export interface ManageScreenOptions {
  /** Name of the vault being managed. */
  vaultName: string;
  /** Called when the vault becomes locked (auto-lock or manual). */
  onLocked: () => void;
  /** Called when the user navigates back. */
  onBack: () => void;
  /** Called when the vault is deleted. */
  onDeleted: () => void;
}

// ── Module State ─────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 10_000;
const AUTO_LOCK_TOTAL_MS = 300_000; // 5 minutes
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

let containerRef: HTMLElement | null = null;
let currentOptions: ManageScreenOptions | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let progressBarFill: HTMLElement | null = null;
let timeoutRemaining = AUTO_LOCK_TOTAL_MS;

/** Currently revealed secrets: secretName → plaintext value. */
let revealedSecrets: Map<string, string> = new Map();

/** Expanded groups. */
let expandedGroups: Set<string> = new Set();

/** Whether the add-secret form is open. */
let addFormOpen = false;

/** Secret currently being edited inline (null = none). */
let editingSecret: string | null = null;

/** Pending delete secret name (progressive disclosure). */
let pendingDeleteSecret: string | null = null;

/** Pending delete vault state. */
let pendingDeleteVault = false;

/** Current import preview data. */
let currentImportPreview: ImportPreviewResponse | null = null;

/** Cached group data for the add-secret form dropdown. */
let cachedGroups: GroupEntry[] = [];

// ── Helper: API Path ─────────────────────────────────────────────────

/**
 * Returns the base API path for the current vault.
 *
 * @returns The vault API path prefix.
 */
function vaultPath(): string {
  if (!currentOptions) return "";
  return `/api/vaults/${encodeURIComponent(currentOptions.vaultName)}`;
}

// ── Progress Bar ─────────────────────────────────────────────────────

/**
 * Updates the auto-lock progress bar fill width.
 *
 * @param remainingMs - Milliseconds remaining until auto-lock.
 */
function updateProgressBar(remainingMs: number): void {
  timeoutRemaining = remainingMs;
  if (!progressBarFill) return;
  const pct = Math.max(0, Math.min(100, (remainingMs / AUTO_LOCK_TOTAL_MS) * 100));
  progressBarFill.style.width = `${pct}%`;
}

// ── Polling ──────────────────────────────────────────────────────────

/**
 * Polls the vault status and updates the progress bar.
 * Triggers onLocked if the vault has been auto-locked.
 */
async function pollStatus(): Promise<void> {
  if (!currentOptions) return;
  try {
    const status = await api<VaultStatus>("GET", `${vaultPath()}/status`);
    if (!status.unlocked) {
      currentOptions.onLocked();
      return;
    }
    updateProgressBar(status.timeoutRemaining);
  } catch {
    // Polling failure is silent
  }
}

// ── Render: Header ───────────────────────────────────────────────────

/**
 * Creates the header area with vault name, progress bar, and lock button.
 *
 * @param opts - Manage screen options.
 * @returns The header element.
 */
function createHeader(opts: ManageScreenOptions): HTMLElement {
  const header = document.createElement("div");
  header.className = "manage-header";

  // Left: back + vault name
  const left = document.createElement("div");
  left.style.cssText = "display:flex;align-items:center;gap:var(--space-3)";

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "btn btn--secondary";
  setIcon(backBtn, ICON_ARROW_LEFT);
  backBtn.setAttribute("aria-label", "Back to vault picker");
  backBtn.addEventListener("click", () => opts.onBack());

  const nameEl = document.createElement("h1");
  nameEl.style.cssText = [
    "font-size:var(--font-size-xl)",
    "font-weight:var(--font-weight-semibold)",
    "color:var(--color-text-primary)",
    "margin:0",
  ].join(";");
  nameEl.textContent = opts.vaultName;

  const badge = document.createElement("span");
  badge.className = "badge badge--success";
  badge.textContent = "Unlocked";

  left.append(backBtn, nameEl, badge);

  // Right: lock button
  const lockBtn = document.createElement("button");
  lockBtn.type = "button";
  lockBtn.className = "btn btn--secondary";
  setIcon(lockBtn, ICON_LOCK);
  lockBtn.appendChild(document.createTextNode(" Lock"));
  lockBtn.setAttribute("aria-label", "Lock vault");
  lockBtn.addEventListener("click", async () => {
    try {
      await api<Record<string, never>>("POST", `${vaultPath()}/lock`);
      opts.onLocked();
    } catch {
      // Lock failure — poll will catch it
    }
  });

  const row = document.createElement("div");
  row.style.cssText = "display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:var(--space-3)";
  row.append(left, lockBtn);

  // Progress bar
  const progressTrack = document.createElement("div");
  progressTrack.className = "manage-progress-track";
  progressTrack.setAttribute("role", "progressbar");
  progressTrack.setAttribute("aria-valuenow", String(timeoutRemaining));
  progressTrack.setAttribute("aria-valuemin", "0");
  progressTrack.setAttribute("aria-valuemax", String(AUTO_LOCK_TOTAL_MS));
  progressTrack.setAttribute("aria-label", "Auto-lock timer");

  progressBarFill = document.createElement("div");
  progressBarFill.className = "manage-progress-fill";
  updateProgressBar(timeoutRemaining);

  progressTrack.appendChild(progressBarFill);

  header.append(row, progressTrack);
  return header;
}

// ── Render: Action Bar ───────────────────────────────────────────────

/**
 * Creates the action bar with Add Secret and Add Group buttons.
 *
 * @returns The action bar element.
 */
function createActionBar(): HTMLElement {
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:var(--space-3);flex-wrap:wrap";

  const addSecretBtn = document.createElement("button");
  addSecretBtn.type = "button";
  addSecretBtn.className = "btn btn--primary";
  addSecretBtn.textContent = "+ Add Secret";
  addSecretBtn.addEventListener("click", () => {
    addFormOpen = !addFormOpen;
    refreshContent();
  });

  const addGroupBtn = document.createElement("button");
  addGroupBtn.type = "button";
  addGroupBtn.className = "btn btn--secondary";
  addGroupBtn.textContent = "+ Add Group";
  addGroupBtn.addEventListener("click", async () => {
    try {
      await api<{ id: string; name: string; order: number }>(
        "POST",
        `${vaultPath()}/groups`,
        { name: "New Group" },
      );
      await refreshContent();
    } catch {
      // Group creation failure — silent for now
    }
  });

  bar.append(addSecretBtn, addGroupBtn);
  return bar;
}

// ── Render: Add Secret Form ──────────────────────────────────────────

/**
 * Creates the inline add-secret form.
 *
 * @returns The form element, or null if the form is closed.
 */
function createAddSecretForm(): HTMLElement | null {
  if (!addFormOpen) return null;

  const form = document.createElement("div");
  form.className = "manage-add-form";

  // Name input
  const nameGroup = document.createElement("div");
  nameGroup.className = "form-group";
  nameGroup.style.flex = "1";

  const nameLabel = document.createElement("label");
  nameLabel.className = "form-group__label";
  nameLabel.setAttribute("for", "add-secret-name");
  nameLabel.textContent = "Name";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.id = "add-secret-name";
  nameInput.className = "input";
  nameInput.placeholder = "SECRET_NAME";
  nameInput.autocomplete = "off";
  nameInput.spellcheck = false;
  nameInput.style.fontFamily = "var(--font-family-mono)";

  const nameError = document.createElement("div");
  nameError.className = "form-group__error";
  nameError.setAttribute("role", "alert");

  nameGroup.append(nameLabel, nameInput, nameError);

  // Value input
  const valueGroup = document.createElement("div");
  valueGroup.className = "form-group";
  valueGroup.style.flex = "1";

  const valueLabel = document.createElement("label");
  valueLabel.className = "form-group__label";
  valueLabel.setAttribute("for", "add-secret-value");
  valueLabel.textContent = "Value";

  const valueWrapper = document.createElement("div");
  valueWrapper.className = "input-wrapper";

  const valueInput = document.createElement("input");
  valueInput.type = "password";
  valueInput.id = "add-secret-value";
  valueInput.className = "input";
  valueInput.placeholder = "Secret value";

  const valueToggle = document.createElement("button");
  valueToggle.type = "button";
  valueToggle.className = "input-wrapper__toggle";
  valueToggle.setAttribute("aria-label", "Toggle value visibility");
  setIcon(valueToggle, ICON_EYE);

  let valueVisible = false;
  valueToggle.addEventListener("click", () => {
    valueVisible = !valueVisible;
    valueInput.type = valueVisible ? "text" : "password";
    setIcon(valueToggle, valueVisible ? ICON_EYE_OFF : ICON_EYE, valueVisible ? "Hide value" : "Show value");
  });

  valueWrapper.append(valueInput, valueToggle);
  valueGroup.append(valueLabel, valueWrapper);

  // Group select
  const groupGroup = document.createElement("div");
  groupGroup.className = "form-group";

  const groupLabel = document.createElement("label");
  groupLabel.className = "form-group__label";
  groupLabel.setAttribute("for", "add-secret-group");
  groupLabel.textContent = "Group";

  const groupSelect = document.createElement("select");
  groupSelect.id = "add-secret-group";
  groupSelect.className = "input";

  const noneOption = document.createElement("option");
  noneOption.value = "";
  noneOption.textContent = "None";
  groupSelect.appendChild(noneOption);

  for (const g of cachedGroups) {
    const opt = document.createElement("option");
    opt.value = g.id;
    opt.textContent = g.name;
    groupSelect.appendChild(opt);
  }

  groupGroup.append(groupLabel, groupSelect);

  // Buttons
  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:var(--space-2);align-items:flex-end";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn btn--primary";
  saveBtn.textContent = "Save";
  saveBtn.disabled = true;

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn btn--secondary";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    addFormOpen = false;
    refreshContent();
  });

  btnRow.append(saveBtn, cancelBtn);

  // Validation
  const validate = (): void => {
    const nameVal = nameInput.value;
    const nameOk = SECRET_NAME_RE.test(nameVal);
    const valueOk = valueInput.value.length > 0;
    saveBtn.disabled = !nameOk || !valueOk;

    if (nameVal.length > 0 && !nameOk) {
      nameError.textContent = "Letters, numbers, and underscores only. Must start with a letter or underscore.";
      nameInput.classList.add("input--error");
    } else {
      nameError.textContent = "";
      nameInput.classList.remove("input--error");
    }
  };

  nameInput.addEventListener("input", validate);
  valueInput.addEventListener("input", validate);

  // Save
  saveBtn.addEventListener("click", async () => {
    if (saveBtn.disabled) return;
    const secretName = nameInput.value;
    const body: { value: string; group?: string } = { value: valueInput.value };
    const selectedGroup = groupSelect.value;
    if (selectedGroup) {
      body.group = selectedGroup;
    }

    try {
      await api<{ name: string; created: boolean }>(
        "POST",
        `${vaultPath()}/secrets/${encodeURIComponent(secretName)}`,
        body,
      );
      addFormOpen = false;
      await refreshContent();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        nameError.textContent = err.message;
        nameInput.classList.add("input--error");
      }
    }
  });

  // Escape to cancel
  const handleKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      addFormOpen = false;
      refreshContent();
    }
  };
  nameInput.addEventListener("keydown", handleKeydown);
  valueInput.addEventListener("keydown", handleKeydown);

  form.append(nameGroup, valueGroup, groupGroup, btnRow);

  // Auto-focus name
  requestAnimationFrame(() => nameInput.focus());

  return form;
}

// ── Render: Secret Row ───────────────────────────────────────────────

/**
 * Creates a single secret row element.
 *
 * @param secretName - The secret's name.
 * @param indented - Whether this secret is inside a group (visual indent).
 * @returns The secret row element.
 */
function createSecretRow(secretName: string, indented: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "manage-secret-row";
  if (indented) {
    row.classList.add("manage-secret-row--grouped");
  }
  row.setAttribute("draggable", "true");
  row.dataset.secret = secretName;

  const isRevealed = revealedSecrets.has(secretName);
  if (isRevealed) {
    row.classList.add("manage-secret-row--revealed");
  }

  // Drag handle
  const handle = document.createElement("span");
  handle.className = "manage-drag-handle";
  handle.textContent = "\u2261";
  handle.setAttribute("aria-roledescription", "sortable");
  handle.setAttribute("aria-label", `Drag to reorder ${secretName}`);

  // Name
  const name = document.createElement("span");
  name.className = "manage-secret-name";
  name.textContent = secretName;

  // Value display / inline edit
  const isEditing = editingSecret === secretName;
  let valueEl: HTMLElement;

  if (isEditing) {
    // Inline edit mode
    const input = document.createElement("input");
    input.type = "text";
    input.className = "manage-secret-input";
    input.value = revealedSecrets.get(secretName) ?? "";
    input.setAttribute("aria-label", `Edit value for ${secretName}`);

    const saveEdit = async (): Promise<void> => {
      const newValue = input.value;
      try {
        await api<{ name: string; created: boolean }>(
          "POST",
          `${vaultPath()}/secrets/${encodeURIComponent(secretName)}`,
          { value: newValue },
        );
        revealedSecrets.set(secretName, newValue);
        editingSecret = null;
        refreshContent();
      } catch {
        // Save failure — stay in edit mode
      }
    };

    const cancelEdit = (): void => {
      editingSecret = null;
      refreshContent();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
      }
    });

    input.addEventListener("blur", () => {
      // Small delay to allow button clicks to register before blur fires
      setTimeout(() => {
        if (editingSecret === secretName) {
          saveEdit();
        }
      }, 150);
    });

    // Auto-focus after render
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });

    valueEl = input;
  } else if (isRevealed) {
    const value = document.createElement("span");
    value.className = "manage-secret-value manage-secret-value--revealed";
    value.textContent = revealedSecrets.get(secretName) ?? "";
    valueEl = value;
  } else {
    const value = document.createElement("span");
    value.className = "manage-secret-value";
    value.textContent = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
    valueEl = value;
  }

  // Actions
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:var(--space-1);align-items:center;margin-left:auto;flex-shrink:0";

  if (!isEditing) {
    // Reveal/hide button
    const revealBtn = document.createElement("button");
    revealBtn.type = "button";
    revealBtn.className = "btn btn--secondary";
    revealBtn.style.cssText = "padding:var(--space-1) var(--space-2);font-size:var(--font-size-sm)";
    setIcon(revealBtn, isRevealed ? ICON_EYE_OFF : ICON_EYE);
    revealBtn.setAttribute("aria-label", isRevealed ? `Hide ${secretName}` : `Reveal ${secretName}`);
    revealBtn.addEventListener("click", async () => {
      if (revealedSecrets.has(secretName)) {
        revealedSecrets.delete(secretName);
        refreshContent();
      } else {
        try {
          const result = await api<SecretValueResponse>(
            "GET",
            `${vaultPath()}/secrets/${encodeURIComponent(secretName)}`,
          );
          revealedSecrets.set(secretName, result.value);
          refreshContent();
        } catch {
          // Reveal failure — silent
        }
      }
    });
    actions.appendChild(revealBtn);

    // Edit + Copy buttons (only when revealed)
    if (isRevealed) {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "btn btn--secondary";
      editBtn.style.cssText = "padding:var(--space-1) var(--space-2);font-size:var(--font-size-sm)";
      editBtn.textContent = "Edit";
      editBtn.setAttribute("aria-label", `Edit ${secretName}`);
      editBtn.addEventListener("click", () => {
        editingSecret = secretName;
        refreshContent();
      });
      actions.appendChild(editBtn);

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "btn btn--secondary";
      copyBtn.style.cssText = "padding:var(--space-1) var(--space-2);font-size:var(--font-size-sm)";
      copyBtn.textContent = "Copy";
      copyBtn.setAttribute("aria-label", `Copy ${secretName} to clipboard`);
      copyBtn.addEventListener("click", () => {
        const val = revealedSecrets.get(secretName);
        if (val) {
          navigator.clipboard.writeText(val).then(() => {
            const original = copyBtn.textContent;
            copyBtn.textContent = "Copied";
            setTimeout(() => {
              copyBtn.textContent = original;
            }, 2000);
          });
        }
      });
      actions.appendChild(copyBtn);
    }
  }

  // Delete button (progressive disclosure)
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "btn btn--secondary";
  deleteBtn.style.cssText = "padding:var(--space-1) var(--space-2);font-size:var(--font-size-sm)";

  if (pendingDeleteSecret === secretName) {
    deleteBtn.textContent = "Delete?";
    deleteBtn.className = "btn btn--danger";
    deleteBtn.style.cssText = "padding:var(--space-1) var(--space-2);font-size:var(--font-size-sm)";
    deleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await api<{ name: string }>(
          "DELETE",
          `${vaultPath()}/secrets/${encodeURIComponent(secretName)}`,
        );
        revealedSecrets.delete(secretName);
        pendingDeleteSecret = null;
        await refreshContent();
      } catch {
        pendingDeleteSecret = null;
        refreshContent();
      }
    });
  } else {
    setIcon(deleteBtn, ICON_TRASH);
    deleteBtn.setAttribute("aria-label", `Delete ${secretName}`);
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      pendingDeleteSecret = secretName;
      refreshContent();
    });
  }
  actions.appendChild(deleteBtn);

  // Drag events
  row.addEventListener("dragstart", (e) => {
    if (e.dataTransfer) {
      e.dataTransfer.setData("text/plain", secretName);
      e.dataTransfer.setData("application/x-tkr-type", "secret");
      e.dataTransfer.effectAllowed = "move";
    }
    row.classList.add("manage-secret-row--dragging");
  });
  row.addEventListener("dragend", () => {
    row.classList.remove("manage-secret-row--dragging");
  });

  row.append(handle, name, valueEl, actions);
  return row;
}

// ── Render: Group ────────────────────────────────────────────────────

/**
 * Creates a group header and its child secrets.
 *
 * @param group - The group data.
 * @param allSecrets - The ordered list of all secret entries.
 * @returns The group container element.
 */
function createGroupSection(group: GroupEntry, allSecrets: SecretEntry[]): HTMLElement {
  const container = document.createElement("div");
  container.className = "manage-group";
  container.dataset.groupId = group.id;

  const isExpanded = expandedGroups.has(group.id);

  // Group header
  const header = document.createElement("div");
  header.className = "manage-group-header";
  header.setAttribute("draggable", "true");
  header.dataset.groupId = group.id;

  // Drag handle
  const handle = document.createElement("span");
  handle.className = "manage-drag-handle manage-drag-handle--group";
  handle.textContent = "\u2261";
  handle.setAttribute("aria-roledescription", "sortable");

  // Group name (editable on rename)
  const nameEl = document.createElement("span");
  nameEl.className = "manage-group-name";
  nameEl.textContent = group.name;

  // Count badge
  const countBadge = document.createElement("span");
  countBadge.className = "badge badge--default";
  countBadge.textContent = String(group.secrets.length);

  // Chevron
  const chevron = document.createElement("button");
  chevron.type = "button";
  chevron.className = "manage-group-chevron";
  chevron.textContent = isExpanded ? "\u25BC" : "\u25B6";
  chevron.setAttribute("aria-label", isExpanded ? "Collapse group" : "Expand group");
  chevron.addEventListener("click", (e) => {
    e.stopPropagation();
    if (expandedGroups.has(group.id)) {
      expandedGroups.delete(group.id);
    } else {
      expandedGroups.add(group.id);
    }
    refreshContent();
  });

  // More menu
  const moreBtn = document.createElement("button");
  moreBtn.type = "button";
  moreBtn.className = "btn btn--secondary";
  moreBtn.style.cssText = "padding:var(--space-1) var(--space-2);font-size:var(--font-size-sm);margin-left:auto";
  moreBtn.textContent = "\u22EF";
  moreBtn.setAttribute("aria-label", `Actions for group ${group.name}`);

  let menuOpen = false;
  const menu = document.createElement("div");
  menu.className = "manage-group-menu";
  menu.style.display = "none";

  const renameItem = document.createElement("button");
  renameItem.type = "button";
  renameItem.className = "manage-group-menu-item";
  renameItem.textContent = "Rename";
  renameItem.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.style.display = "none";
    // Replace name with inline input
    const input = document.createElement("input");
    input.type = "text";
    input.className = "input";
    input.value = group.name;
    input.style.cssText = "font-size:var(--font-size-sm);padding:var(--space-1) var(--space-2);width:120px";
    nameEl.textContent = "";
    nameEl.appendChild(input);
    input.focus();
    input.select();

    const commitRename = async (): Promise<void> => {
      const newName = input.value.trim();
      if (newName && newName !== group.name) {
        try {
          await api<{ id: string; name: string }>(
            "PATCH",
            `${vaultPath()}/groups/${encodeURIComponent(group.id)}`,
            { name: newName },
          );
        } catch {
          // Rename failed — will revert on refresh
        }
      }
      await refreshContent();
    };

    input.addEventListener("blur", commitRename);
    input.addEventListener("keydown", (ke) => {
      if (ke.key === "Enter") {
        input.blur();
      } else if (ke.key === "Escape") {
        nameEl.textContent = group.name;
      }
    });
  });

  const removeItem = document.createElement("button");
  removeItem.type = "button";
  removeItem.className = "manage-group-menu-item";
  removeItem.textContent = "Remove";
  removeItem.addEventListener("click", async (e) => {
    e.stopPropagation();
    menu.style.display = "none";
    try {
      await api<{ id: string; ungroupedSecrets: string[] }>(
        "DELETE",
        `${vaultPath()}/groups/${encodeURIComponent(group.id)}`,
      );
      expandedGroups.delete(group.id);
      await refreshContent();
    } catch {
      // Delete failed
    }
  });

  menu.append(renameItem, removeItem);

  moreBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    menuOpen = !menuOpen;
    menu.style.display = menuOpen ? "flex" : "none";
  });

  // Close menu on outside click
  const closeMenu = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node) && e.target !== moreBtn) {
      menu.style.display = "none";
      menuOpen = false;
    }
  };
  document.addEventListener("click", closeMenu);

  // Drag events for group header
  header.addEventListener("dragstart", (e) => {
    if (e.dataTransfer) {
      e.dataTransfer.setData("text/plain", group.id);
      e.dataTransfer.setData("application/x-tkr-type", "group");
      e.dataTransfer.effectAllowed = "move";
    }
  });

  // Drop zone: secrets can be dropped into this group
  let dragExpandTimer: ReturnType<typeof setTimeout> | null = null;

  container.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
    container.classList.add("manage-group--dragover");

    // Auto-expand collapsed group after 500ms hover
    if (!expandedGroups.has(group.id) && !dragExpandTimer) {
      dragExpandTimer = setTimeout(() => {
        expandedGroups.add(group.id);
        refreshContent();
      }, 500);
    }
  });

  container.addEventListener("dragleave", () => {
    container.classList.remove("manage-group--dragover");
    if (dragExpandTimer) {
      clearTimeout(dragExpandTimer);
      dragExpandTimer = null;
    }
  });

  container.addEventListener("drop", async (e) => {
    e.preventDefault();
    container.classList.remove("manage-group--dragover");
    if (dragExpandTimer) {
      clearTimeout(dragExpandTimer);
      dragExpandTimer = null;
    }

    const type = e.dataTransfer?.getData("application/x-tkr-type");
    const data = e.dataTransfer?.getData("text/plain");
    if (type === "secret" && data) {
      try {
        await api<{ id: string; name: string }>(
          "PATCH",
          `${vaultPath()}/groups/${encodeURIComponent(group.id)}`,
          { addSecrets: [data] },
        );
        await refreshContent();
      } catch {
        // Drop failed
      }
    }
  });

  const moreContainer = document.createElement("div");
  moreContainer.style.cssText = "position:relative";
  moreContainer.append(moreBtn, menu);

  header.append(handle, chevron, nameEl, countBadge, moreContainer);
  container.appendChild(header);

  // Children
  if (isExpanded) {
    const childContainer = document.createElement("div");
    childContainer.className = "manage-group-children";

    if (group.secrets.length === 0) {
      const placeholder = document.createElement("div");
      placeholder.className = "manage-group-empty";
      placeholder.textContent = "Drag secrets here";
      childContainer.appendChild(placeholder);
    } else {
      // Render secrets in group order (filtered from allSecrets ordering)
      const groupSecretSet = new Set(group.secrets);
      const orderedGroupSecrets = allSecrets
        .filter((s) => groupSecretSet.has(s.name))
        .map((s) => s.name);

      // Include any group secrets not in allSecrets ordering
      for (const sn of group.secrets) {
        if (!orderedGroupSecrets.includes(sn)) {
          orderedGroupSecrets.push(sn);
        }
      }

      for (const sn of orderedGroupSecrets) {
        childContainer.appendChild(createSecretRow(sn, true));
      }
    }

    container.appendChild(childContainer);
  }

  return container;
}

// ── Render: Secret List ──────────────────────────────────────────────

/**
 * Creates the full secret list with groups and ungrouped secrets.
 *
 * @param secretsData - Response from the secrets list endpoint.
 * @param groupsData - Response from the groups list endpoint.
 * @returns The list container element.
 */
function createSecretList(
  secretsData: SecretsListResponse,
  groupsData: GroupsListResponse,
): HTMLElement {
  const list = document.createElement("div");
  list.className = "manage-secret-list";
  list.setAttribute("role", "list");

  // Drop zone for the main list (ungrouped area)
  list.addEventListener("dragover", (e) => {
    // Only handle if the target is the list itself (not a group)
    if ((e.target as HTMLElement).closest(".manage-group")) return;
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
  });

  list.addEventListener("drop", async (e) => {
    if ((e.target as HTMLElement).closest(".manage-group")) return;
    e.preventDefault();

    const type = e.dataTransfer?.getData("application/x-tkr-type");
    const data = e.dataTransfer?.getData("text/plain");

    if (type === "secret" && data) {
      // Find what group this secret is currently in
      const secretEntry = secretsData.secrets.find((s) => s.name === data);
      if (secretEntry?.group) {
        try {
          await api<{ id: string; name: string }>(
            "PATCH",
            `${vaultPath()}/groups/${encodeURIComponent(secretEntry.group)}`,
            { removeSecrets: [data] },
          );
          await refreshContent();
        } catch {
          // Failed to ungroup
        }
      }
    }
  });

  const groupedSecrets = new Set<string>();
  for (const g of groupsData.groups) {
    for (const s of g.secrets) {
      groupedSecrets.add(s);
    }
  }

  // Render groups sorted by order
  const sortedGroups = [...groupsData.groups].sort((a, b) => a.order - b.order);
  for (const group of sortedGroups) {
    list.appendChild(createGroupSection(group, secretsData.secrets));
  }

  // Render ungrouped secrets in order
  const orderedUngrouped = secretsData.secrets
    .filter((s) => !groupedSecrets.has(s.name))
    .map((s) => s.name);

  if (orderedUngrouped.length === 0 && sortedGroups.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = [
      "text-align:center",
      "padding:var(--space-8)",
      "color:var(--color-text-secondary)",
      "font-size:var(--font-size-sm)",
    ].join(";");
    empty.textContent = "No secrets yet. Add your first secret to get started.";
    list.appendChild(empty);
  } else {
    for (const secretName of orderedUngrouped) {
      list.appendChild(createSecretRow(secretName, false));
    }
  }

  return list;
}

// ── Render: Import Section ───────────────────────────────────────────

/**
 * Creates the import section with file picker and preview display.
 *
 * @returns The import section element.
 */
function createImportSection(): HTMLElement {
  const section = document.createElement("div");
  section.style.cssText = "display:flex;flex-direction:column;gap:var(--space-3)";

  const sectionTitle = document.createElement("h3");
  sectionTitle.style.cssText = [
    "font-size:var(--font-size-base)",
    "font-weight:var(--font-weight-semibold)",
    "color:var(--color-text-primary)",
    "margin:0",
  ].join(";");
  sectionTitle.textContent = "Import";
  section.appendChild(sectionTitle);

  const dropZone = document.createElement("div");
  dropZone.style.cssText = [
    "border: 2px dashed var(--color-border-default)",
    "border-radius: var(--radius-md)",
    "padding: var(--space-6) var(--space-4)",
    "text-align: center",
    "cursor: pointer",
    "color: var(--color-text-secondary)",
    "font-size: var(--font-size-sm)",
    "line-height: var(--line-height-normal)",
    "transition: background var(--transition-fast), border-color var(--transition-fast)",
  ].join(";");
  dropZone.textContent = "Drop .env file here or click to browse";
  dropZone.setAttribute("tabindex", "0");
  dropZone.setAttribute("role", "button");
  dropZone.setAttribute("aria-label", "Import .env file");

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.style.display = "none";

  const importError = document.createElement("div");
  importError.className = "form-group__error";
  importError.setAttribute("role", "alert");

  /**
   * Returns true if a filename looks like an env file (.env, .env.local, etc.).
   */
  function isEnvFile(name: string): boolean {
    const base = name.split("/").pop() ?? name;
    return base === ".env" || base.startsWith(".env.");
  }

  /**
   * Processes an uploaded .env file and shows the import preview.
   */
  async function handleImportFile(file: File): Promise<void> {
    importError.textContent = "";

    if (!isEnvFile(file.name)) {
      importError.textContent = "Invalid file. Please select a .env file.";
      return;
    }

    let content: string;
    try {
      content = await file.text();
    } catch {
      importError.textContent = "Failed to read file.";
      return;
    }

    try {
      const preview = await api<ImportPreviewResponse>(
        "POST",
        `${vaultPath()}/import`,
        { content },
      );
      currentImportPreview = preview;
      refreshContent();
    } catch (err: unknown) {
      importError.textContent = err instanceof Error ? err.message : "Import failed";
    }
  }

  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  dropZone.addEventListener("dragover", (e: DragEvent) => {
    e.preventDefault();
    dropZone.style.background = "var(--color-status-info-bg)";
    dropZone.style.borderColor = "var(--color-status-info)";
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.style.background = "";
    dropZone.style.borderColor = "";
  });

  dropZone.addEventListener("drop", (e: DragEvent) => {
    e.preventDefault();
    dropZone.style.background = "";
    dropZone.style.borderColor = "";
    const file = e.dataTransfer?.files[0];
    if (file) {
      handleImportFile(file);
    }
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) {
      handleImportFile(file);
    }
    fileInput.value = "";
  });

  dropZone.appendChild(fileInput);
  section.append(dropZone, importError);

  // Show preview if available
  if (currentImportPreview) {
    const preview = currentImportPreview.preview;
    const previewEl = document.createElement("div");
    previewEl.style.cssText = [
      "display:flex",
      "flex-direction:column",
      "gap:var(--space-2)",
      "padding:var(--space-3)",
      "border:1px solid var(--color-border-default)",
      "border-radius:var(--radius-md)",
      "background:var(--color-bg-surface)",
    ].join(";");

    const addItems = (items: Array<{ name: string }>, label: string, color: string): void => {
      if (items.length === 0) return;
      for (const item of items) {
        const row = document.createElement("div");
        row.style.cssText = `display:flex;align-items:center;gap:var(--space-2);font-size:var(--font-size-sm)`;
        const dot = document.createElement("span");
        dot.style.cssText = `width:8px;height:8px;border-radius:var(--radius-full);background:${color};flex-shrink:0`;
        const nameSpan = document.createElement("span");
        nameSpan.style.fontFamily = "var(--font-family-mono)";
        nameSpan.textContent = item.name;
        const labelSpan = document.createElement("span");
        labelSpan.style.color = "var(--color-text-secondary)";
        labelSpan.textContent = ` (${label})`;
        row.append(dot, nameSpan, labelSpan);
        previewEl.appendChild(row);
      }
    };

    addItems(preview.add, "new", "var(--color-status-success)");
    addItems(preview.update, "update", "var(--color-status-info)");
    addItems(preview.unchanged, "unchanged", "var(--color-text-disabled)");

    // Skipped
    for (const skip of preview.skipped) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:var(--space-2);font-size:var(--font-size-sm)";
      const dot = document.createElement("span");
      dot.style.cssText = "width:8px;height:8px;border-radius:var(--radius-full);background:var(--color-status-warning);flex-shrink:0";
      const text = document.createElement("span");
      text.style.color = "var(--color-status-warning)";
      text.textContent = `Line ${skip.line}: ${skip.reason}`;
      row.append(dot, text);
      previewEl.appendChild(row);
    }

    // Confirm button
    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "btn btn--primary";
    confirmBtn.style.marginTop = "var(--space-2)";
    confirmBtn.textContent = "Confirm Import";
    confirmBtn.addEventListener("click", async () => {
      if (!currentImportPreview) return;
      try {
        await api<ImportConfirmResponse>(
          "POST",
          `${vaultPath()}/import/confirm`,
          { importId: currentImportPreview.importId },
        );
        currentImportPreview = null;
        await refreshContent();
      } catch (err: unknown) {
        const alert = document.createElement("div");
        alert.className = "alert alert--error";
        alert.textContent = err instanceof Error ? err.message : "Import confirmation failed";
        previewEl.appendChild(alert);
      }
    });

    const cancelImportBtn = document.createElement("button");
    cancelImportBtn.type = "button";
    cancelImportBtn.className = "btn btn--secondary";
    cancelImportBtn.style.marginTop = "var(--space-1)";
    cancelImportBtn.textContent = "Cancel";
    cancelImportBtn.addEventListener("click", () => {
      currentImportPreview = null;
      refreshContent();
    });

    previewEl.append(confirmBtn, cancelImportBtn);
    section.appendChild(previewEl);
  }

  return section;
}

// ── Render: Settings Section ─────────────────────────────────────────

/**
 * Creates the settings panel with change password and delete vault.
 *
 * @param status - Current vault status.
 * @param opts - Manage screen options.
 * @returns The settings section element.
 */
function createSettingsSection(status: VaultStatus, opts: ManageScreenOptions): HTMLElement {
  const section = document.createElement("div");
  section.className = "manage-settings";

  const title = document.createElement("h2");
  title.style.cssText = [
    "font-size:var(--font-size-lg)",
    "font-weight:var(--font-weight-semibold)",
    "color:var(--color-text-primary)",
    "margin:0 0 var(--space-4) 0",
  ].join(";");
  title.textContent = "Settings";
  section.appendChild(title);

  // ── Change password ──
  const changePwSection = document.createElement("div");
  changePwSection.style.cssText = "margin-bottom:var(--space-4)";

  const changePwToggle = document.createElement("button");
  changePwToggle.type = "button";
  changePwToggle.className = "btn btn--secondary";
  changePwToggle.style.width = "100%";
  changePwToggle.textContent = "Change Password";

  let changePwOpen = false;
  const changePwForm = document.createElement("div");
  changePwForm.style.cssText = "display:none;flex-direction:column;gap:var(--space-3);margin-top:var(--space-3)";

  changePwToggle.addEventListener("click", () => {
    changePwOpen = !changePwOpen;
    changePwForm.style.display = changePwOpen ? "flex" : "none";
  });

  const createPwInput = (id: string, labelText: string, placeholder: string): { group: HTMLElement; input: HTMLInputElement; error: HTMLElement } => {
    const group = document.createElement("div");
    group.className = "form-group";
    const lbl = document.createElement("label");
    lbl.className = "form-group__label";
    lbl.setAttribute("for", id);
    lbl.textContent = labelText;
    const wrap = document.createElement("div");
    wrap.className = "input-wrapper";
    const inp = document.createElement("input");
    inp.type = "password";
    inp.id = id;
    inp.className = "input";
    inp.placeholder = placeholder;
    inp.autocomplete = "new-password";
    const tog = document.createElement("button");
    tog.type = "button";
    tog.className = "input-wrapper__toggle";
    setIcon(tog, ICON_EYE);
    let vis = false;
    tog.addEventListener("click", () => {
      vis = !vis;
      inp.type = vis ? "text" : "password";
      setIcon(tog, vis ? ICON_EYE_OFF : ICON_EYE, vis ? "Hide password" : "Show password");
    });
    wrap.append(inp, tog);
    const err = document.createElement("div");
    err.className = "form-group__error";
    err.setAttribute("role", "alert");
    group.append(lbl, wrap, err);
    return { group, input: inp, error: err };
  };

  const currentPw = createPwInput("change-current-pw", "Current Password", "Current password");
  const newPw = createPwInput("change-new-pw", "New Password", "New password");
  const confirmPw = createPwInput("change-confirm-pw", "Confirm New Password", "Confirm new password");

  const changePwAlert = document.createElement("div");
  changePwAlert.className = "alert alert--error";
  changePwAlert.style.display = "none";

  const changePwBtn = document.createElement("button");
  changePwBtn.type = "button";
  changePwBtn.className = "btn btn--primary";
  changePwBtn.textContent = "Update Password";
  changePwBtn.disabled = true;

  const validateChangePw = (): void => {
    const cur = currentPw.input.value;
    const np = newPw.input.value;
    const cp = confirmPw.input.value;
    changePwBtn.disabled = cur.length === 0 || np.length === 0 || np !== cp;

    if (cp.length > 0 && np !== cp) {
      confirmPw.error.textContent = "Passwords do not match";
      confirmPw.input.classList.add("input--error");
    } else {
      confirmPw.error.textContent = "";
      confirmPw.input.classList.remove("input--error");
    }
  };

  currentPw.input.addEventListener("input", validateChangePw);
  newPw.input.addEventListener("input", validateChangePw);
  confirmPw.input.addEventListener("input", validateChangePw);

  changePwBtn.addEventListener("click", async () => {
    if (changePwBtn.disabled) return;
    changePwBtn.disabled = true;
    changePwBtn.textContent = "Updating\u2026";
    changePwAlert.style.display = "none";

    try {
      await api<Record<string, never>>("POST", `${vaultPath()}/change-password`, {
        currentPassword: currentPw.input.value,
        newPassword: newPw.input.value,
      });
      currentPw.input.value = "";
      newPw.input.value = "";
      confirmPw.input.value = "";
      changePwOpen = false;
      changePwForm.style.display = "none";
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 400) {
        currentPw.error.textContent = err.message;
        currentPw.input.classList.add("input--error");
      } else {
        changePwAlert.textContent = err instanceof Error ? err.message : "Failed to change password";
        changePwAlert.style.display = "block";
      }
    } finally {
      changePwBtn.textContent = "Update Password";
      validateChangePw();
    }
  });

  changePwForm.append(currentPw.group, newPw.group, confirmPw.group, changePwAlert, changePwBtn);
  changePwSection.append(changePwToggle, changePwForm);
  section.appendChild(changePwSection);

  // ── Import section ──
  section.appendChild(createImportSection());

  // ── Delete vault ──
  const deleteSection = document.createElement("div");
  deleteSection.style.cssText = "margin-top:var(--space-6);padding-top:var(--space-4);border-top:1px solid var(--color-border-default)";

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";

  if (pendingDeleteVault) {
    deleteBtn.className = "btn btn--danger";
    deleteBtn.style.width = "100%";
    deleteBtn.textContent = `Remove ${opts.vaultName} permanently?`;
    deleteBtn.addEventListener("click", async () => {
      try {
        await api<{ name: string }>("DELETE", `/api/vaults/${encodeURIComponent(opts.vaultName)}`);
        opts.onDeleted();
      } catch {
        pendingDeleteVault = false;
        refreshContent();
      }
    });

    // Reset on escape or click away
    const resetDelete = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        pendingDeleteVault = false;
        refreshContent();
        document.removeEventListener("keydown", resetDelete);
      }
    };
    document.addEventListener("keydown", resetDelete);
  } else {
    deleteBtn.className = "btn btn--secondary";
    deleteBtn.style.cssText = "width:100%;color:var(--color-status-error)";
    deleteBtn.textContent = "Delete Vault";
    deleteBtn.addEventListener("click", () => {
      pendingDeleteVault = true;
      refreshContent();
    });
  }

  deleteSection.appendChild(deleteBtn);
  section.appendChild(deleteSection);

  return section;
}

// ── Refresh Content ──────────────────────────────────────────────────

/** Cached status for settings panel. */
let cachedStatus: VaultStatus | null = null;

/**
 * Fetches fresh data and re-renders the content area.
 */
async function refreshContent(): Promise<void> {
  if (!containerRef || !currentOptions) return;

  try {
    const [secretsData, groupsData, status] = await Promise.all([
      api<SecretsListResponse>("GET", `${vaultPath()}/secrets`),
      api<GroupsListResponse>("GET", `${vaultPath()}/groups`),
      api<VaultStatus>("GET", `${vaultPath()}/status`),
    ]);

    if (!status.unlocked) {
      currentOptions.onLocked();
      return;
    }

    cachedStatus = status;
    cachedGroups = groupsData.groups;
    updateProgressBar(status.timeoutRemaining);

    renderManageContent(secretsData, groupsData, status);
  } catch {
    // Refresh failure — keep current content
  }
}

/**
 * Renders all manage screen content below the root container.
 *
 * @param secretsData - Secrets list response.
 * @param groupsData - Groups list response.
 * @param status - Current vault status.
 */
function renderManageContent(
  secretsData: SecretsListResponse,
  groupsData: GroupsListResponse,
  status: VaultStatus,
): void {
  if (!containerRef || !currentOptions) return;

  // Preserve scroll position
  const scrollY = containerRef.scrollTop;

  containerRef.innerHTML = "";

  const wrapper = document.createElement("div");
  wrapper.className = "manage-wrapper";

  // Header
  wrapper.appendChild(createHeader(currentOptions));

  // Two-column layout
  const layout = document.createElement("div");
  layout.className = "manage-layout";

  // Left column: action bar + form + secret list
  const left = document.createElement("div");
  left.className = "manage-main";

  left.appendChild(createActionBar());

  const addForm = createAddSecretForm();
  if (addForm) {
    left.appendChild(addForm);
  }

  left.appendChild(createSecretList(secretsData, groupsData));

  // Right column: settings
  const right = createSettingsSection(status, currentOptions);

  layout.append(left, right);
  wrapper.appendChild(layout);

  containerRef.appendChild(wrapper);
  containerRef.scrollTop = scrollY;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Renders the vault manage screen into the given container.
 *
 * @param container - The DOM element to render into.
 * @param options - Callbacks and configuration for the manage screen.
 */
export function renderManage(container: HTMLElement, options: ManageScreenOptions): void {
  destroyManage();
  containerRef = container;
  currentOptions = options;

  container.innerHTML = "";
  container.style.maxWidth = "";
  container.style.marginInline = "";

  // Reset state
  revealedSecrets = new Map();
  editingSecret = null;
  expandedGroups = new Set();
  addFormOpen = false;
  pendingDeleteSecret = null;
  pendingDeleteVault = false;
  currentImportPreview = null;
  cachedGroups = [];
  cachedStatus = null;
  timeoutRemaining = AUTO_LOCK_TOTAL_MS;

  // Initial load
  refreshContent();

  // Start polling
  pollTimer = setInterval(() => {
    pollStatus();
  }, POLL_INTERVAL_MS);

  // Reset pending delete on escape (for secret rows)
  const handleEscape = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      if (editingSecret) {
        editingSecret = null;
        refreshContent();
      } else if (pendingDeleteSecret) {
        pendingDeleteSecret = null;
        refreshContent();
      }
    }
  };
  document.addEventListener("keydown", handleEscape);
}

/**
 * Cleans up intervals, listeners, and references held by the manage screen.
 */
export function destroyManage(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  containerRef = null;
  currentOptions = null;
  progressBarFill = null;
  revealedSecrets = new Map();
  editingSecret = null;
  expandedGroups = new Set();
  cachedGroups = [];
  cachedStatus = null;
  currentImportPreview = null;
  pendingDeleteSecret = null;
  pendingDeleteVault = false;
}
