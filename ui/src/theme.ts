/**
 * Theme system for tkr-secrets.
 *
 * Manages light/dark theme state with system preference detection,
 * localStorage persistence, and live system preference tracking.
 *
 * @module theme
 */

const STORAGE_KEY = "tkr-theme";

type Theme = "light" | "dark";

/**
 * Returns the current active theme based on the `data-theme` attribute.
 */
export function getCurrentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/**
 * Toggles between light and dark themes.
 *
 * Persists the choice to localStorage so it survives page reloads
 * and overrides system preference detection.
 */
export function toggleTheme(): void {
  const next: Theme = getCurrentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem(STORAGE_KEY, next);
}

/**
 * Initializes the theme system on page load.
 *
 * Resolution order:
 * 1. Explicit override stored in localStorage (`tkr-theme`)
 * 2. System preference via `prefers-color-scheme`
 *
 * When no explicit override exists, listens for system preference
 * changes and applies them automatically.
 */
export function initTheme(): void {
  const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
  const prefersDark = window.matchMedia(
    "(prefers-color-scheme: dark)",
  ).matches;
  const theme: Theme = stored ?? (prefersDark ? "dark" : "light");

  document.documentElement.dataset.theme = theme;

  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", (e: MediaQueryListEvent) => {
      if (!localStorage.getItem(STORAGE_KEY)) {
        document.documentElement.dataset.theme = e.matches ? "dark" : "light";
      }
    });
}
