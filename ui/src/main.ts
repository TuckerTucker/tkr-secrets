/**
 * Application entry point for tkr-secrets.
 *
 * Initializes the theme system, mounts the theme toggle into the footer,
 * and sets up client-side routing.
 *
 * @module main
 */

import { initTheme } from "./theme.js";
import { createThemeToggle } from "./components/theme-toggle.js";
import { initRouter, pathToRoute, navigate } from "./router.js";
import type { Route } from "./router.js";
import { renderRecoveryKey, destroyRecoveryKey } from "./screens/recovery-key.js";
import type { RecoveryKeyScreenOptions } from "./screens/recovery-key.js";
import { renderRecover, destroyRecover } from "./screens/recover.js";
import { renderUnlock, destroyUnlock } from "./screens/unlock.js";
import { renderManage, destroyManage } from "./screens/manage.js";
import * as picker from "./screens/picker.js";
import * as init from "./screens/init.js";

/**
 * Active screen destructor. Called before rendering a new screen
 * so the previous screen can clean up intervals and listeners.
 */
let activeDestroy: (() => void) | null = null;

/** Renders placeholder content into `#app-main`. Screens will replace this. */
function renderPlaceholder(main: HTMLElement, text: string): void {
  teardown();
  main.textContent = text;
}

/**
 * Tears down the currently active screen, if any.
 */
function teardown(): void {
  if (activeDestroy) {
    activeDestroy();
    activeDestroy = null;
  }
}

/**
 * In-memory store for recovery key material, set by vault creation or
 * password recovery before navigating to the recovery key screen.
 */
let pendingRecoveryKey: RecoveryKeyScreenOptions | null = null;

/**
 * Stores recovery key screen options to be consumed by the recovery key route.
 *
 * @param options - Recovery key material and metadata from vault init or recover.
 */
export function setPendingRecoveryKey(options: RecoveryKeyScreenOptions): void {
  pendingRecoveryKey = options;
}

/**
 * Shows the vault unlock screen for a locked vault.
 *
 * @param main - The main content container.
 * @param vaultName - The name of the vault to unlock.
 */
function showUnlock(main: HTMLElement, vaultName: string): void {
  teardown();
  main.innerHTML = "";
  renderUnlock(main, {
    vaultName,
    onUnlocked: () => {
      showManage(main, vaultName);
    },
    onForgotPassword: () => {
      navigate(`/vault/${encodeURIComponent(vaultName)}/recover`);
    },
    onBack: () => {
      showPicker(main);
    },
  });
  activeDestroy = destroyUnlock;
}

/**
 * Shows the vault manage screen for an unlocked vault.
 *
 * @param main - The main content container.
 * @param vaultName - The name of the vault to manage.
 */
function showManage(main: HTMLElement, vaultName: string): void {
  teardown();
  main.innerHTML = "";
  renderManage(main, {
    vaultName,
    onLocked: () => {
      showUnlock(main, vaultName);
    },
    onBack: () => {
      showPicker(main);
    },
    onDeleted: () => {
      showPicker(main);
    },
  });
  activeDestroy = destroyManage;
}

/**
 * Shows the vault picker screen.
 *
 * @param main - The main content container.
 */
function showPicker(main: HTMLElement): void {
  teardown();
  main.innerHTML = "";
  picker.render(main, {
    onSelectVault: (name: string, unlocked: boolean) => {
      if (unlocked) {
        showManage(main, name);
      } else {
        showUnlock(main, name);
      }
    },
    onCreateVault: () => {
      showInit(main, false);
    },
  });
  activeDestroy = picker.destroy;
}

/**
 * Shows the vault init (create) screen.
 *
 * @param main - The main content container.
 * @param hideBack - Whether to hide the back button (empty state).
 */
function showInit(main: HTMLElement, hideBack: boolean): void {
  teardown();
  main.innerHTML = "";
  init.render(main, {
    onCreated: (name: string, recoveryKeyMaterial: unknown) => {
      const vaultName = name;
      setPendingRecoveryKey({
        vaultName,
        recoveryKey: recoveryKeyMaterial as { mnemonic: string; raw: string; qr: string },
        onContinue: () => {
          destroyRecoveryKey();
          showManage(main, vaultName);
        },
      });
      navigate(`/vault/${encodeURIComponent(name)}/recovery-key`);
    },
    onBack: () => {
      showPicker(main);
    },
    hideBack,
  });
  activeDestroy = init.destroy;
}

/**
 * Bootstraps the application once the DOM is ready.
 */
function bootstrap(): void {
  // Initialize theme before any rendering to avoid flash
  initTheme();

  const footer = document.getElementById("app-footer");
  if (footer) {
    createThemeToggle(footer);
  }

  const main = document.getElementById("app-main");
  if (!main) return;

  const rootRoute = pathToRoute("/");
  const recoveryKeyRoute = pathToRoute("/vault/:name/recovery-key");
  const recoverRoute = pathToRoute("/vault/:name/recover");

  const routes: Route[] = [
    {
      ...rootRoute,
      render: () => {
        showPicker(main);
      },
    },
    {
      ...recoveryKeyRoute,
      render: (params) => {
        teardown();
        destroyRecoveryKey();
        const options = pendingRecoveryKey;
        pendingRecoveryKey = null;

        if (!options || options.vaultName !== params.name) {
          navigate("/");
          return;
        }

        const vaultName = options.vaultName;
        renderRecoveryKey(main, {
          ...options,
          onContinue: () => {
            destroyRecoveryKey();
            showManage(main, vaultName);
          },
        });
        activeDestroy = destroyRecoveryKey;
      },
    },
    {
      ...recoverRoute,
      render: (params) => {
        teardown();
        main.innerHTML = "";
        const vaultName = params.name;
        renderRecover(main, {
          vaultName,
          onRecovered: (recoveryKey) => {
            setPendingRecoveryKey({
              vaultName,
              recoveryKey,
              onContinue: () => {
                destroyRecoveryKey();
                showManage(main, vaultName);
              },
            });
            navigate(`/vault/${encodeURIComponent(vaultName)}/recovery-key`);
          },
          onBack: () => {
            navigate("/");
          },
        });
        activeDestroy = destroyRecover;
      },
    },
  ];

  initRouter(routes);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
