/**
 * Browser code for /app.  It is plain ES2022 without template literals so it
 * can live in this string, and it only builds the DOM with textContent: no
 * repository or policy value is ever parsed as HTML.
 */
export const APP_SCRIPT = String.raw`"use strict";
(() => {
  const PRESETS = {
    squash: [
      "  - id: squash-only",
      "    description: Squash merges only, branches cleaned up after merge",
      "    merge:",
      "      allowSquash: true",
      "      allowMergeCommit: false",
      "      allowRebase: false",
      "      deleteBranchOnMerge: true",
    ],
    protect: [
      "  - id: protected-default-branch",
      "    description: Reviewed default branch with admin enforcement and resolved conversations",
      "    branchProtection:",
      "      requiredApprovingReviews: 1",
      "      dismissStaleReviews: true",
      "      enforceAdmins: true",
      "      requiredConversationResolution: true",
      "      requiredLinearHistory: true",
      "      allowForcePushes: false",
      "      allowDeletions: false",
    ],
    review: [
      "  - id: stronger-review-controls",
      "    description: Require code owner review and approval after the latest push",
      "    branchProtection:",
      "      requireCodeOwnerReviews: true",
      "      requireLastPushApproval: true",
    ],
    signatures: [
      "  - id: signed-commits",
      "    description: Require signed commits on the default branch",
      "    branchProtection:",
      "      requiredSignatures: true",
    ],
    security: [
      "  - id: security-analysis",
      "    description: Secret scanning, push protection, and security updates",
      "    security:",
      "      secretScanning: true",
      "      pushProtection: true",
      "      dependabotSecurityUpdates: true",
    ],
    tidy: [
      "  - id: tidy-features",
      "    description: Issues on, unused wiki and projects off",
      "    features:",
      "      issues: true",
      "      wiki: false",
      "      projects: false",
    ],
  };

  const STARTER = ["version: 1", "rules:"]
    .concat(PRESETS.squash, PRESETS.protect)
    .join("\n") + "\n";

  const form = document.getElementById("drift-form");
  const results = document.getElementById("results");
  const status = document.getElementById("form-status");
  if (!form || !results || !status) return;

  const policy = form.elements.namedItem("policy");
  const owner = form.elements.namedItem("owner");
  const limit = form.elements.namedItem("limit");

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function append(parent, children) {
    for (const child of children) if (child) parent.appendChild(child);
    return parent;
  }

  function say(message, tone) {
    status.textContent = message;
    status.dataset.tone = tone || "";
  }

  function format(value) {
    if (value === null || value === undefined) return "hidden";
    if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
    return String(value);
  }

  async function request(path, method, body) {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (response.status === 401) {
      window.location.assign("/app");
      throw new Error("Sign in again to continue.");
    }
    if (!response.ok)
      throw new Error((payload && payload.error) || "Request failed (" + response.status + ").");
    return payload;
  }

  function copyButton(text) {
    const button = el("button", "button-secondary button-small", "Copy");
    button.type = "button";
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Select and copy";
      }
      setTimeout(() => { button.textContent = "Copy"; }, 1800);
    });
    return button;
  }

  function pill(state) {
    return el("span", "pill pill-" + state, state.replace("_", " "));
  }

  function tile(label, value, tone) {
    return append(el("div", "tile tile-" + tone), [
      el("span", "tile-value", value),
      el("span", "tile-label", label),
    ]);
  }

  function checksTable(checks) {
    const table = el("table", "checks");
    const head = el("tr");
    for (const title of ["Rule", "Setting", "Expected", "Actual", "State"])
      head.appendChild(el("th", "", title));
    append(table, [append(el("thead"), [head])]);
    const body = el("tbody");
    for (const check of checks) {
      const row = el("tr");
      const setting = check.branch ? check.setting + " (" + check.branch + ")" : check.setting;
      const state = el("td");
      state.appendChild(pill(check.state));
      if (check.reason) state.title = check.reason;
      append(row, [
        el("td", "mono", check.rule),
        el("td", "mono", setting),
        el("td", "", format(check.expected)),
        el("td", "", format(check.actual)),
        state,
      ]);
      body.appendChild(row);
    }
    table.appendChild(body);
    const wrap = el("div", "table-wrap");
    wrap.appendChild(table);
    return wrap;
  }

  function notes(title, items) {
    if (!items.length) return null;
    const list = el("ul", "notes");
    for (const item of items) {
      const entry = el("li");
      const where = item.branch ? item.setting + " on " + item.branch : item.setting;
      append(entry, [el("strong", "mono", where), document.createTextNode(" " + item.reason)]);
      list.appendChild(entry);
    }
    return append(el("div", "repo-section"), [el("h4", "", title), list]);
  }

  function remediation(steps) {
    if (!steps.length) return null;
    const section = el("div", "repo-section");
    section.appendChild(el("h4", "", "Fix commands"));
    for (const step of steps) {
      const block = el("div", "command");
      const header = append(el("div", "command-header"), [
        el("span", "", step.title),
        copyButton(step.command),
      ]);
      append(block, [header, el("pre", "mono", step.command)]);
      section.appendChild(block);
    }
    return section;
  }

  function repoCard(repo) {
    const card = el("details", "repo repo-" + repo.status);
    if (repo.status !== "compliant") card.open = true;
    const summary = el("summary");
    const link = el("a", "mono", repo.repository);
    link.href = repo.url;
    link.rel = "noreferrer";
    const counts = repo.counts.fail + " failing · " + repo.counts.unknown + " hidden · " + repo.counts.pass + " passing";
    append(summary, [pill(repo.status), link, el("span", "muted", counts)]);
    append(card, [
      summary,
      el("p", "muted", "Rules: " + repo.rules.join(", ")),
      checksTable(repo.checks),
      notes("Conflicting rules", repo.conflicts),
      remediation(repo.remediation),
      notes("Needs a manual change", repo.manual),
    ]);
    return card;
  }

  function render(report) {
    results.replaceChildren(el("h2", "panel-title", "Results"));
    const totals = report.totals;
    append(results, [
      append(el("div", "tiles"), [
        tile("Drifted", totals.drifted, "fail"),
        tile("Compliant", totals.compliant, "pass"),
        tile("Unknown", totals.unknown, "unknown"),
        tile("Fix commands", totals.remediationSteps, "neutral"),
      ]),
    ]);
    const scope = report.scope;
    let coverage = "Scanned " + scope.scannedRepositories + " of " + scope.matchedRepositories +
      " matching repositories (" + scope.listedRepositories + " listed).";
    if (scope.omittedRepositories) coverage += " Raise the repository limit to scan the rest.";
    if (!scope.listingComplete) coverage += " The owner has more repositories than one listing covers.";
    results.appendChild(el("p", "muted", coverage));
    if (!report.repositories.length && !report.failures.length)
      results.appendChild(el("p", "", "No public repository matched these rules."));
    for (const repo of report.repositories) results.appendChild(repoCard(repo));
    for (const failure of report.failures)
      results.appendChild(el("p", "form-status", failure.repository + ": " + failure.error));
    if (report.repositories.some((repo) => repo.counts.unknown))
      results.appendChild(el("p", "muted", "Hidden values are settings GitHub only shows to repository administrators. The suggested commands still set them safely."));
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    say("Checking repositories…");
    results.setAttribute("aria-busy", "true");
    try {
      const report = await request("/app/api/drift", "POST", {
        owner: owner.value.trim(),
        policy: policy.value,
        limit: Number(limit.value) || 10,
      });
      render(report);
      say(report.status === "compliant" ? "Everything matches your rules." : "Check complete.", report.status === "compliant" ? "ok" : "");
    } catch (error) {
      say(error.message, "error");
    } finally {
      results.setAttribute("aria-busy", "false");
    }
  });

  document.getElementById("save-rules").addEventListener("click", async () => {
    try {
      await request("/app/api/rules", "PUT", { policy: policy.value });
      say("Rules saved to your account.", "ok");
    } catch (error) {
      say(error.message, "error");
    }
  });

  document.getElementById("download-rules").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([policy.value], { type: "text/yaml" }));
    const link = el("a");
    link.href = url;
    link.download = "repo-rules.yml";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  document.getElementById("add-preset").addEventListener("click", () => {
    const key = document.getElementById("preset").value;
    const lines = PRESETS[key];
    if (!lines) return;
    const id = lines[0].replace("  - id: ", "");
    if (policy.value.includes("id: " + id)) {
      say("That preset is already in your rules.", "error");
      return;
    }
    const text = policy.value.trim() ? policy.value.replace(/\s*$/u, "\n") : "version: 1\nrules:\n";
    policy.value = text + lines.join("\n") + "\n";
    say("Preset added.", "ok");
  });

  request("/app/api/rules", "GET")
    .then((saved) => {
      policy.value = saved && saved.policy ? saved.policy : STARTER;
    })
    .catch(() => {
      policy.value = STARTER;
    });
})();
`;
