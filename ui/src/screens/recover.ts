/**
 * Vault recovery screen.
 *
 * Allows users to reset their vault password using a recovery key
 * provided via mnemonic phrase, QR URI paste, or file upload.
 * After successful recovery, a new recovery key is generated and
 * passed to the caller via the onRecovered callback.
 *
 * @module screens/recover
 */

import { api, ApiError } from "../api.js";

/** Options for rendering the recover screen. */
export interface RecoverScreenOptions {
  /** Name of the vault to recover. */
  vaultName: string;
  /** Called on successful recovery with the new recovery key material. */
  onRecovered: (recoveryKey: { mnemonic: string; raw: string; qr: string }) => void;
  /** Called when the user navigates back. */
  onBack: () => void;
}

/** Response from POST /api/vaults/:name/recover. */
interface RecoverResponse {
  recoveryKey: {
    mnemonic: string;
    raw: string;
    qr: string;
  };
}

/** Active tab identifier. */
type TabId = "phrase" | "qr" | "file";

/** Module-level references for cleanup. */
let containerRef: HTMLElement | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Creates a password input with show/hide eye toggle.
 *
 * @param id - The input element's id attribute.
 * @param labelText - The visible label text.
 * @param placeholder - Placeholder text for the input.
 * @returns An object with the wrapper element, input element, and error element.
 */
function createPasswordField(
  id: string,
  labelText: string,
  placeholder: string,
): { group: HTMLElement; input: HTMLInputElement; error: HTMLElement } {
  const group = document.createElement("div");
  group.className = "form-group";

  const label = document.createElement("label");
  label.className = "form-group__label";
  label.setAttribute("for", id);
  label.textContent = labelText;

  const wrapper = document.createElement("div");
  wrapper.className = "input-wrapper";

  const input = document.createElement("input");
  input.type = "password";
  input.id = id;
  input.className = "input";
  input.placeholder = placeholder;
  input.autocomplete = "new-password";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "input-wrapper__toggle";
  toggle.setAttribute("aria-label", "Toggle password visibility");
  toggle.textContent = "\u{1F441}";

  let visible = false;
  toggle.addEventListener("click", () => {
    visible = !visible;
    input.type = visible ? "text" : "password";
    toggle.textContent = visible ? "\u{1F441}\u{200D}\u{1F5E8}" : "\u{1F441}";
    toggle.setAttribute("aria-label", visible ? "Hide password" : "Show password");
  });

  wrapper.append(input, toggle);

  const error = document.createElement("div");
  error.className = "form-group__error";
  error.setAttribute("role", "alert");

  group.append(label, wrapper, error);
  return { group, input, error };
}

/**
 * Creates a toggle switch element.
 *
 * @param id - Unique identifier for the toggle.
 * @param labelText - Label displayed next to the toggle.
 * @param defaultValue - Initial toggle state.
 * @returns An object with the wrapper element and a getter for the current state.
 */
function createToggle(
  id: string,
  labelText: string,
  defaultValue: boolean,
): { wrapper: HTMLElement; getValue: () => boolean } {
  let active = defaultValue;

  const wrapper = document.createElement("div");
  wrapper.className = `toggle${active ? " toggle--active" : ""}`;
  wrapper.setAttribute("role", "switch");
  wrapper.setAttribute("aria-checked", String(active));
  wrapper.setAttribute("aria-label", labelText);
  wrapper.setAttribute("tabindex", "0");

  const track = document.createElement("div");
  track.className = "toggle__track";

  const thumb = document.createElement("div");
  thumb.className = "toggle__thumb";
  track.appendChild(thumb);

  const label = document.createElement("span");
  label.className = "toggle__label";
  label.textContent = labelText;

  wrapper.append(track, label);

  const doToggle = (): void => {
    active = !active;
    wrapper.classList.toggle("toggle--active", active);
    wrapper.setAttribute("aria-checked", String(active));
  };

  wrapper.addEventListener("click", doToggle);
  wrapper.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      doToggle();
    }
  });

  return { wrapper, getValue: () => active };
}

/**
 * Parses a tkr-secrets:// recovery URI and extracts the hex key.
 *
 * @param uri - The full URI string from a QR code scan.
 * @returns The hex recovery key, or null if parsing fails.
 */
