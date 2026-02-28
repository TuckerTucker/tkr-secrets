/**
 * Theme toggle component.
 *
 * Renders a sun/moon SVG button into the app footer.
 * Light mode shows a moon icon (click to go dark).
 * Dark mode shows a sun icon (click to go light).
 *
 * @module components/theme-toggle
 */

import { getCurrentTheme, toggleTheme } from "../theme.js";

const SUN_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="5"/>
  <line x1="12" y1="1" x2="12" y2="3"/>
  <line x1="12" y1="21" x2="12" y2="23"/>
  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
  <line x1="1" y1="12" x2="3" y2="12"/>
  <line x1="21" y1="12" x2="23" y2="12"/>
  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
</svg>`;

const MOON_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
</svg>`;

/**
 * Updates the toggle button icon and aria-label to reflect the current theme.
 */
function updateToggle(button: HTMLButtonElement): void {
  const theme = getCurrentTheme();
  if (theme === "dark") {
    button.innerHTML = SUN_SVG;
    button.setAttribute("aria-label", "Switch to light theme");
  } else {
    button.innerHTML = MOON_SVG;
    button.setAttribute("aria-label", "Switch to dark theme");
  }
}

/**
 * Creates the theme toggle button and appends it to the given container.
 *
 * @param container - The DOM element to append the toggle button into.
 * @returns The created button element.
 */
export function createThemeToggle(container: HTMLElement): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.id = "theme-toggle";
  button.style.color = "var(--color-text-secondary)";
  button.style.transition = "color var(--transition-normal)";
  button.style.display = "flex";
  button.style.alignItems = "center";
  button.style.justifyContent = "center";
  button.style.padding = "var(--space-2)";
  button.style.borderRadius = "var(--radius-sm)";

  updateToggle(button);

  button.addEventListener("click", () => {
    toggleTheme();
    updateToggle(button);
  });

  container.appendChild(button);
  return button;
}
