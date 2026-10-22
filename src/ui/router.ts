import { useEffect, useState } from "preact/hooks";

export type Route =
  | { view: "overview"; repo: { owner: string; name: string } | null }
  | { view: "practices" }
  | { view: "practice"; id: string }
  | { view: "new-practice" }
  | { view: "missing" };

function parseRoute(pathname: string): Route {
  const parts = pathname
    .replace(/^\/app\/?/u, "")
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);

  if (parts.length === 0) {
    return { view: "overview", repo: null };
  }

  if (parts[0] === "repos" && parts.length === 3) {
    return { view: "overview", repo: { owner: parts[1], name: parts[2] } };
  }

  if (parts[0] === "practices" && parts.length === 1) {
    return { view: "practices" };
  }

  if (parts[0] === "practices" && parts[1] === "new" && parts.length === 2) {
    return { view: "new-practice" };
  }

  if (parts[0] === "practices" && parts.length === 2) {
    return { view: "practice", id: parts[1] };
  }

  return { view: "missing" };
}

export const paths = {
  overview: "/app",
  repo: (fullName: string) => `/app/repos/${fullName.split("/").map(encodeURIComponent).join("/")}`,
  practices: "/app/practices",
  practice: (id: string) => `/app/practices/${encodeURIComponent(id)}`,
  newPractice: "/app/practices/new",
};

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
