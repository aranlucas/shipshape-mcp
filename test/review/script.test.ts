import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { REVIEW_SCRIPT } from "@/web/review-script";
import type { RepositoryReview } from "@/review/types";

type Handler = (event: { preventDefault(): void }) => void;

interface FormElements {
  namedItem(name: string): ElementStub;
}

/** Minimal event/element contract for exercising the shipped script, not a layout emulator. */
class ElementStub {
  readonly tag: string;
  children: ElementStub[] = [];
  readonly events = new Map<string, Handler>();
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  textContent = "";
  className = "";
  value = "";
  href = "";
  disabled = false;
  elements?: FormElements;

  constructor(tag = "div") {
    this.tag = tag;
  }

  appendChild(node: ElementStub) {
    this.children.push(node);

    return node;
  }

  replaceChildren(...children: ElementStub[]) {
    this.children = children;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  addEventListener(event: string, handler: Handler) {
    this.events.set(event, handler);
  }

  querySelector() {
    return this.children.find((node) => node.tag === "button");
  }
}

function walk(node: ElementStub): ElementStub[] {
  return [node, ...node.children.flatMap(walk)];
}

function report(repository: string): RepositoryReview {
  return {
    repository,
    url: `https://github.com/${repository}`,
    commit: "a".repeat(40),
    collectedAt: "2026-10-15T06:00:00Z",
    limitations: ["Synthetic test evidence; no execution verified."],
    findings: [
      {
        id: "standards",
        repository,
        category: "standards",
        title: "Review test paths",
        state: "needs_review",
        priority: "medium",
        confidence: "high",
        current: '<img src=x onerror="window.pwned=true">',
        desired: "Keep deliberate test conventions.",
        nextStep: "Inspect effective configuration before proposing changes.",
        approvalRequired: true,
        evidence: [
          { url: `https://github.com/${repository}/tree/${"a".repeat(40)}`, label: "Pinned tree" },
        ],
      },
      {
        id: "cleanup",
        repository,
        category: "cleanup",
        title: "Usage graph unknown",
        state: "unknown",
        priority: "low",
        confidence: "low",
        current: "Entrypoints uninspected.",
        desired: "Protect public APIs.",
        nextStep: "Build an entrypoint-aware graph.",
        approvalRequired: true,
        evidence: [{ url: "javascript:alert(1)", label: "Unsafe evidence" }],
      },
    ],
  };
}

function harness() {
  const nodes = new Map(
    [
      "review-form",
      "review-status",
      "review-repositories",
      "review-pages",
      "review-findings",
      "review-summary",
      "review-repo-filter",
      "review-category",
      "review-state",
    ].map((id) => [id, new ElementStub()]),
  );

  const node = (id: string) => {
    const found = nodes.get(id);

    if (!found) {
      throw new Error(`Missing node ${id}`);
    }

    return found;
  };

  const owner = new ElementStub("input");
  owner.value = "octo";
  node("review-form").elements = { namedItem: () => owner };
  node("review-form").children = [new ElementStub("button")];
  const requests: string[] = [];
  let fail = false;

  const fetch = (path: string) => {
    requests.push(path);
    const url = new URL(path, "https://shipshape.example");
    const currentOwner = url.searchParams.get("owner") ?? "";

    if (fail) {
      return Promise.resolve(Response.json({ error: "Provider unavailable." }, { status: 502 }));
    }

    if (url.pathname.endsWith("/repos")) {
      const page = Number(url.searchParams.get("page"));

      return Promise.resolve(
        Response.json({
          owner: currentOwner,
          page,
          hasNextPage: page === 1,
          repositories: [page === 1 ? "demo" : "later"].map((name) => ({
            owner: currentOwner,
            name,
            repository: `${currentOwner}/${name}`,
            url: `https://github.com/${currentOwner}/${name}`,
          })),
        }),
      );
    }

    return Promise.resolve(
      Response.json(report(`${currentOwner}/${url.searchParams.get("repo") ?? ""}`)),
    );
  };

  runInNewContext(REVIEW_SCRIPT, {
    document: {
      getElementById: node,
      createElement: (tag: string) => new ElementStub(tag),
      querySelectorAll: () =>
        [...nodes.values()].flatMap(walk).filter((element) => element.tag === "button"),
    },
    fetch,
    URL,
    URLSearchParams,
    Map,
  });
  const all = () => [...nodes.values()].flatMap(walk);

  const button = (label: string) => {
    const found = all().find(
      (element) => element.tag === "button" && element.textContent === label,
    );

    if (!found) {
      throw new Error(`Missing button ${label}`);
    }

    return found;
  };

  const fire = async (element: ElementStub, event: string) => {
    const handler = element.events.get(event);

    if (!handler) {
      throw new Error(`Missing event ${event}`);
    }

    handler({ preventDefault() {} });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  };

  return {
    node,
    owner,
    requests,
    all,
    button,
    fire,
    fail: () => {
      fail = true;
    },
    cards: () => all().filter((element) => element.tag === "article"),
  };
}

describe("repository review browser script behavior", () => {
  it("inspects only on request and filters evidence without parsing provider HTML", async () => {
    const ui = harness();
    expect(ui.requests).toEqual([]);
    await ui.fire(ui.node("review-form"), "submit");
    expect(ui.cards()).toHaveLength(0);
    expect(ui.all().some((node) => node.textContent === "Not checked")).toBe(true);
    await ui.fire(ui.button("Inspect"), "click");
    expect(ui.cards()).toHaveLength(2);
    expect(ui.all().some((node) => node.tag === "img")).toBe(false);
    expect(ui.all().some((node) => node.textContent.includes("<img src=x"))).toBe(true);
    expect(ui.all().some((node) => node.href.startsWith("javascript:"))).toBe(false);
    expect(ui.all().some((node) => node.textContent === "Unsafe evidence (link unavailable)")).toBe(
      true,
    );
    ui.node("review-category").value = "cleanup";
    await ui.fire(ui.node("review-category"), "change");
    expect(ui.cards()).toHaveLength(1);
    ui.node("review-state").value = "observed";
    await ui.fire(ui.node("review-state"), "change");
    expect(ui.cards()).toHaveLength(0);
  });

  it("keeps pagination bound to the loaded owner and resets reports only on submitted owner change", async () => {
    const ui = harness();
    await ui.fire(ui.node("review-form"), "submit");
    await ui.fire(ui.button("Inspect"), "click");
    ui.owner.value = "another";
    await ui.fire(ui.button("Next"), "click");
    expect(ui.requests.at(-1)).toBe("/app/api/review/repos?owner=octo&page=2");
    expect(ui.cards()).toHaveLength(2);
    ui.owner.value = "another";
    await ui.fire(ui.node("review-form"), "submit");
    expect(ui.requests.at(-1)).toBe("/app/api/review/repos?owner=another&page=1");
    expect(ui.cards()).toHaveLength(0);
  });

  it("retains the previous timestamped report and clears busy state when refresh fails", async () => {
    const ui = harness();
    await ui.fire(ui.node("review-form"), "submit");
    await ui.fire(ui.button("Inspect"), "click");
    ui.fail();
    await ui.fire(ui.button("Refresh"), "click");
    expect(ui.cards()).toHaveLength(2);
    expect(ui.node("review-status").textContent).toContain("No new report was saved");
    expect(ui.node("review-findings").attributes.get("aria-busy")).toBe("false");
    expect(ui.button("Refresh").disabled).toBe(false);
  });
});
