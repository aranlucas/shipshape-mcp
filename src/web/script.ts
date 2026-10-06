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
      "    description: Protected default branch without a required review, with admin enforcement and resolved conversations",
      "    branchProtection:",
      "      enforceAdmins: true",
      "      requiredConversationResolution: true",
      "      requiredLinearHistory: true",
      "      allowForcePushes: false",
      "      allowDeletions: false",
    ],
    review: [
      "  - id: stronger-review-controls",
      "    description: Team review controls: code owner review and approval after the latest push",
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
    onboarding: [
      "  - id: community-health-files",
      "    description: README, license, contribution guide, code of conduct, security policy, and citation metadata",
      "    repositoryFiles:",
      "      readme: true",
      "      license: true",
      "      contributing: true",
      "      codeOfConduct: true",
      "      security: true",
      "      citation: true",
    ],
    workflows: [
      "  - id: hardened-actions-workflows",
      "    description: Minimal token permissions, immutable action references, and dependency review on pull requests",
      "    workflowSecurity:",
      "      leastPrivilegeToken: true",
      "      pinnedActions: true",
      "      dependencyReview: true",
    ],
    rulesets: [
      "  - id: active-repository-ruleset",
      "    description: Require an active repository or inherited organization ruleset",
      "    repositoryRules:",
      "      activeRuleset: true",
    ],
    vulnerability: [
      "  - id: vulnerability-reporting",
      "    description: Publish a security policy and enable private vulnerability reporting",
      "    security:",
      "      privateVulnerabilityReporting: true",
      "    repositoryFiles:",
      "      security: true",
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
  let activeScan = null;
  let isLoading = false;

  const SETTING_LABELS = {
    "repositoryFiles.readme": "README file",
    "repositoryFiles.license": "License file",
    "repositoryFiles.contributing": "Contribution guide",
    "repositoryFiles.codeOfConduct": "Code of conduct",
    "repositoryFiles.security": "Security policy",
    "repositoryFiles.citation": "Citation metadata",
    "workflowSecurity.leastPrivilegeToken": "Minimal Actions token permissions",
    "workflowSecurity.pinnedActions": "Actions pinned to full commit SHAs",
    "workflowSecurity.dependencyReview": "Dependency review on pull requests",
    "repositoryRules.activeRuleset": "At least one active repository ruleset",
    privateVulnerabilityReporting: "Private vulnerability reporting",
  };

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

  async function streamRequest(path, body, onEvent) {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
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
      throw new Error((payload && payload.error) || "Request failed (" + response.status + ").");
    }

    if (!response.body) throw new Error("The scan response did not include a progress stream.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let complete = false;

    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        onEvent(event);
        if (event.type === "complete") complete = true;
        if (event.type === "error") throw new Error(event.error || "The scan could not be completed.");
      }

      if (chunk.done) break;
    }

    if (buffer.trim()) {
      const event = JSON.parse(buffer);
      onEvent(event);
      if (event.type === "complete") complete = true;
      if (event.type === "error") throw new Error(event.error || "The scan could not be completed.");
    }

    if (!complete) throw new Error("The scan ended before returning its results.");
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
      const settingName = SETTING_LABELS[check.setting] || check.setting;
      const setting = check.branch ? settingName + " (" + check.branch + ")" : settingName;
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
        tile("Drifted on page", totals.drifted, "fail"),
        tile("Compliant on page", totals.compliant, "pass"),
        tile("Unknown on page", totals.unknown, "unknown"),
        tile("Fix commands on page", totals.remediationSteps, "neutral"),
      ]),
    ]);
    const scope = report.scope;
    let coverage = "Page " + scope.page + ": scanned " + scope.scannedRepositories +
      " matching repositories (" + scope.listedRepositories + " listed).";
    if (scope.hasNextPage) coverage += " More repositories are available on the next page.";
    results.appendChild(el("p", "muted", coverage));
    if (!report.repositories.length && !report.failures.length)
      results.appendChild(el("p", "", scope.hasNextPage
        ? "No public repository matched these rules on this page. Continue to the next page to scan more."
        : "No public repository matched these rules."));
    for (const repo of report.repositories) results.appendChild(repoCard(repo));
    for (const failure of report.failures)
      results.appendChild(el("p", "form-status", failure.repository + ": " + failure.error));
    if (report.repositories.some((repo) => repo.counts.unknown))
      results.appendChild(el("p", "muted", "Hidden values are settings GitHub only shows to repository administrators. The suggested commands still set them safely."));
    if (scope.page > 1 || scope.hasNextPage) {
      const navigation = el("nav", "button-row");
      navigation.setAttribute("aria-label", "Repository pages");
      if (scope.page > 1) {
        const previous = el("button", "button-secondary button-small", "Previous page");
        previous.type = "button";
        previous.addEventListener("click", () => loadPage(scope.page - 1));
        navigation.appendChild(previous);
      }
      navigation.appendChild(el("span", "muted", "GitHub repository page " + scope.page));
      if (scope.hasNextPage) {
        const next = el("button", "button-secondary button-small", "Next page");
        next.type = "button";
        next.addEventListener("click", () => loadPage(scope.page + 1));
        navigation.appendChild(next);
      }
      results.appendChild(navigation);
    }
  }

  async function loadPage(page) {
    if (!activeScan || isLoading) return;
    isLoading = true;
    say("Checking repository page " + page + "…");
    results.setAttribute("aria-busy", "true");
    const progress = el("p", "muted", "Connecting to GitHub…");
    results.replaceChildren(el("h2", "panel-title", "Results"), progress);
    try {
      await streamRequest("/app/api/drift", {
        owner: activeScan.owner,
        policy: activeScan.policy,
        page,
      }, (event) => {
        if (event.type === "progress") {
          progress.textContent = "Checked " + event.completed + " of " + event.total + " matching repositories on page " + page + ".";
          if (event.result && event.result.checks)
            results.appendChild(repoCard(event.result));
          else if (event.result && event.result.error)
            results.appendChild(el("p", "form-status", event.result.repository + ": " + event.result.error));
        } else if (event.type === "complete") {
          render(event.report);
          say("Repository page " + event.report.scope.page + " checked.", event.report.status === "compliant" ? "ok" : "");
        }
      });
    } catch (error) {
      say(error.message, "error");
    } finally {
      results.setAttribute("aria-busy", "false");
      isLoading = false;
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isLoading) return;
    activeScan = { owner: owner.value.trim(), policy: policy.value };
    await loadPage(1);
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
