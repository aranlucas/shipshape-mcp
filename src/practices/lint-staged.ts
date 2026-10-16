import { z } from "zod";
import type { RepoSnapshot } from "./snapshot";

const Commands = z.union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)]);

const Manifest = z.object({
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  "lint-staged": z.record(z.string().min(1), Commands).optional(),
});

const RUNNER = String.raw`(?:pnpm(?:\s+exec)?|npx(?:\s+--no-install)?|bunx|bun\s+x|yarn(?:\s+exec)?|npm\s+exec(?:\s+--)?)`;

const INVOCATION = new RegExp(
  `^(?:exec\\s+)?${RUNNER}\\s+lint-staged(?:\\s+[\\w./=,:+%-]+)*\\s*$`,
  "u",
);

const PREPARE =
  /^(?:husky|pnpm (?:exec )?husky|npx (?:--no-install )?husky|bunx husky|bun x husky|yarn husky|npm exec (?:-- )?husky)(?:\s*\|\|\s*true)?$/u;

interface Inspection {
  state: "pass" | "fail" | "unknown";
  path: string;
  detail: string;
}

type FileRead = { text: string } | { inspection: Inspection };

function readFile(snapshot: RepoSnapshot, path: string): FileRead {
  const value = snapshot.files.get(path);
  const content = z.string().safeParse(value);

  if (content.success) {
    return { text: content.data };
  }

  const error = z.object({ error: z.string() }).safeParse(value);

  if (error.success) {
    return { inspection: { state: "unknown", path, detail: error.data.error } };
  }

  const unavailable = !snapshot.tree || snapshot.tree.truncated || snapshot.tree.paths.has(path);

  return {
    inspection: {
      state: unavailable ? "unknown" : "fail",
      path,
      detail: unavailable
        ? `${path} could not be read at the evaluated commit.`
        : `${path} is missing.`,
    },
  };
}

/** Only prove direct, top-level calls; do not execute or interpret arbitrary shell code. */
function inspectHook(hook: string): Inspection {
  const path = ".husky/pre-commit";

  for (const source of hook.split(/\r?\n/u)) {
    const line = source.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    if (
      line.includes("<<") ||
      /[\\&|{(]$/u.test(line) ||
      /^(?:if|for|while|until|case|function|select)\b|^[\w-]+\s*\(\)/u.test(line)
    ) {
      return {
        state: "unknown",
        path,
        detail:
          "The hook needs review: no direct lint-staged call was proven before complex shell control flow.",
      };
    }

    if (/^(?:exit|return)\b/u.test(line)) {
      return { state: "fail", path, detail: "The hook exits before invoking lint-staged." };
    }

    // Multiline strings can contain text that looks like a command on a later line.
    const unescaped = line.replaceAll(/\\./gu, "");

    if (
      unescaped.includes("`") ||
      (unescaped.match(/'/gu)?.length ?? 0) % 2 ||
      (unescaped.match(/"/gu)?.length ?? 0) % 2
    ) {
      return {
        state: "unknown",
        path,
        detail: "The hook contains shell quoting or substitutions that require review.",
      };
    }

    if (INVOCATION.test(line)) {
      if (/(?:^|\s)(?:--help|--version|-h|-V)(?:\s|$)/u.test(line)) {
        return {
          state: "fail",
          path,
          detail: "The hook only asks lint-staged for help or version information.",
        };
      }

      if (/(?:^|\s)(?:--config(?:=|\s)|-c(?:=|\s))/u.test(line)) {
        return {
          state: "unknown",
          path,
          detail:
            "The hook selects an external lint-staged configuration; its tasks require review.",
        };
      }

      return {
        state: "pass",
        path,
        detail: "The hook directly invokes lint-staged. Additional hook steps are preserved.",
      };
    }
  }

  return {
    state: "fail",
    path,
    detail:
      "No supported direct lint-staged invocation was found. Comments, quoted examples, and commands that ignore failure do not count.",
  };
}

export function inspectLintStaged(snapshot: RepoSnapshot): Inspection {
  const path = "package.json";
  const file = readFile(snapshot, path);

  if ("inspection" in file) {
    return file.inspection;
  }

  let parsed: ReturnType<typeof Manifest.safeParse>;

  try {
    parsed = Manifest.safeParse(JSON.parse(file.text));
  } catch {
    return { state: "unknown", path, detail: "package.json could not be parsed." };
  }

  if (!parsed.success) {
    return {
      state: "fail",
      path,
      detail: "Husky scripts, dependencies, or lint-staged tasks have an invalid manifest shape.",
    };
  }

  const manifest = parsed.data;

  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  };

  if (!["husky", "lint-staged"].every((name) => dependencies[name]?.trim())) {
    return {
      state: "fail",
      path,
      detail: "Declare both husky and lint-staged as local dependencies.",
    };
  }

  if (!PREPARE.test(manifest.scripts?.prepare?.trim() ?? "")) {
    return {
      state: "fail",
      path,
      detail: "The prepare script must initialize Husky using the repository's package manager.",
    };
  }

  if (!manifest["lint-staged"] || !Object.keys(manifest["lint-staged"]).length) {
    return {
      state: "fail",
      path,
      detail:
        "Declare non-empty lint-staged patterns and commands in package.json. External configuration requires separate review.",
    };
  }

  const hook = readFile(snapshot, ".husky/pre-commit");

  if ("inspection" in hook) {
    return hook.inspection;
  }

  const inspection = inspectHook(hook.text);

  return inspection.state === "pass"
    ? {
        ...inspection,
        detail:
          "Husky initialization, declared dependencies, staged tasks, and a direct hook invocation are present. Commands were not executed.",
      }
    : inspection;
}
