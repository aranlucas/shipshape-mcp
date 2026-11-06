import { useEffect, useState } from "preact/hooks";

import { parseRoute, type Route } from "../dashboard-routes";

export { paths, type Route } from "../dashboard-routes";

interface NavigateOptions {
  replace?: boolean;
}

export function navigate(path: string, options: NavigateOptions = {}): void {
  if (path === window.location.pathname) {
    return;
  }

  if (options.replace) {
    window.history.replaceState(null, "", path);
  } else {
    window.history.pushState(null, "", path);
  }

  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", update);

    return () => window.removeEventListener("popstate", update);
  }, []);

  return route;
}

/** Same-origin links navigate in place; modified clicks keep browser behavior. */
export function linkHandler(path: string) {
  return (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    event.preventDefault();
    navigate(path);
  };
}
