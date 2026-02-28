/**
 * Vault init screen.
 *
 * Presents a form to create a new vault with name, password,
 * confirm password, and remember toggle.
 *
 * @module screens/init
 */

import { api, ApiError } from "../api.js";

/** Callbacks the init screen delegates to its parent. */
export interface InitOptions {
  onCreated: (name: string, recoveryKeyMaterial: unknown) => void;
  onBack: () => void;
  /** When true, the back button is hidden (first-time empty state). */
  hideBack?: boolean;
}

/** Response from POST /api/vaults. */
interface CreateVaultResponse {
  name: string;
  recoveryKey: unknown;
}

const VAULT_NAME_RE = /^[a-z][a-z0-9-]*$/;
const MAX_NAME_LENGTH = 64;

let containerRef: HTMLElement | null = null;
let currentOptions: InitOptions | null = null;

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

  const toggle = (): void => {
    active = !active;
    wrapper.classList.toggle("toggle--active", active);
    wrapper.setAttribute("aria-checked", String(active));
  };

  wrapper.addEventListener("click", toggle);
  wrapper.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });

  return { wrapper, getValue: () => active };
}

/**
 * Renders the vault init screen into the given container.
 *
 * @param container - The DOM element to render into.
 * @param options - Callbacks for vault creation and back navigation.
 */
export function render(container: HTMLElement, options: InitOptions): void {
  destroy();
  containerRef = container;
  currentOptions = options;

  container.innerHTML = "";

  const form = document.createElement("div");
  form.className = "init-form";

  // Back button
  if (!options.hideBack) {
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
  }

  // Shield icon
  const icon = document.createElement("div");
  icon.style.fontSize = "var(--font-size-2xl)";
  icon.style.textAlign = "center";
  icon.textContent = "\u{1F6E1}";
  icon.setAttribute("aria-hidden", "true");

  // Title
  const title = document.createElement("h1");
  title.style.fontSize = "var(--font-size-xl)";
  title.style.fontWeight = "var(--font-weight-semibold)";
  title.style.color = "var(--color-text-primary)";
  title.style.textAlign = "center";
  title.textContent = "Create New Vault";

  form.append(icon, title);

  // Vault name
  const nameGroup = document.createElement("div");
  nameGroup.className = "form-group";

  const nameLabel = document.createElement("label");
  nameLabel.className = "form-group__label";
  nameLabel.setAttribute("for", "vault-name");
  nameLabel.textContent = "Vault Name";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.id = "vault-name";
  nameInput.className = "input";
  nameInput.placeholder = "my-vault";
  nameInput.maxLength = MAX_NAME_LENGTH;
  nameInput.autocomplete = "off";
  nameInput.spellcheck = false;

  const nameError = document.createElement("div");
  nameError.className = "form-group__error";
  nameError.setAttribute("role", "alert");

  nameGroup.append(nameLabel, nameInput, nameError);
  form.appendChild(nameGroup);

  // Password fields
  const password = createPasswordField("vault-password", "Password", "Enter password");
  const confirm = createPasswordField("vault-confirm", "Confirm Password", "Confirm password");
  form.append(password.group, confirm.group);

  // Remember toggle
  const remember = createToggle("vault-remember", "Remember password on this device", false);
  form.appendChild(remember.wrapper);

  // Network error alert
  const networkAlert = document.createElement("div");
  networkAlert.className = "alert alert--error";
  networkAlert.setAttribute("role", "alert");
  networkAlert.style.display = "none";
  form.appendChild(networkAlert);

  // Submit button
  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "btn btn--primary";
  submitBtn.disabled = true;
  submitBtn.textContent = "Create Vault";
  form.appendChild(submitBtn);

  container.appendChild(form);

  // ── Validation logic ─────────────────────────────────────

  let nameValid = false;
  let passwordsValid = false;

  const validate = (): void => {
    const nameVal = nameInput.value;
    nameValid = nameVal.length > 0 && nameVal.length <= MAX_NAME_LENGTH && VAULT_NAME_RE.test(nameVal);
    const pwVal = password.input.value;
    const cfVal = confirm.input.value;
    passwordsValid = pwVal.length > 0 && pwVal === cfVal;
    submitBtn.disabled = !nameValid || !passwordsValid;
  };

  nameInput.addEventListener("input", () => {
    const val = nameInput.value;
    if (val.length === 0) {
      nameError.textContent = "";
      nameInput.classList.remove("input--error");
    } else if (!VAULT_NAME_RE.test(val)) {
      nameError.textContent = "Lowercase letters, numbers, and hyphens only";
      nameInput.classList.add("input--error");
    } else {
      nameError.textContent = "";
      nameInput.classList.remove("input--error");
    }
    // Clear any server-set error (409, 400) when user edits name
    networkAlert.style.display = "none";
    validate();
  });

  password.input.addEventListener("input", () => {
    validate();
    // Clear confirm error if they now match
    if (confirm.input.value.length > 0 && confirm.input.value === password.input.value) {
      confirm.error.textContent = "";
      confirm.input.classList.remove("input--error");
    }
  });

  confirm.input.addEventListener("input", validate);

  confirm.input.addEventListener("blur", () => {
    if (confirm.input.value.length > 0 && confirm.input.value !== password.input.value) {
      confirm.error.textContent = "Passwords do not match";
      confirm.input.classList.add("input--error");
    } else {
      confirm.error.textContent = "";
      confirm.input.classList.remove("input--error");
    }
  });

  // ── Submit logic ─────────────────────────────────────────

  let submitting = false;

  const handleSubmit = async (): Promise<void> => {
    if (submitBtn.disabled || submitting) return;
    submitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "Creating\u2026";
    networkAlert.style.display = "none";

    try {
      const result = await api<CreateVaultResponse>("POST", "/api/vaults", {
        name: nameInput.value,
        password: password.input.value,
        remember: remember.getValue(),
      });

      options.onCreated(result.name, result.recoveryKey);
    } catch (err: unknown) {
      submitting = false;
      validate(); // Re-enable button if still valid

      if (err instanceof ApiError) {
        if (err.status === 409) {
          nameError.textContent = "A vault with this name already exists";
          nameInput.classList.add("input--error");
          return;
        }
        if (err.status === 400) {
          nameError.textContent = err.message;
          nameInput.classList.add("input--error");
          return;
        }
      }

      // Network or other error
      networkAlert.textContent = err instanceof Error ? err.message : "An unexpected error occurred";
      networkAlert.style.display = "block";
    } finally {
      if (submitting) {
        submitting = false;
        submitBtn.textContent = "Create Vault";
        validate();
      }
    }
  };

  submitBtn.addEventListener("click", handleSubmit);

  // Enter key submits from any input
  const handleKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Enter") {
      handleSubmit();
    }
  };
  nameInput.addEventListener("keydown", handleKeydown);
  password.input.addEventListener("keydown", handleKeydown);
  confirm.input.addEventListener("keydown", handleKeydown);

  // Auto-focus the name input
  nameInput.focus();
}

/**
 * Cleans up references held by the init screen.
 */
export function destroy(): void {
  containerRef = null;
  currentOptions = null;
}
