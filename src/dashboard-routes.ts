export type Route =
  | { view: "overview"; repo: { owner: string; name: string } | null }
  | { view: "practices" }
  | { view: "practice"; id: string }
  | { view: "new-practice" }
  | { view: "missing" };

export function parseRoute(pathname: string): Route {
  if (pathname !== "/app" && !pathname.startsWith("/app/")) {
    return { view: "missing" };
  }

  const parts = pathname
    .replace(/^\/app\/?/u, "")
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });

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