function parseRecoveryUri(uri: string): string | null {
  const trimmed = uri.trim();
  if (!trimmed.startsWith("tkr-secrets://")) {
    return null;
  }

  try {
    // tkr-secrets://recover/{name}?key={hex}
    // URL constructor needs a valid scheme, so replace with https for parsing
    const asUrl = new URL(trimmed.replace("tkr-secrets://", "https://placeholder/"));
    const key = asUrl.searchParams.get("key");
    if (key && /^[0-9a-fA-F]{64}$/.test(key)) {
      return key;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Validates a mnemonic phrase input.
 *
 * @param value - The raw textarea value.
 * @returns An object with validity status and optional error message.
 */
function validatePhrase(value: string): { valid: boolean; error: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: "" };
  }

  const words = trimmed.split(/\s+/);
  if (words.length !== 24) {
    return { valid: false, error: "Please enter all 24 words" };
  }

  // Basic format check: all lowercase alpha words
  for (const word of words) {
    if (!/^[a-z]+$/.test(word)) {
      return { valid: false, error: "Recovery phrase is invalid. Please check for typos." };
    }
  }

  return { valid: true, error: "" };
}

/**
 * Renders the recover screen into the given container.
 *
 * @param container - The DOM element to render into.
 * @param options - Screen configuration including vault name and callbacks.
 */
export function renderRecover(container: HTMLElement, options: RecoverScreenOptions): void {
  destroyRecover();
  containerRef = container;
  container.innerHTML = "";

  // The recovery key value extracted from any method.
  // For phrase: the mnemonic string. For QR/file: the hex string.
  let recoveryKeyValue: string | null = null;
  let keyAccepted = false;
  let activeTab: TabId = "phrase";
  let submitting = false;

  // ── Wrapper ──────────────────────────────────────────────
  const wrapper = document.createElement("div");
  wrapper.style.cssText = [
    "max-width: 640px",
    "margin: 0 auto",
    "padding: var(--space-4)",
    "display: flex",
    "flex-direction: column",
    "gap: var(--space-5)",
  ].join(";");

  // ── Header ───────────────────────────────────────────────
  const header = document.createElement("div");
  header.style.cssText = [
    "display: flex",
    "align-items: center",
    "gap: var(--space-3)",
  ].join(";");

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "btn btn--secondary";
  backBtn.textContent = "\u2190";
  backBtn.setAttribute("aria-label", "Back to unlock screen");
  backBtn.addEventListener("click", () => options.onBack());

  const title = document.createElement("h1");
  title.style.cssText = [
    "font-size: var(--font-size-xl)",
    "font-weight: var(--font-weight-semibold)",
    "color: var(--color-text-primary)",
    "margin: 0",
  ].join(";");
  title.textContent = `Recover '${options.vaultName}'`;

  header.append(backBtn, title);
  wrapper.appendChild(header);

  // ── Recovery Key Status ──────────────────────────────────
  const keyStatus = document.createElement("div");
  keyStatus.style.cssText = [
    "display: none",
    "align-items: center",
    "gap: var(--space-2)",
    "padding: var(--space-3) var(--space-4)",
    "background: var(--color-status-success-bg)",
    "color: var(--color-status-success)",
    "border-radius: var(--radius-md)",
    "font-weight: var(--font-weight-medium)",
    "font-size: var(--font-size-sm)",
  ].join(";");
  keyStatus.textContent = "\u2713 Recovery key accepted";
  wrapper.appendChild(keyStatus);

  // ── Method Tabs ──────────────────────────────────────────
  const tabsContainer = document.createElement("div");
  tabsContainer.style.cssText = [
    "display: flex",
    "flex-direction: column",
    "gap: var(--space-4)",
  ].join(";");

  const tabBar = document.createElement("div");
  tabBar.setAttribute("role", "tablist");
  tabBar.style.cssText = [
    "display: flex",
    "gap: var(--space-2)",
  ].join(";");

  const tabs: Record<TabId, HTMLButtonElement> = {} as Record<TabId, HTMLButtonElement>;
  const tabPanels: Record<TabId, HTMLElement> = {} as Record<TabId, HTMLElement>;

  const tabDefs: { id: TabId; label: string }[] = [
    { id: "phrase", label: "Enter Phrase" },
    { id: "qr", label: "Scan QR" },
    { id: "file", label: "Upload File" },
  ];

  /**
   * Updates visual state of tab buttons and panels to reflect active tab.
   */
  function updateTabs(): void {
    for (const def of tabDefs) {
      const btn = tabs[def.id];
      const panel = tabPanels[def.id];
      const isActive = def.id === activeTab;

      btn.style.background = isActive ? "var(--color-status-info)" : "var(--color-bg-surface)";
      btn.style.color = isActive ? "var(--color-text-inverse)" : "var(--color-text-primary)";
      btn.style.borderColor = isActive ? "var(--color-status-info)" : "var(--color-border-default)";
      btn.setAttribute("aria-selected", String(isActive));
      btn.setAttribute("tabindex", isActive ? "0" : "-1");

      panel.style.display = isActive ? "block" : "none";
      panel.hidden = !isActive;
    }
  }

  for (const def of tabDefs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-controls", `recover-panel-${def.id}`);
    btn.id = `recover-tab-${def.id}`;
    btn.style.cssText = [
      "flex: 1",
      "padding: var(--space-2) var(--space-3)",
      "border: 1px solid var(--color-border-default)",
      "border-radius: var(--radius-full)",
      "font-size: var(--font-size-sm)",
      "font-weight: var(--font-weight-medium)",
      "cursor: pointer",
      "transition: background var(--transition-fast), color var(--transition-fast)",
    ].join(";");
    btn.textContent = def.label;

    btn.addEventListener("click", () => {
      activeTab = def.id;
      updateTabs();
    });

    tabs[def.id] = btn;
    tabBar.appendChild(btn);
  }

  tabsContainer.appendChild(tabBar);

  // ── Tab Panels ───────────────────────────────────────────

  // -- Phrase Panel --
  const phrasePanel = document.createElement("div");
  phrasePanel.id = "recover-panel-phrase";
  phrasePanel.setAttribute("role", "tabpanel");
  phrasePanel.setAttribute("aria-labelledby", "recover-tab-phrase");

  const phraseTextarea = document.createElement("textarea");
  phraseTextarea.className = "input";
  phraseTextarea.rows = 4;
  phraseTextarea.placeholder = "Enter your 24-word recovery phrase...";
  phraseTextarea.style.cssText = [
    "font-family: var(--font-family-mono)",
    "resize: vertical",
    "width: 100%",
    "box-sizing: border-box",
  ].join(";");

  const phraseError = document.createElement("div");
  phraseError.className = "form-group__error";
  phraseError.setAttribute("role", "alert");

  const phraseSuccess = document.createElement("div");
  phraseSuccess.style.cssText = [
    "display: none",
    "font-size: var(--font-size-sm)",
    "color: var(--color-status-success)",
    "font-weight: var(--font-weight-medium)",
  ].join(";");
  phraseSuccess.textContent = "\u2713 Valid recovery phrase";

  /**
   * Handles phrase validation with debounce on input, immediate on blur.
   */
  function handlePhraseValidation(): void {
    const result = validatePhrase(phraseTextarea.value);
    phraseError.textContent = result.error;
    phraseTextarea.classList.toggle("input--error", result.error.length > 0);

    if (result.valid) {
      phraseTextarea.style.borderColor = "var(--color-status-success)";
      phraseSuccess.style.display = "block";
      phraseError.textContent = "";
      acceptKey(phraseTextarea.value.trim().split(/\s+/).join(" "));
    } else {
      phraseTextarea.style.borderColor = "";
      phraseSuccess.style.display = "none";
    }
  }

  phraseTextarea.addEventListener("input", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(handlePhraseValidation, 500);
  });

  phraseTextarea.addEventListener("blur", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    handlePhraseValidation();
  });

  phrasePanel.append(phraseTextarea, phraseError, phraseSuccess);
  tabPanels["phrase"] = phrasePanel;
  tabsContainer.appendChild(phrasePanel);

  // -- QR Panel --
  const qrPanel = document.createElement("div");
  qrPanel.id = "recover-panel-qr";
  qrPanel.setAttribute("role", "tabpanel");
  qrPanel.setAttribute("aria-labelledby", "recover-tab-qr");

  const qrNote = document.createElement("p");
  qrNote.style.cssText = [
    "font-size: var(--font-size-sm)",
    "color: var(--color-text-secondary)",
    "margin: 0 0 var(--space-3) 0",
    "line-height: var(--line-height-normal)",
  ].join(";");
  qrNote.textContent =
    "Camera QR scanning requires a secure context. Use your device\u2019s QR scanner app and paste the recovery URI below.";

  const qrInput = document.createElement("input");
  qrInput.type = "text";
  qrInput.className = "input";
  qrInput.placeholder = "tkr-secrets://recover/...?key=...";
  qrInput.autocomplete = "off";
  qrInput.spellcheck = false;
  qrInput.style.fontFamily = "var(--font-family-mono)";

  const qrError = document.createElement("div");
  qrError.className = "form-group__error";
  qrError.setAttribute("role", "alert");

  const qrSuccess = document.createElement("div");
  qrSuccess.style.cssText = [
    "display: none",
    "font-size: var(--font-size-sm)",
    "color: var(--color-status-success)",
    "font-weight: var(--font-weight-medium)",
  ].join(";");
  qrSuccess.textContent = "\u2713 Recovery key extracted from URI";

  function handleQrInput(): void {
    const value = qrInput.value.trim();
    if (value.length === 0) {
      qrError.textContent = "";
      qrSuccess.style.display = "none";
      qrInput.classList.remove("input--error");
      return;
    }

    const key = parseRecoveryUri(value);
    if (key) {
      qrError.textContent = "";
      qrInput.classList.remove("input--error");
      qrInput.style.borderColor = "var(--color-status-success)";
      qrSuccess.style.display = "block";
      acceptKey(key);
    } else {
      qrError.textContent = "Invalid recovery URI. Expected format: tkr-secrets://recover/{name}?key={hex}";
      qrInput.classList.add("input--error");
      qrInput.style.borderColor = "";
      qrSuccess.style.display = "none";
    }
  }

  qrInput.addEventListener("input", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(handleQrInput, 300);
  });

  qrInput.addEventListener("blur", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    handleQrInput();
  });

  qrPanel.append(qrNote, qrInput, qrError, qrSuccess);
  tabPanels["qr"] = qrPanel;
  tabsContainer.appendChild(qrPanel);

  // -- File Panel --
  const filePanel = document.createElement("div");
  filePanel.id = "recover-panel-file";
  filePanel.setAttribute("role", "tabpanel");
  filePanel.setAttribute("aria-labelledby", "recover-tab-file");

  const dropZone = document.createElement("div");
  dropZone.style.cssText = [
    "border: 2px dashed var(--color-border-default)",
    "border-radius: var(--radius-md)",
    "padding: var(--space-8) var(--space-4)",
    "text-align: center",
    "cursor: pointer",
    "color: var(--color-text-secondary)",
    "font-size: var(--font-size-sm)",
    "line-height: var(--line-height-normal)",
    "transition: background var(--transition-fast), border-color var(--transition-fast)",
  ].join(";");
  dropZone.textContent = "Drop .tkr-recovery file here or click to browse";
  dropZone.setAttribute("tabindex", "0");
  dropZone.setAttribute("role", "button");
  dropZone.setAttribute("aria-label", "Upload recovery file");

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".tkr-recovery";
  fileInput.style.display = "none";

  const fileError = document.createElement("div");
  fileError.className = "form-group__error";
  fileError.setAttribute("role", "alert");

  const fileWarning = document.createElement("div");
  fileWarning.style.cssText = [
    "display: none",
    "font-size: var(--font-size-sm)",
    "color: var(--color-status-warning)",
    "background: var(--color-status-warning-bg)",
    "padding: var(--space-2) var(--space-3)",
    "border-radius: var(--radius-md)",
  ].join(";");

  const fileSuccess = document.createElement("div");
  fileSuccess.style.cssText = [
    "display: none",
    "font-size: var(--font-size-sm)",
    "color: var(--color-status-success)",
    "font-weight: var(--font-weight-medium)",
  ].join(";");
  fileSuccess.textContent = "\u2713 Recovery key extracted from file";

  /**
   * Processes a recovery file and extracts the key.
   *
   * @param file - The uploaded File object.
   */
  async function handleFile(file: File): Promise<void> {
    fileError.textContent = "";
    fileWarning.style.display = "none";
    fileSuccess.style.display = "none";

    if (!file.name.endsWith(".tkr-recovery")) {
      fileError.textContent = "Invalid file format. Please upload a .tkr-recovery file.";
      return;
    }

    let text: string;
    try {
      text = await file.text();
    } catch {
      fileError.textContent = "Failed to read file.";
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      fileError.textContent = "Invalid file format. Please upload a .tkr-recovery file.";
      return;
    }

    if (typeof parsed.recoveryKey !== "string" || !/^[0-9a-fA-F]{64}$/.test(parsed.recoveryKey)) {
      fileError.textContent = "Invalid file format. Please upload a .tkr-recovery file.";
      return;
    }

    if (typeof parsed.vault === "string" && parsed.vault !== options.vaultName) {
      fileWarning.textContent = `This recovery file is for vault '${parsed.vault}'. Continue anyway?`;
      fileWarning.style.display = "block";
    }

    fileSuccess.style.display = "block";
    dropZone.textContent = `\u2713 ${file.name}`;
    acceptKey(parsed.recoveryKey);
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
      handleFile(file);
    }
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) {
      handleFile(file);
    }
    // Reset so the same file can be re-selected
    fileInput.value = "";
  });

  filePanel.append(dropZone, fileInput, fileError, fileWarning, fileSuccess);
  tabPanels["file"] = filePanel;
  tabsContainer.appendChild(filePanel);

  wrapper.appendChild(tabsContainer);

  // ── Password Section (hidden until key accepted) ─────────
  const passwordSection = document.createElement("div");
  passwordSection.style.cssText = [
    "display: none",
    "flex-direction: column",
    "gap: var(--space-4)",
  ].join(";");

  const newPassword = createPasswordField(
    "recover-new-password",
    "New Password",
    "Enter new password",
  );
  const confirmPassword = createPasswordField(
    "recover-confirm-password",
    "Confirm Password",
    "Confirm new password",
  );

  const remember = createToggle("recover-remember", "Remember password on this device", false);

  // Info note
  const infoNote = document.createElement("div");
  infoNote.style.cssText = [
    "background: var(--color-status-info-bg)",
    "color: var(--color-status-info)",
    "padding: var(--space-3) var(--space-4)",
    "border-radius: var(--radius-md)",
    "font-size: var(--font-size-sm)",
    "line-height: var(--line-height-normal)",
  ].join(";");
  infoNote.textContent = "A new recovery key will be generated after reset.";

  passwordSection.append(
    newPassword.group,
    confirmPassword.group,
    remember.wrapper,
    infoNote,
  );

  wrapper.appendChild(passwordSection);

  // ── Network error alert ──────────────────────────────────
  const networkAlert = document.createElement("div");
  networkAlert.className = "alert alert--error";
  networkAlert.setAttribute("role", "alert");
  networkAlert.style.display = "none";
  wrapper.appendChild(networkAlert);

  // ── Submit Button ────────────────────────────────────────
  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "btn btn--primary";
  submitBtn.disabled = true;
  submitBtn.textContent = "Reset Password";
  submitBtn.style.display = "none";
  wrapper.appendChild(submitBtn);

  container.appendChild(wrapper);

  // ── Initialize tabs ──────────────────────────────────────
  updateTabs();

  // ── Validation ───────────────────────────────────────────

  /**
   * Checks whether the submit button should be enabled based on current state.
   */
  function validateForm(): void {
    if (!keyAccepted) {
      submitBtn.disabled = true;
      return;
    }

    const pw = newPassword.input.value;
    const cf = confirmPassword.input.value;
    const passwordsValid = pw.length > 0 && pw === cf;
    submitBtn.disabled = !passwordsValid;
  }

  newPassword.input.addEventListener("input", () => {
    validateForm();
    if (
      confirmPassword.input.value.length > 0 &&
      confirmPassword.input.value === newPassword.input.value
    ) {
      confirmPassword.error.textContent = "";
      confirmPassword.input.classList.remove("input--error");
    }
  });

  confirmPassword.input.addEventListener("input", validateForm);

  confirmPassword.input.addEventListener("blur", () => {
    if (
      confirmPassword.input.value.length > 0 &&
      confirmPassword.input.value !== newPassword.input.value
    ) {
      confirmPassword.error.textContent = "Passwords do not match";
      confirmPassword.input.classList.add("input--error");
    } else {
      confirmPassword.error.textContent = "";
      confirmPassword.input.classList.remove("input--error");
    }
  });

  // ── Key Acceptance ───────────────────────────────────────

  /**
   * Called when any method provides a valid recovery key.
   * Collapses the method tabs and shows the password fields.
   *
   * @param key - The recovery key value (mnemonic string or hex string).
   */
  function acceptKey(key: string): void {
    recoveryKeyValue = key;
    keyAccepted = true;

    // Show key status
    keyStatus.style.display = "flex";

    // Collapse tabs
    tabsContainer.style.display = "none";

    // Show password section
    passwordSection.style.display = "flex";
    submitBtn.style.display = "";

    validateForm();
    newPassword.input.focus();
  }

  /**
   * Resets the key acceptance state, re-expands tabs, and hides password fields.
   */
  function resetKeyState(): void {
    recoveryKeyValue = null;
    keyAccepted = false;

    keyStatus.style.display = "none";
    tabsContainer.style.display = "flex";
    passwordSection.style.display = "none";
    submitBtn.style.display = "none";

    // Clear password fields
    newPassword.input.value = "";
    confirmPassword.input.value = "";
    newPassword.error.textContent = "";
    confirmPassword.error.textContent = "";
    newPassword.input.classList.remove("input--error");
    confirmPassword.input.classList.remove("input--error");

    // Clear all method inputs
    phraseTextarea.value = "";
    phraseError.textContent = "";
    phraseSuccess.style.display = "none";
    phraseTextarea.style.borderColor = "";
    phraseTextarea.classList.remove("input--error");

    qrInput.value = "";
    qrError.textContent = "";
    qrSuccess.style.display = "none";
    qrInput.style.borderColor = "";
    qrInput.classList.remove("input--error");

    fileError.textContent = "";
    fileWarning.style.display = "none";
    fileSuccess.style.display = "none";
    dropZone.textContent = "Drop .tkr-recovery file here or click to browse";

    validateForm();
  }

  // ── Submit ───────────────────────────────────────────────

  const handleSubmit = async (): Promise<void> => {
    if (submitBtn.disabled || submitting || !recoveryKeyValue) return;
    submitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "Resetting\u2026";
    networkAlert.style.display = "none";

    try {
      const result = await api<RecoverResponse>(
        "POST",
        `/api/vaults/${encodeURIComponent(options.vaultName)}/recover`,
        {
          recoveryKey: recoveryKeyValue,
          newPassword: newPassword.input.value,
          remember: remember.getValue(),
        },
      );

      options.onRecovered(result.recoveryKey);
    } catch (err: unknown) {
      submitting = false;
      submitBtn.textContent = "Reset Password";

      if (err instanceof ApiError) {
        if (err.status === 400) {
          // Invalid recovery key — reset key state
          networkAlert.textContent = "Recovery key is invalid.";
          networkAlert.style.display = "block";
          resetKeyState();
          return;
        }
      }

      networkAlert.textContent =
        err instanceof Error ? err.message : "An unexpected error occurred";
      networkAlert.style.display = "block";
      validateForm();
    } finally {
      if (submitting) {
        submitting = false;
        submitBtn.textContent = "Reset Password";
        validateForm();
      }
    }
  };

  submitBtn.addEventListener("click", handleSubmit);

  // Enter key submits from password fields
  const handleKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Enter") {
      handleSubmit();
    }
  };
  newPassword.input.addEventListener("keydown", handleKeydown);
  confirmPassword.input.addEventListener("keydown", handleKeydown);
}

/**
 * Destroys the recover screen and cleans up references.
 */
export function destroyRecover(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  containerRef = null;
}
