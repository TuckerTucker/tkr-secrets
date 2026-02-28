/**
 * Recovery key presentation screen.
 *
 * Displayed after vault creation or password recovery. Presents the recovery
 * key via QR code, mnemonic phrase, and downloadable file. The user must
 * acknowledge saving the key before proceeding.
 *
 * Recovery key material is passed in-memory and never appears in URLs or
 * browser history. All references are nulled on continue or destroy.
 *
 * @module screens/recovery-key
 */

/**
 * Options passed to the recovery key screen from the calling context.
 */
export interface RecoveryKeyScreenOptions {
  /** Name of the vault the recovery key belongs to. */
  vaultName: string;
  /** Recovery key material generated at vault creation or recovery. */
  recoveryKey: { mnemonic: string; raw: string; qr: string };
  /** Called when the user confirms and continues (navigates to manage screen). */
  onContinue: () => void;
}

/** Mutable reference to recovery key data, nulled on cleanup. */
let keyMaterial: { mnemonic: string; raw: string; qr: string } | null = null;

/** Reference to the beforeunload handler for removal. */
let beforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;

/** Reference to the root DOM element for this screen. */
let rootElement: HTMLElement | null = null;

/** Stored onContinue callback. */
let continueCallback: (() => void) | null = null;

/**
 * Clears all recovery key material from memory and removes event listeners.
 */
function clearMemory(): void {
  if (keyMaterial) {
    keyMaterial.mnemonic = "";
    keyMaterial.raw = "";
    keyMaterial.qr = "";
    keyMaterial = null;
  }

  if (beforeUnloadHandler) {
    window.removeEventListener("beforeunload", beforeUnloadHandler);
    beforeUnloadHandler = null;
  }

  continueCallback = null;
}

/**
 * Creates the warning banner element.
 *
 * @returns The warning banner DOM element.
 */
function createWarningBanner(): HTMLElement {
  const banner = document.createElement("div");
  banner.setAttribute("role", "alert");
  banner.setAttribute("tabindex", "-1");
  banner.style.cssText = [
    "background: var(--color-status-warning-bg)",
    "color: var(--color-status-warning)",
    "padding: var(--space-4)",
    "border-radius: var(--radius-md)",
    "font-weight: var(--font-weight-semibold)",
    "line-height: var(--line-height-normal)",
    "text-align: center",
  ].join(";");
  banner.textContent =
    "Save this recovery key now. It will not be shown again.";
  return banner;
}

/**
 * Creates the header with shield icon and step indicator.
 *
 * @returns The header DOM element.
 */
function createHeader(): HTMLElement {
  const header = document.createElement("div");
  header.style.cssText = [
    "display: flex",
    "justify-content: space-between",
    "align-items: center",
    "padding: var(--space-4) 0",
  ].join(";");

  const left = document.createElement("div");
  left.style.cssText = [
    "display: flex",
    "align-items: center",
    "gap: var(--space-2)",
    "font-size: var(--font-size-xl)",
    "font-weight: var(--font-weight-semibold)",
    "color: var(--color-text-primary)",
  ].join(";");

  const shield = document.createElement("span");
  shield.setAttribute("aria-hidden", "true");
  shield.textContent = "\u{1F6E1}\uFE0F";
  left.appendChild(shield);

  const title = document.createElement("span");
  title.textContent = "Save Recovery Key";
  left.appendChild(title);

  const step = document.createElement("span");
  step.style.cssText = [
    "font-size: var(--font-size-sm)",
    "color: var(--color-text-secondary)",
    "white-space: nowrap",
  ].join(";");
  step.textContent = "Step 2 of 2";

  header.appendChild(left);
  header.appendChild(step);
  return header;
}

/**
 * Creates the QR code display section.
 *
 * @param qrBase64 - Base64-encoded PNG of the QR code.
 * @param vaultName - Name of the vault, displayed as a label.
 * @returns The QR code container DOM element.
 */
function createQrSection(qrBase64: string, vaultName: string): HTMLElement {
  const container = document.createElement("div");
  container.style.cssText = [
    "display: flex",
    "flex-direction: column",
    "align-items: center",
    "gap: var(--space-2)",
  ].join(";");

  const imgWrapper = document.createElement("div");
  imgWrapper.style.cssText = [
    "background: #FFFFFF",
    "border: 1px solid var(--color-border-default)",
    "border-radius: var(--radius-md)",
    "padding: var(--space-4)",
    "display: inline-block",
  ].join(";");

  const img = document.createElement("img");
  img.src = qrBase64.startsWith("data:")
    ? qrBase64
    : `data:image/png;base64,${qrBase64}`;
  img.alt = `Recovery QR code for ${vaultName}`;
  img.width = 300;
  img.height = 300;
  img.style.cssText = "display: block";
  imgWrapper.appendChild(img);

  const label = document.createElement("span");
  label.style.cssText = [
    "font-size: var(--font-size-sm)",
    "color: var(--color-text-secondary)",
  ].join(";");
  label.textContent = vaultName;

  container.appendChild(imgWrapper);
  container.appendChild(label);
  return container;
}

