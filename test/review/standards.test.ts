import { describe, expect, it } from "vitest";
import { evaluateReviewStandards } from "@/review/standards";
import { evaluateStandards, type StandardsSource } from "@/standards/evaluate";

const commit = "a".repeat(40);

const manifest = {
  scripts: {
    lint: "oxlint",
    test: "vitest run",
    "test:e2e": "playwright test",
    typecheck: "tsc --noEmit",
    "format:check": "oxfmt --check",
  },
  packageManager: "pnpm@12.11.2",
  dependencies: {
    react: "^19.0.0",
    "react-dom": "^19.0.0",
    "@modelcontextprotocol/server": "2.3.1",
  },
  devDependencies: {
    vitest: "5.0.3",
    vite: "^8.3.4",
    "@aranlucas/oxforge": "0.2.2",
    oxlint: "^1.88.0",
    "@playwright/test": "^1.55.0",
    playwright: "^1.55.0",
    "@modelcontextprotocol/client": "2.3.1",
  },
};

function source(extra: Partial<StandardsSource> = {}): StandardsSource {
  return {
    repository: "octo/demo",
    commit,
    complete: true,
    policyState: "pass",
    collectedAt: "2026-10-15T00:00:00Z",
    policy: { baseline: "shipshape/recommended@1", packages: [], exceptions: [] },
    files: {
      ".shipshape.yml": "baseline: shipshape/recommended@1",
      "package.json": JSON.stringify(manifest),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, paths: { "@/*": ["./src/*"] } },
      }),
      "pnpm-lock.yaml": null,
      "vitest.config.ts":
        'export default defineConfig({ test: { include: ["test/**/*.test.ts"] }, resolve: { tsconfigPaths: true } });',
      "playwright.config.ts": 'export default defineConfig({ testDir: "./e2e" });',
      "src/index.ts": null,
      "test/behavior.test.ts": null,
      "e2e/login.spec.ts": null,
      ".github/workflows/ci.yml":
        "on: pull_request\njobs:\n  check:\n    steps:\n      - uses: pnpm/action-setup@v4\n      - run: pnpm install --frozen-lockfile\n      - run: pnpm test\n",
      ".github/dependabot.yml":
        "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: { interval: weekly }\n",
    },
    ...extra,
  };
}

function find(input: StandardsSource, key: string) {
  const result = evaluateReviewStandards(input).find(
    (finding) => finding.id === `octo/demo:.:${key}`,
  );

  expect(result, `Missing ${key}`).toBeDefined();

  return result;
}

