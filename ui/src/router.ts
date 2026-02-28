/**
 * Client-side router using the History API.
 *
 * Supports parameterized route patterns, SPA link interception,
 * and forward/back navigation via popstate.
 *
 * @module router
 */

/**
 * A route definition mapping a URL pattern to a render function.
 */
export interface Route {
  /** RegExp to test against the pathname. */
  pattern: RegExp;
  /** Ordered list of named parameter capture groups. */
  params: string[];
  /** Called when this route matches, with extracted params. */
  render: (params: Record<string, string>) => void;
}

/** The currently registered routes. Set by {@link initRouter}. */
let routes: Route[] = [];

/**
 * Converts a path template like `/vault/:name/recover` into a
 * `Route`-compatible pattern and params list.
 *
 * @param template - Path template with `:param` segments.
 * @returns An object with `pattern` (RegExp) and `params` (string[]).
 */
export function pathToRoute(template: string): {
  pattern: RegExp;
  params: string[];
} {
  const params: string[] = [];
  const regexpStr = template.replace(/:([^/]+)/g, (_match, paramName) => {
    params.push(paramName);
    return "([^/]+)";
  });
  return {
    pattern: new RegExp(`^${regexpStr}$`),
    params,
  };
}

/**
 * Attempts to match the given pathname against the registered routes.
 * If a match is found, calls the route's render function with extracted params.
 *
 * @param pathname - The URL pathname to match.
 * @returns `true` if a route matched, `false` otherwise.
 */
function matchRoute(pathname: string): boolean {
  for (const route of routes) {
    const match = pathname.match(route.pattern);
    if (match) {
      const params: Record<string, string> = {};
      for (let i = 0; i < route.params.length; i++) {
        params[route.params[i]] = decodeURIComponent(match[i + 1]);
      }
      route.render(params);
      return true;
    }
  }
  return false;
}

/**
 * Navigates to a new path using pushState and triggers route matching.
 *
 * @param path - The pathname to navigate to.
 */
export function navigate(path: string): void {
  window.history.pushState(null, "", path);
  matchRoute(path);
}

/**
 * Initializes the router with the given route definitions.
 *
 * Sets up popstate handling for back/forward navigation and
 * intercepts clicks on anchor elements for SPA navigation.
 * Immediately matches the current pathname on initialization.
 *
 * @param routeDefs - The routes to register.
 */
export function initRouter(routeDefs: Route[]): void {
  routes = routeDefs;

  window.addEventListener("popstate", () => {
    matchRoute(window.location.pathname);
  });

  document.addEventListener("click", (e: MouseEvent) => {
    const target = (e.target as HTMLElement).closest("a");
    if (!target) return;
    if (!(target instanceof HTMLAnchorElement)) return;

    // Only intercept same-origin, non-modified clicks
    if (target.origin !== window.location.origin) return;
    if (target.hasAttribute("download")) return;
    if (target.getAttribute("target") === "_blank") return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

    e.preventDefault();
    navigate(target.pathname);
  });

  // Match the initial route
  matchRoute(window.location.pathname);
}
