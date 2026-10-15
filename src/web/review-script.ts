/** All provider content is rendered as text, never HTML. No repository writes are exposed. */
export const REVIEW_SCRIPT = String.raw`"use strict";
(() => {
  const form = document.getElementById("review-form");
  const owner = form.elements.namedItem("owner");
  const status = document.getElementById("review-status");
  const repositories = document.getElementById("review-repositories");
  const pages = document.getElementById("review-pages");
  const findings = document.getElementById("review-findings");
  const summary = document.getElementById("review-summary");
  const repoFilter = document.getElementById("review-repo-filter");
  const category = document.getElementById("review-category");
  const state = document.getElementById("review-state");
  const reports = new Map();
  const labels = { needs_review: "Needs review", observed: "Observed", unknown: "Unknown / not checked", not_applicable: "Exempt" };
  const categories = { standards: "Standards", pull_requests: "Pull requests", dependencies: "Dependencies", cleanup: "Cleanup", health: "Repository purpose" };
  let listing = null;
  let activeOwner = "";
  let busy = false;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function link(url, label) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) return el("span", "", label + " (link unavailable)");
      const node = el("a", "", label);
      node.href = parsed.href;
      node.target = "_blank";
      node.rel = "noopener noreferrer";
      return node;
    } catch { return el("span", "", label + " (link unavailable)"); }
  }
  function say(text, error) {
    status.textContent = text;
    status.dataset.tone = error ? "error" : "";
  }
  function setBusy(value) {
    busy = value;
    form.querySelector("button").disabled = value;
    owner.disabled = value;
    for (const button of document.querySelectorAll("#review-repositories button, #review-pages button")) button.disabled = value;
    findings.setAttribute("aria-busy", String(value));
  }
  async function get(path, params) {
    const response = await fetch(path + "?" + new URLSearchParams(params).toString(), { credentials: "same-origin", headers: { Accept: "application/json" } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Request failed (" + response.status + ").");
    return payload;
  }
  function button(label, action) {
    const node = el("button", "button-secondary button-small", label);
    node.type = "button";
    node.disabled = busy;
    node.addEventListener("click", action);
    return node;
  }
  function renderRepositories() {
    repositories.replaceChildren();
    pages.replaceChildren();
    if (!listing) return;
    if (!listing.repositories.length) repositories.appendChild(el("p", "muted", "No public repositories on this page."));
    for (const repo of listing.repositories) {
      const row = el("div", "review-repo");
      row.appendChild(link(repo.url, repo.name));
      const report = reports.get(repo.repository);
      row.appendChild(el("span", "muted", report ? "Inspected" : "Not checked"));
      row.appendChild(button(report ? "Refresh" : "Inspect", () => inspect(repo)));
      if (report) row.appendChild(button("View", () => { repoFilter.value = repo.repository; renderFindings(); }));
      if (repo.fork || repo.archived) row.appendChild(el("small", "muted", repo.fork ? "Fork · exempt" : "Archived · exempt"));
      repositories.appendChild(row);
    }
    pages.appendChild(el("span", "muted", "Page " + listing.page));
    if (listing.page > 1) pages.appendChild(button("Previous", () => loadPage(listing.page - 1)));
    if (listing.hasNextPage) pages.appendChild(button("Next", () => loadPage(listing.page + 1)));
  }
  function renderRepoFilter() {
    const selected = repoFilter.value;
    repoFilter.replaceChildren();
    const all = el("option", "", "All inspected");
    all.value = "";
    repoFilter.appendChild(all);
    for (const name of [...reports.keys()].sort()) {
      const option = el("option", "", name);
      option.value = name;
      repoFilter.appendChild(option);
    }
    repoFilter.value = reports.has(selected) ? selected : "";
  }
  function detail(list, title, text) {
    list.appendChild(el("dt", "", title));
    list.appendChild(el("dd", "", text));
  }
  function card(item, report) {
    const node = el("article", "review-card review-" + item.state);
    const meta = el("div", "review-card-meta");
    meta.appendChild(el("span", "pill pill-" + (item.state === "needs_review" ? "fail" : item.state === "unknown" ? "unknown" : "pass"), labels[item.state] || item.state));
    meta.appendChild(el("span", "muted", categories[item.category] + " · " + item.priority + " priority · " + item.confidence + " confidence"));
    node.appendChild(meta);
    node.appendChild(el("h3", "", item.title));
    node.appendChild(el("p", "review-repo-label", item.repository));
    const list = el("dl", "review-detail");
    detail(list, "Observed", item.current);
    detail(list, "Desired", item.desired);
    detail(list, "Proposed next step", item.nextStep);
    node.appendChild(list);
    const evidence = el("ul", "review-evidence");
    for (const reference of item.evidence) {
      const row = el("li");
      row.appendChild(link(reference.url, reference.label));
      if (reference.detail) row.appendChild(el("span", "muted", " · " + reference.detail));
      evidence.appendChild(row);
    }
    if (!item.evidence.length) evidence.appendChild(el("li", "muted", "No direct evidence available; this item needs verification."));
    node.appendChild(evidence);
    node.appendChild(el("p", "review-stamp", "Collected " + report.collectedAt + (item.approvalRequired ? " · Changes need approval" : " · Read-only observation")));
    return node;
  }
  function renderFindings() {
    findings.replaceChildren();
    const all = [...reports.values()];
    const total = all.flatMap((report) => report.findings);
    summary.textContent = reports.size + " repositories inspected · " + total.filter((item) => item.state === "needs_review").length + " need review · " + total.filter((item) => item.state === "unknown").length + " unknown. Counts describe findings, not repository health.";
    let visible = 0;
    for (const report of all) {
      if (repoFilter.value && report.repository !== repoFilter.value) continue;
      const items = report.findings.filter((item) => (!category.value || item.category === category.value) && (!state.value || item.state === state.value));
      if (!items.length) continue;
      visible += items.length;
      const group = el("section", "review-group");
      const heading = el("h3", "review-group-title");
      heading.appendChild(link(report.url, report.repository));
      group.appendChild(heading);
      const stamp = el("p", "muted", "Collected " + report.collectedAt + ". ");
      if (report.commit) stamp.appendChild(link(report.url + "/tree/" + encodeURIComponent(report.commit), "Default branch " + report.commit.slice(0, 12)));
      else stamp.appendChild(el("span", "", "Default-branch commit not inspected."));
      group.appendChild(stamp);
      const coverage = el("details", "review-coverage");
      coverage.appendChild(el("summary", "", "Coverage and limits"));
      const limits = el("ul", "notes");
      for (const limitation of report.limitations) limits.appendChild(el("li", "", limitation));
      coverage.appendChild(limits);
      group.appendChild(coverage);
      const order = { needs_review: 0, unknown: 1, observed: 2, not_applicable: 3 };
      for (const item of items.toSorted((a, b) => order[a.state] - order[b.state] || a.id.localeCompare(b.id))) group.appendChild(card(item, report));
      findings.appendChild(group);
    }
    if (!visible) findings.appendChild(el("p", "muted", reports.size ? "No findings match these filters. Other categories may still contain unknown or uninspected checks." : "Select Inspect beside a repository to collect its evidence."));
  }
  async function loadPage(page, requestedOwner = activeOwner) {
    if (busy) return;
    setBusy(true);
    say("Loading public repositories, page " + page + "…");
    try {
      const result = await get("/app/api/review/repos", { owner: requestedOwner, page: String(page) });
      if (activeOwner !== result.owner.toLowerCase()) {
        reports.clear();
        renderRepoFilter();
        renderFindings();
      }
      activeOwner = result.owner.toLowerCase();
      owner.value = result.owner;
      listing = result;
      renderRepositories();
      say("Page " + result.page + " loaded. Choose Inspect to collect repository evidence.");
    } catch (error) { say(error.message, true); }
    finally { setBusy(false); }
  }
  async function inspect(repo) {
    if (busy) return;
    setBusy(true);
    say("Inspecting " + repo.repository + ". Collecting bounded, read-only evidence…");
    try {
      const report = await get("/app/api/review/repository", { owner: repo.owner, repo: repo.name });
      reports.set(report.repository, report);
      renderRepoFilter();
      repoFilter.value = report.repository;
      renderFindings();
      renderRepositories();
      say("Review ready for " + report.repository + ". Check unknown items and coverage before deciding on changes.");
    } catch (error) { say(error.message + " No new report was saved; any previous report retains its original observation time.", true); }
    finally { setBusy(false); }
  }
  form.addEventListener("submit", (event) => { event.preventDefault(); loadPage(1, owner.value.trim()); });
  for (const control of [repoFilter, category, state]) control.addEventListener("change", renderFindings);
})();
`;