/**
 * Creates the 24-word mnemonic grid with a copy button.
 *
 * @param mnemonic - Space-separated 24-word mnemonic phrase.
 * @returns The mnemonic grid container DOM element.
 */
function createMnemonicGrid(mnemonic: string): HTMLElement {
  const words = mnemonic.trim().split(/\s+/);

  const container = document.createElement("div");
  container.style.cssText = [
    "display: flex",
    "flex-direction: column",
    "gap: var(--space-3)",
  ].join(";");

  const grid = document.createElement("ol");
  grid.style.cssText = [
    "display: grid",
    "grid-template-columns: repeat(2, 1fr)",
    "gap: var(--space-2)",
    "list-style: none",
    "margin: 0",
    "padding: 0",
    "background: var(--color-bg-surface)",
    "border: 1px solid var(--color-border-default)",
    "border-radius: var(--radius-md)",
    "padding: var(--space-3)",
  ].join(";");

  for (let i = 0; i < words.length; i++) {
    const item = document.createElement("li");
    item.style.cssText = [
      "display: flex",
      "align-items: center",
      "gap: var(--space-2)",
      "padding: var(--space-1) var(--space-2)",
    ].join(";");

    const num = document.createElement("span");
    num.style.cssText = [
      "color: var(--color-text-secondary)",
      "font-size: var(--font-size-sm)",
      "min-width: 24px",
      "text-align: right",
    ].join(";");
    num.textContent = `${i + 1}.`;

    const word = document.createElement("span");
    word.style.cssText = [
      "color: var(--color-text-primary)",
      "font-family: var(--font-family-mono)",
      "font-size: var(--font-size-base)",
    ].join(";");
    word.textContent = words[i];

    item.appendChild(num);
    item.appendChild(word);
    grid.appendChild(item);
  }

  // Responsive: 4 columns on desktop
  const mediaQuery = window.matchMedia("(min-width: 640px)");
  const applyColumns = (matches: boolean): void => {
    grid.style.gridTemplateColumns = matches
      ? "repeat(4, 1fr)"
      : "repeat(2, 1fr)";
  };
  applyColumns(mediaQuery.matches);
  mediaQuery.addEventListener("change", (e) => applyColumns(e.matches));

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.style.cssText = [
    "align-self: center",
    "background: none",
    "border: 1px solid var(--color-status-info)",
    "color: var(--color-status-info)",
    "padding: var(--space-2) var(--space-4)",
    "border-radius: var(--radius-md)",
    "cursor: pointer",
    "font-size: var(--font-size-sm)",
    "font-weight: var(--font-weight-medium)",
    "transition: background var(--transition-fast)",
  ].join(";");
  copyBtn.textContent = "Copy Mnemonic";
  copyBtn.addEventListener("click", () => {
    if (!keyMaterial) return;
    navigator.clipboard.writeText(keyMaterial.mnemonic).then(() => {
      const original = copyBtn.textContent;
      copyBtn.textContent = "Copied";
      setTimeout(() => {
        copyBtn.textContent = original;
      }, 2000);
    });
  });

  container.appendChild(grid);
  container.appendChild(copyBtn);
  return container;
}

/**
 * Creates the download recovery file button.
 *
 * @param vaultName - Name of the vault, used in filename.
 * @returns The download button DOM element.
 */
