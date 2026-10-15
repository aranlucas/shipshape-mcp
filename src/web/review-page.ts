import { escapeHtml } from "../oauth-security";
import { STYLES_PATH } from "../styles";

export function renderReviewPage(login: string): string {
  const user = escapeHtml(login);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="Review repository evidence and proposed next steps before making changes.">
    <link rel="stylesheet" href="${STYLES_PATH}"><title>Repository review — Shipshape</title>
  </head>
  <body>
    <main class="site-shell app-shell" data-login="${user}">
      <header class="masthead">
        <a class="wordmark" href="/">Shipshape <span>/ Review</span></a>
        <div class="account"><span class="muted">Signed in as <strong>@${user}</strong></span>
          <form method="post" action="/app/logout"><button class="button-secondary button-small" type="submit">Sign out</button></form>
        </div>
      </header>
      <nav class="review-nav" aria-label="Dashboard"><a href="/app/review" aria-current="page">Repository review</a><a href="/app">Settings drift</a></nav>
      <section class="app-intro">
        <p class="eyebrow">Evidence before changes</p>
        <h1 class="app-title">Your repository review desk.</h1>
        <p class="lead">Inspect standards, pull requests, dependency groups, cleanup questions and repository purpose. Review what was observed, what remains unknown, and the proposed next step.</p>
        <p class="permission-note">Read-only, public repositories. Nothing here changes code, merges a PR or removes a file. Proposals need your approval. Private repositories are outside this connection’s scope.</p>
      </section>
      <form id="review-form" class="panel review-owner">
        <label class="field"><span>GitHub owner</span><input name="owner" value="${user}" autocomplete="off" spellcheck="false" required maxlength="39"></label>
        <button class="button-primary" type="submit">Load repositories</button>
      </form>
      <p id="review-status" class="form-status" role="status"></p>
      <div class="review-layout">
        <aside class="panel" aria-label="Repositories">
          <h2 class="panel-title">Repositories</h2>
          <p class="muted">Choose a repository to inspect it. Listing alone does not run checks. Forks and archived repositories are exempt.</p>
          <div id="review-repositories"></div><div id="review-pages" class="button-row"></div>
        </aside>
        <section class="panel review-workspace" aria-labelledby="review-heading">
          <h2 id="review-heading" class="panel-title">Review queue</h2>
          <p id="review-summary" class="muted">No repositories inspected yet.</p>
          <div class="review-filters">
            <label class="field"><span>Repository</span><select id="review-repo-filter"><option value="">All inspected</option></select></label>
            <label class="field"><span>Category</span><select id="review-category"><option value="">All categories</option><option value="standards">Standards</option><option value="pull_requests">Pull requests</option><option value="dependencies">Dependencies</option><option value="cleanup">Cleanup</option><option value="health">Repository purpose</option></select></label>
            <label class="field"><span>State</span><select id="review-state"><option value="">All states</option><option value="needs_review">Needs review</option><option value="unknown">Unknown / not checked</option><option value="observed">Observed</option><option value="not_applicable">Exempt</option></select></label>
          </div>
          <div id="review-findings" aria-live="polite" aria-busy="false"><p class="muted">Select Inspect beside a repository to collect its evidence. No health score is inferred from missing checks.</p></div>
        </section>
      </div>
    </main>
    <script src="/app/review.js" defer></script>
  </body>
</html>`;
}