describe("static standards review", () => {
  it("preserves every package evaluator state instead of duplicating baseline rules", () => {
    const input = source();
    const result = evaluateReviewStandards(input);

    for (const pkg of evaluateStandards(input).packages) {
      for (const check of pkg.audit.checks) {
        const finding = result.find((item) => item.id === `octo/demo:${pkg.path}:${check.ruleId}`);
        expect(finding?.state).toBe(
          check.state === "pass"
            ? "observed"
            : check.state === "fail"
              ? "needs_review"
              : check.state,
        );
        expect(finding?.priority).toBe(check.priority);
        expect(finding?.confidence).toBe(check.confidence);
      }
    }

    expect(result.every((finding) => finding.approvalRequired)).toBe(true);
    expect(result.every((finding) => finding.current && finding.desired && finding.nextStep)).toBe(
      true,
    );
    expect(
      result.flatMap((finding) => finding.evidence).every((item) => item.url.includes(commit)),
    ).toBe(true);
  });

  it("inherits opt-in Oxforge rules without flagging allowed local rule overrides", () => {
    const input = source();
    expect(
      evaluateReviewStandards(input).some((finding) => finding.id.includes("standards.oxforge-")),
    ).toBe(false);
    input.policy.convergence = { profile: "oxforge@1", version: "0.2.2" };
    input.files[".oxlintrc.json"] = JSON.stringify({
      extends: ["./node_modules/@aranlucas/oxforge/configs/recommended.json"],
      rules: { "consistent-return": "off", "typescript/prefer-readonly-parameter-types": "off" },
    });
    expect(find(input, "standards.oxforge-version")?.state).toBe("observed");
    expect(find(input, "standards.oxforge-lint")?.state).toBe("observed");
    expect(find(input, "standards.oxforge-legacy")?.state).toBe("observed");
    expect(
      evaluateReviewStandards(input)
        .filter((finding) => finding.state === "needs_review")
        .some((finding) => /consistent-return|readonly-parameter/.test(finding.current)),
    ).toBe(false);
  });

  it("retains active dated exceptions and surfaces expired ones separately", () => {
    const input = source();
    input.policy.exceptions = [
      {
        rule: "lint",
        path: ".",
        expires: "2026-10-15",
        reason: "Approved transition through today",
      },
      {
        rule: "test",
        path: ".",
        expires: "2026-10-14",
        reason: "Legacy test runner migration ended",
      },
    ];
    expect(find(input, "standards.lint")?.state).toBe("not_applicable");
    expect(find(input, "standards.lint")?.current).toContain("2026-10-15");
    expect(find(input, "standards.test")?.state).toBe("observed");

    const expired = evaluateReviewStandards(input).filter((finding) =>
      finding.id.includes(":exception:"),
    );

    expect(expired).toHaveLength(1);
    expect(expired[0]?.state).toBe("needs_review");
    expect(expired[0]?.current).toContain("2026-10-14");
    expect(expired[0]?.nextStep).toContain("do not silently extend");
  });

  it("shows test directories, alias declarations, and CI text without claiming execution", () => {
    const input = source();
    expect(find(input, "standards.vitest-convention")?.state).toBe("observed");
    expect(find(input, "standards.vitest-convention")?.current).toContain(
      "1 test/spec paths under test/",
    );
    expect(find(input, "standards.playwright-convention")?.state).toBe("observed");
    expect(find(input, "standards.playwright-convention")?.current).toContain("./e2e");
    expect(find(input, "standards.source-aliases")?.state).toBe("observed");
    expect(find(input, "standards.source-aliases")?.current).toContain("@/* → ./src/*");
    expect(find(input, "standards.pnpm-setup")?.state).toBe("observed");
    expect(find(input, "standards.pnpm-setup")?.current).toContain("execution are not verified");
    expect(find(input, "standards.updates")?.current).toContain("npm at /");
  });

  it("keeps missing, inherited, dynamic, and budget-limited evidence honest", () => {
    const input = source();
    input.files["vitest.config.ts"] = null;
    input.files["tsconfig.json"] =
      '{"extends":"../../shared.json","compilerOptions":{"paths":{"@/*":["./src/*"]}}}';
    expect(find(input, "standards.vitest-convention")?.state).toBe("unknown");
    expect(find(input, "standards.source-aliases")?.state).toBe("unknown");
    input.files["vitest.config.ts"] = 'export default getConfig(); // "test/**/*.test.ts"';
    expect(find(input, "standards.vitest-convention")?.current).toContain("No literal config hint");
    expect(find(input, "standards.vitest-convention")?.current).toContain(
      "effective includes/excludes",
    );
    input.complete = false;
    expect(find(input, "standards.playwright-convention")?.state).toBe("unknown");
  });

  it("uses needs-review only for applicable directory conventions and preserves tests", () => {
    const input = source();
    delete input.files["test/behavior.test.ts"];
    input.files["src/behavior.test.ts"] = null;
    expect(find(input, "standards.vitest-convention")?.state).toBe("needs_review");
    expect(find(input, "standards.vitest-convention")?.nextStep).toContain(
      "retain meaningful behavior tests",
    );
    input.files["package.json"] = "{}";
    delete input.files["playwright.config.ts"];
    expect(find(input, "standards.playwright-convention")?.state).toBe("not_applicable");
  });

  it("does not count vendored/generated tests or nested workspace tests for the parent", () => {
    const input = source();
    delete input.files["test/behavior.test.ts"];
    input.files["test/generated/fake.test.ts"] = null;
    input.files["vendor/test/fake.test.ts"] = null;
    input.files["packages/child/package.json"] = JSON.stringify({
      devDependencies: { vitest: "5.0.3" },
    });
    input.files["packages/child/test/real.test.ts"] = null;
    input.files["vendor/package.json"] = JSON.stringify(manifest);
    expect(find(input, "standards.vitest-convention")?.current).toContain(
      "0 test/spec paths under test/",
    );
    const result = evaluateReviewStandards(input);
    expect(
      result.find(
        (finding) => finding.id === "octo/demo:packages/child:standards.vitest-convention",
      )?.state,
    ).toBe("observed");
    expect(result.some((finding) => finding.id === "octo/demo:vendor:cleanup.dead-code")).toBe(
      false,
    );
  });

  it("filters vendor packages before the review-only baseline package cap", () => {
    const input = source();

    for (let index = 0; index < 25; index += 1) {
      input.files[`a/vendor/p${index}/package.json`] = "{}";
    }

    input.files["z-project/package.json"] = "{}";
    expect(
      evaluateReviewStandards(input).some((finding) => finding.id.startsWith("octo/demo:a/vendor")),
    ).toBe(false);
    expect(
      evaluateReviewStandards(input).some(
        (finding) => finding.id === "octo/demo:z-project:standards.baseline",
      ),
    ).toBe(true);
  });

  it("groups related declarations with versions and no compatibility conclusion", () => {
    const result = evaluateReviewStandards(source()).filter(
      (finding) => finding.category === "dependencies",
    );

    expect(result).toHaveLength(5);
    expect(result.every((finding) => finding.state === "observed")).toBe(true);
    expect(result.find((finding) => finding.id.endsWith("related.vite-vitest"))?.current).toContain(
      "vitest 5.0.3 (devDependencies)",
    );
    expect(result.find((finding) => finding.id.endsWith("related.react"))?.current).toContain(
      "react ^19.0.0 (dependencies)",
    );
    expect(
      result.every((finding) =>
        finding.current.includes("no compatibility or latest-version claim"),
      ),
    ).toBe(true);
  });

  it("does not infer safe deletion from declarations or missing source reads", () => {
    const cleanup = evaluateReviewStandards(source()).filter(
      (finding) => finding.category === "cleanup",
    );

    expect(cleanup).toHaveLength(3);
    expect(
      cleanup.every(
        (finding) =>
          finding.state === "unknown" &&
          finding.current.includes("No entrypoint-aware usage graph"),
      ),
    ).toBe(true);
    expect(cleanup.find((finding) => finding.id.endsWith("dead-code"))?.desired).toContain(
      "public APIs, diagnostics, and meaningful behavior unit tests",
    );
    expect(cleanup.find((finding) => finding.id.endsWith("scripts"))?.nextStep).toContain(
      "external callers",
    );
  });

  it("does not establish CI setup from an install that precedes setup", () => {
    const input = source();
    input.files[".github/workflows/ci.yml"] =
      "on: pull_request\njobs:\n  check:\n    steps:\n      - run: pnpm install --frozen-lockfile\n      - uses: pnpm/action-setup@v4\n";
    expect(find(input, "standards.pnpm-setup")?.state).toBe("unknown");
  });

  it.each([
    { run: "pnpm install --frozen-lockfile\ncorepack enable", state: "unknown" },
    {
      run: "corepack enable\npnpm install --frozen-lockfile --no-frozen-lockfile",
      state: "unknown",
    },
    { run: "corepack enable\npnpm install --frozen-lockfile=false", state: "unknown" },
    { run: "corepack enable\npnpm install --frozen-lockfile", state: "observed" },
  ])("respects static command order and lockfile flags: $run", ({ run, state }) => {
    const input = source();
    input.files[".github/workflows/ci.yml"] =
      `on: pull_request\njobs:\n  check:\n    steps:\n      - run: ${JSON.stringify(run)}\n`;
    expect(find(input, "standards.pnpm-setup")?.state).toBe(state);
  });

  it.each([
    { requireLockfile: "true", state: "observed" },
    { requireLockfile: "'true'", state: "observed" },
    { requireLockfile: "false", state: "unknown" },
    { requireLockfile: "'false'", state: "unknown" },
    { requireLockfile: "'${{ inputs.require-lockfile }}'", state: "unknown" },
  ])(
    "observes explicit combined pnpm/setup locked-install declarations: $requireLockfile",
    ({ requireLockfile, state }) => {
      const input = source();
      input.files[".github/workflows/ci.yml"] =
        `on: pull_request\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: pnpm/setup@${"f".repeat(40)}\n        with:\n          cache: true\n          require-lockfile: ${requireLockfile}\n      - run: pnpm test\n`;
      expect(find(input, "standards.pnpm-setup")?.state).toBe(state);
      expect(find(input, "standards.pnpm-setup")?.current).toContain("execution are not verified");

      expect(
        find(input, "standards.pnpm-setup")?.current.includes(
          "Combined pnpm/setup declares require-lockfile: true",
        ),
      ).toBe(state === "observed");
    },
  );

  it("surfaces omitted packages and unreadable selected configs without false alignment", () => {
    const input = source();
    input.files["vitest.config.ts"] = null;

    for (let index = 0; index < 22; index += 1) {
      input.files[`packages/p${index}/package.json`] = "{}";
    }

    const coverage = evaluateReviewStandards(input).find((finding) =>
      finding.id.endsWith("standards.collection-coverage"),
    );

    expect(coverage?.state).toBe("unknown");
    expect(coverage?.current).toContain("3 Node packages beyond");
    expect(coverage?.current).toContain("vitest.config.ts");
    input.complete = false;
    delete input.files["src/index.ts"];
    expect(find(input, "standards.source-aliases")?.state).toBe("unknown");
  });

  it("is deterministic and does not mutate a frozen source", () => {
    const input = source();
    Object.freeze(input.files);
    Object.freeze(input.policy);
    Object.freeze(input);
    expect(evaluateReviewStandards(input)).toEqual(evaluateReviewStandards(input));
  });
});
