import type { ApiErrorResponse, RefreshRequest, SavePracticeRequest } from "../../api/contract.ts";
import { createStore, overview, practiceDetail, repoDetail } from "./fixtures.ts";

const store = createStore();

interface FixtureResult {
  status: number;
  body: unknown;
}

function error(
  status: number,
  message: string,
  issues?: ApiErrorResponse["issues"],
): FixtureResult {
  const payload: ApiErrorResponse = { error: message };

  if (issues) {
    payload.issues = issues;
  }

  return { status, body: payload };
}

/** Mirrors the /app/api routes closely enough to build the UI against. */
export function handleFixtureRequest(method: string, url: string, body: string): FixtureResult {
  const { pathname } = new URL(url, "http://fixture.local");

  const parts = pathname
    .replace(/^\/app\/api\//u, "")
    .split("/")
    .map(decodeURIComponent);

  if (method === "GET" && parts[0] === "overview") {
    return { status: 200, body: overview(store) };
  }

  if (method === "GET" && parts[0] === "repos" && parts.length === 3) {
    const detail = repoDetail(store, `${parts[1]}/${parts[2]}`);

    return detail ? { status: 200, body: detail } : error(404, "Repository not found");
  }

  if (parts[0] === "practices" && parts.length === 2) {
    const id = parts[1];

    if (method === "GET") {
      const detail = practiceDetail(store, id);

      return detail ? { status: 200, body: detail } : error(404, "Practice not found");
    }

    if (method === "PUT") {
      // SAFETY: development-only fixture; the dashboard sends SavePracticeRequest bodies.
      const request = JSON.parse(body) as SavePracticeRequest;

      if (/type:\s*file-exist\s*$/mu.test(request.yaml)) {
        return error(400, "Practice is invalid", [
          {
            path: "checks.0.type",
            message:
              'Invalid option: expected one of "file-exists"|"file-matches"|"file-contains"|"json-path"|"yaml-path"|"dependency"|"setting"|"branch-protection"|"workflow"',
          },
        ]);
      }

      if (!new RegExp(`^id:\\s*${id}\\s*$`, "mu").test(request.yaml)) {
        return error(400, "Practice is invalid", [
          { path: "id", message: `id must match its folder name "${id}"` },
        ]);
      }

      const seed = store.practices.find((item) => item.summary.id === id);

      if (seed) {
        seed.yaml = request.yaml;
        seed.instructions = request.instructions ?? null;
        seed.files = request.files ?? seed.files;

        if (seed.summary.origin !== "custom") {
          seed.summary = { ...seed.summary, origin: "override", matchesBuiltIn: false };
        }
      }

      store.catalogSha = crypto.randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40);

      return { status: 200, body: { catalogSha: store.catalogSha } };
    }

    if (method === "DELETE") {
      const index = store.practices.findIndex((item) => item.summary.id === id);

      if (index === -1) {
        return error(404, "Practice not found");
      }

      const [removed] = store.practices.splice(index, 1);

      // A built-in is turned off rather than deleted, so it can be turned back on.
      if (removed && removed.summary.origin !== "custom") {
        store.disabled.push({
          ...removed,
          summary: { ...removed.summary, origin: "built-in", matchesBuiltIn: false },
        });
      }

      return { status: 200, body: { catalogSha: store.catalogSha } };
    }
  }

  if (method === "POST" && parts[0] === "practices" && parts[2] === "reset") {
    const id = parts[1];
    const disabledIndex = store.disabled.findIndex((item) => item.summary.id === id);
    const seed = store.practices.find((item) => item.summary.id === id);

    if (disabledIndex !== -1) {
      store.practices.push(...store.disabled.splice(disabledIndex, 1));
    } else if (seed?.summary.origin === "override") {
      seed.summary = { ...seed.summary, origin: "built-in", matchesBuiltIn: false };
    } else {
      return error(404, "No catalog copy of this built-in practice to remove");
    }

    return { status: 200, body: { catalogSha: store.catalogSha } };
  }

  if (method === "POST" && parts[0] === "refresh") {
    // SAFETY: development-only fixture; the dashboard sends RefreshRequest bodies.
    const request = (body ? JSON.parse(body) : {}) as RefreshRequest;
    const queued = request.repo ? 1 : store.repos.length;
    store.pending = queued;
    setTimeout(() => {
      store.pending = 0;
    }, 4_000);

    return { status: 202, body: { queued } };
  }

  return error(404, "Not found");
}