function createDownloadButton(vaultName: string): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.style.cssText = [
    "width: 100%",
    "background: var(--color-bg-surface)",
    "border: 1px solid var(--color-border-default)",
    "color: var(--color-text-primary)",
    "padding: var(--space-3) var(--space-4)",
    "border-radius: var(--radius-md)",
    "cursor: pointer",
    "font-size: var(--font-size-base)",
    "font-weight: var(--font-weight-medium)",
    "transition: background var(--transition-fast)",
  ].join(";");
  btn.textContent = "Download Recovery File";

  btn.addEventListener("click", () => {
    if (!keyMaterial) return;

    const recoveryFile = {
      vault: vaultName,
      recoveryKey: keyMaterial.raw,
      mnemonic: keyMaterial.mnemonic,
      createdAt: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(recoveryFile, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${vaultName}.tkr-recovery`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  return btn;
}

/**
 * Creates the confirmation checkbox and continue button.
 *
 * @param onContinue - Callback invoked when the user confirms and continues.
 * @returns The confirmation section DOM element.
 */
function createConfirmation(onContinue: () => void): HTMLElement {
  const container = document.createElement("div");
  container.style.cssText = [
    "display: flex",
    "flex-direction: column",
    "gap: var(--space-4)",
  ].join(";");

  const checkboxRow = document.createElement("label");
  checkboxRow.style.cssText = [
    "display: flex",
    "align-items: flex-start",
    "gap: var(--space-3)",
    "cursor: pointer",
    "color: var(--color-text-primary)",
    "line-height: var(--line-height-normal)",
    "font-size: var(--font-size-base)",
  ].join(";");

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.style.cssText = [
    "margin-top: 3px",
    "flex-shrink: 0",
    "width: 18px",
    "height: 18px",
    "cursor: pointer",
  ].join(";");

  const labelText = document.createElement("span");
  labelText.textContent =
    "I've saved my recovery key in at least one of the methods above.";

  checkboxRow.appendChild(checkbox);
  checkboxRow.appendChild(labelText);

  const continueBtn = document.createElement("button");
  continueBtn.type = "button";
  continueBtn.disabled = true;
  continueBtn.style.cssText = [
    "width: 100%",
    "padding: var(--space-3) var(--space-4)",
    "border-radius: var(--radius-md)",
    "border: none",
    "font-size: var(--font-size-base)",
    "font-weight: var(--font-weight-semibold)",
    "cursor: not-allowed",
    "transition: background var(--transition-fast), color var(--transition-fast)",
  ].join(";");
  continueBtn.textContent = "Continue to Vault";

  const updateButtonState = (): void => {
    if (checkbox.checked) {
      continueBtn.disabled = false;
      continueBtn.style.background = "var(--color-status-success)";
      continueBtn.style.color = "var(--color-text-inverse)";
      continueBtn.style.cursor = "pointer";
    } else {
      continueBtn.disabled = true;
      continueBtn.style.background = "var(--color-bg-surface-active)";
      continueBtn.style.color = "var(--color-text-disabled)";
      continueBtn.style.cursor = "not-allowed";
    }
  };

  updateButtonState();

  checkbox.addEventListener("change", () => {
    updateButtonState();

    // Toggle beforeunload guard based on checkbox state
    if (checkbox.checked && beforeUnloadHandler) {
      window.removeEventListener("beforeunload", beforeUnloadHandler);
      beforeUnloadHandler = null;
    } else if (!checkbox.checked && !beforeUnloadHandler) {
      beforeUnloadHandler = (e: BeforeUnloadEvent) => {
        e.preventDefault();
      };
      window.addEventListener("beforeunload", beforeUnloadHandler);
    }
  });

  continueBtn.addEventListener("click", () => {
    if (continueBtn.disabled) return;
    clearMemory();
    onContinue();
  });

  container.appendChild(checkboxRow);
  container.appendChild(continueBtn);
  return container;
}

/**
 * Renders the recovery key screen into the given container.
 *
 * Displays the QR code, mnemonic phrase, download option, and confirmation
 * checkbox. Installs a beforeunload guard until the user confirms saving
 * the key. Clears all key material from memory on continue or destroy.
 *
 * If called without valid recovery key data, invokes onContinue immediately
 * to redirect away from this screen.
 *
 * @param container - The DOM element to render into.
 * @param options - Screen configuration including vault name, key material,
 *   and continue callback.
 */
export function renderRecoveryKey(
  container: HTMLElement,
  options: RecoveryKeyScreenOptions,
): void {
  // Guard: redirect if no recovery key data
  if (
    !options.recoveryKey ||
    !options.recoveryKey.mnemonic ||
    !options.recoveryKey.raw ||
    !options.recoveryKey.qr
  ) {
    options.onContinue();
    return;
  }

  // Clean up any previous instance
  destroyRecoveryKey();

  // Store mutable references
  keyMaterial = {
    mnemonic: options.recoveryKey.mnemonic,
    raw: options.recoveryKey.raw,
    qr: options.recoveryKey.qr,
  };
  continueCallback = options.onContinue;

  // Install beforeunload guard
  beforeUnloadHandler = (e: BeforeUnloadEvent) => {
    e.preventDefault();
  };
  window.addEventListener("beforeunload", beforeUnloadHandler);

  // Build layout
  const wrapper = document.createElement("div");
  wrapper.style.cssText = [
    "max-width: 640px",
    "margin: 0 auto",
    "padding: var(--space-4)",
    "display: flex",
    "flex-direction: column",
    "gap: var(--space-6)",
  ].join(";");

  wrapper.appendChild(createHeader());
  wrapper.appendChild(createWarningBanner());
  wrapper.appendChild(createQrSection(keyMaterial.qr, options.vaultName));
  wrapper.appendChild(createMnemonicGrid(keyMaterial.mnemonic));
  wrapper.appendChild(createDownloadButton(options.vaultName));
  wrapper.appendChild(createConfirmation(options.onContinue));

  container.textContent = "";
  container.appendChild(wrapper);
  rootElement = wrapper;

  // Focus warning banner for screen reader announcement
  const banner = wrapper.querySelector("[role='alert']") as HTMLElement | null;
  if (banner) {
    banner.focus();
  }
}

/**
 * Destroys the recovery key screen and clears all key material from memory.
 *
 * Removes the beforeunload guard and nulls all string references to the
 * recovery key so they can be garbage collected.
 */
export function destroyRecoveryKey(): void {
  clearMemory();

  if (rootElement && rootElement.parentElement) {
    rootElement.parentElement.removeChild(rootElement);
  }
  rootElement = null;
}
