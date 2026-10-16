import { z } from "zod";
import type { RepoSnapshot } from "./snapshot";

const Manifest = z.object({ scripts: z.object({ test: z.string().trim().min(1) }) });

const FileError = z.object({ error: z.string() });

const FileText = z.string();

const DIRECT_VITEST =
  /^(?:vitest|pnpm(?:\s+exec)?\s+vitest|npx(?:\s+--no-install)?\s+vitest|npm\s+exec\s+(?:--\s+)?vitest|yarn(?:\s+exec)?\s+vitest|bunx\s+vitest|bun\s+x\s+vitest)((?:\s+[\w./=,:+@%-]+)*)$/u;

const INFORMATION_ONLY = /(?:^|\s)(?:--help|--version|-h|-v)(?:=|\s|$)|^\s*(?:list|init)(?:\s|$)/u;

interface Inspection {
  state: "pass" | "fail" | "unknown";
  path: string | null;
  detail: string;
}

function inspectManifest(snapshot: RepoSnapshot, path: string): Inspection {
  const value = snapshot.files.get(path);
  const text = FileText.safeParse(value);

  if (!text.success) {
    return {
      state: "unknown",
      path,
      detail: FileError.safeParse(value).data?.error ?? `${path} could not be read.`,
    };
  }

  let manifest: ReturnType<typeof Manifest.safeParse>;

  try {
    manifest = Manifest.safeParse(JSON.parse(text.data));
  } catch {
    return { state: "unknown", path, detail: `${path} could not be parsed.` };
  }

  if (!manifest.success) {
    return { state: "fail", path, detail: "Declare a non-empty scripts.test that runs Vitest." };
  }

  const script = manifest.data.scripts.test;
  const invocation = DIRECT_VITEST.exec(script);

  if (invocation) {
    return INFORMATION_ONLY.test(invocation[1] ?? "")
      ? { state: "fail", path, detail: "scripts.test only requests Vitest information or setup." }
      : { state: "pass", path, detail: "scripts.test directly runs Vitest." };
  }

  // Shell flow, wrappers and script aliases need review without executing repository code.
  const needsReview =
    /[&|;\n\r`$<>\\'"(){}]|^\w+=|^(?:npm|pnpm|yarn|bun|node|sh|bash|env|cross-env)\b/u.test(script);

  return {
    state: needsReview ? "unknown" : "fail",
    path,
    detail: needsReview
      ? "scripts.test needs review: a direct Vitest invocation could not be proven."
      : "scripts.test must run Vitest, for example: vitest run.",
  };
}

export function inspectVitestTestScripts(snapshot: RepoSnapshot): Inspection {
  if (!snapshot.tree) {
    return {
      state: "unknown",
      path: null,
      detail: snapshot.treeError ?? "The repository tree could not be read.",
    };
  }

  const paths = [...snapshot.tree.paths]
    .filter((path) => path === "package.json" || path.endsWith("/package.json"))
    .toSorted();

  const inspections = paths.map((path) => inspectManifest(snapshot, path));
  const failure = inspections.find((inspection) => inspection.state === "fail");

  if (failure) {
    return failure;
  }

  const unknown = inspections.find((inspection) => inspection.state === "unknown");

  if (unknown) {
    return unknown;
  }

  return snapshot.tree.truncated
    ? { state: "unknown", path: null, detail: "The repository tree was truncated." }
    : {
        state: "pass",
        path: null,
        detail: paths.length
          ? `All ${paths.length} tracked package.json files have a test script that runs Vitest.`
          : "No tracked package.json files found.",
      };
}
