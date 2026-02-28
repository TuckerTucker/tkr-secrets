/**
 * Vault unlock screen.
 *
 * Presents a password entry form to unlock a locked vault. Supports
 * remember-password toggle, forgot-password link, and auto-focus.
 *
 * @module screens/unlock
 */

import { api, ApiError } from "../api.js";

/** Status response shape from GET /api/vaults/:name/status. */
interface VaultStatus {
  name: string;
  fileExists: boolean;
  unlocked: boolean;
  remembered: boolean;
  timeoutRemaining: number;
}

/** Callbacks and configuration for the unlock screen. */
export interface UnlockScreenOptions {
  /** Name of the vault to unlock. */
  vaultName: string;
  /** Called after a successful unlock. */
  onUnlocked: () => void;
  /** Called when the user clicks "Forgot password?". */
  onForgotPassword: () => void;
  /** Called when the user clicks the back arrow. */
  onBack: () => void;
}

let containerRef: HTMLElement | null = null;
let currentOptions: UnlockScreenOptions | null = null;

/**
 * Creates a password input with show/hide eye toggle.
 *
 * @param id - The input element's id attribute.
 * @param placeholder - Placeholder text for the input.
 * @returns An object with the wrapper element and input element.
 */
function createPasswordField(
  id: string,
  placeholder: string,
): { wrapper: HTMLElement; input: HTMLInputElement } {
  const wrapper = document.createElement("div");
  wrapper.className = "input-wrapper";

  const input = document.createElement("input");
  input.type = "password";
  input.id = id;
  input.className = "input";
  input.placeholder = placeholder;
  input.autocomplete = "current-password";

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
  return { wrapper, input };
}

/**
 * Creates a toggle switch element.
 *
 * @param id - Unique identifier for the toggle.
 * @param labelText - Label displayed next to the toggle.
 * @param defaultValue - Initial toggle state.
 * @returns An object with the wrapper element and a getter/setter for the current state.
 */
function createToggle(
  id: string,
  labelText: string,
  defaultValue: boolean,
): { wrapper: HTMLElement; getValue: () => boolean; setValue: (v: boolean) => void } {
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

  const setActive = (val: boolean): void => {
    active = val;
    wrapper.classList.toggle("toggle--active", active);
    wrapper.setAttribute("aria-checked", String(active));
  };

  const toggle = (): void => {
    setActive(!active);
  };

  wrapper.addEventListener("click", toggle);
  wrapper.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });

  return { wrapper, getValue: () => active, setValue: setActive };
}

/**
 * Renders the vault unlock screen into the given container.
 *
 * @param container - The DOM element to render into.
 * @param options - Callbacks and configuration for the unlock screen.
 */
export function renderUnlock(container: HTMLElement, options: UnlockScreenOptions): void {
  destroyUnlock();
  containerRef = container;
  currentOptions = options;

  container.innerHTML = "";

  const form = document.createElement("div");
  form.className = "init-form";

  // Back button
  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "btn btn--secondary";
  backBtn.style.alignSelf = "flex-start";
  backBtn.textContent = "\u2190 Back";
  backBtn.setAttribute("aria-label", "Back to vault picker");
  backBtn.addEventListener("click", () => {
    options.onBack();
  });
  form.appendChild(backBtn);

  // Lock icon
  const icon = document.createElement("div");
  icon.style.fontSize = "var(--font-size-2xl)";
  icon.style.textAlign = "center";
  icon.textContent = "\u{1F512}";
  icon.setAttribute("aria-hidden", "true");

  // Title
  const title = document.createElement("h1");
  title.style.fontSize = "var(--font-size-xl)";
  title.style.fontWeight = "var(--font-weight-semibold)";
  title.style.color = "var(--color-text-primary)";
  title.style.textAlign = "center";
  title.textContent = options.vaultName;

  form.append(icon, title);

  // Password field
  const passwordGroup = document.createElement("div");
  passwordGroup.className = "form-group";

  const passwordLabel = document.createElement("label");
  passwordLabel.className = "form-group__label";
  passwordLabel.setAttribute("for", "unlock-password");
  passwordLabel.textContent = "Password";

  const password = createPasswordField("unlock-password", "Enter password");

  const passwordError = document.createElement("div");
  passwordError.className = "form-group__error";
  passwordError.setAttribute("role", "alert");

  passwordGroup.append(passwordLabel, password.wrapper, passwordError);
  form.appendChild(passwordGroup);

  // Remember toggle
  const remember = createToggle("unlock-remember", "Remember password on this device", false);
  form.appendChild(remember.wrapper);

  // Network error alert
  const networkAlert = document.createElement("div");
  networkAlert.className = "alert alert--error";
  networkAlert.setAttribute("role", "alert");
  networkAlert.style.display = "none";
  form.appendChild(networkAlert);

  // Unlock button
  const unlockBtn = document.createElement("button");
  unlockBtn.type = "button";
  unlockBtn.className = "btn btn--primary";
  unlockBtn.disabled = true;
  unlockBtn.textContent = "Unlock";
  form.appendChild(unlockBtn);

  // Forgot password link
  const forgotLink = document.createElement("button");
  forgotLink.type = "button";
  forgotLink.style.cssText = [
    "background: none",
    "border: none",
    "color: var(--color-status-info)",
    "cursor: pointer",
    "font-size: var(--font-size-sm)",
    "padding: 0",
    "align-self: center",
  ].join(";");
  forgotLink.textContent = "Forgot password?";
  forgotLink.addEventListener("click", () => {
    options.onForgotPassword();
  });
  form.appendChild(forgotLink);

  container.appendChild(form);

  // ── Validation ──

  const validate = (): void => {
    unlockBtn.disabled = password.input.value.length === 0;
  };

  password.input.addEventListener("input", () => {
    passwordError.textContent = "";
    networkAlert.style.display = "none";
    validate();
  });

  // ── Fetch initial status for remember state ──

  api<VaultStatus>("GET", `/api/vaults/${encodeURIComponent(options.vaultName)}/status`)
    .then((status) => {
      remember.setValue(status.remembered);
      if (status.unlocked) {
        options.onUnlocked();
      }
    })
    .catch(() => {
      // Status fetch failed; proceed with defaults
    });

  // ── Submit logic ──

  let submitting = false;

  const handleSubmit = async (): Promise<void> => {
    if (unlockBtn.disabled || submitting) return;
    submitting = true;
    unlockBtn.disabled = true;
    unlockBtn.textContent = "Unlocking\u2026";
    networkAlert.style.display = "none";
    passwordError.textContent = "";

    try {
      await api<{ secretCount: number; groupCount: number }>(
        "POST",
        `/api/vaults/${encodeURIComponent(options.vaultName)}/unlock`,
        { password: password.input.value, remember: remember.getValue() },
      );
      options.onUnlocked();
    } catch (err: unknown) {
      submitting = false;
      unlockBtn.textContent = "Unlock";

      if (err instanceof ApiError && err.status === 400) {
        passwordError.textContent = "Invalid password. Please try again.";
        password.input.value = "";
        password.input.focus();
        validate();
        return;
      }

      // Network or other error
      networkAlert.textContent =
        err instanceof Error ? err.message : "An unexpected error occurred";
      networkAlert.style.display = "block";
      validate();
    }
  };

  unlockBtn.addEventListener("click", handleSubmit);

  password.input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSubmit();
    }
  });

  // Auto-focus
  password.input.focus();
}

/**
 * Cleans up references held by the unlock screen.
 */
export function destroyUnlock(): void {
  containerRef = null;
  currentOptions = null;
}
