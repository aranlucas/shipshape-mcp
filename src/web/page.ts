import { escapeHtml } from "../oauth-security";
import { STYLES_PATH } from "../styles";

const HEAD = `<meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="Check GitHub repository settings against declarative rules.">
    <link rel="stylesheet" href="${STYLES_PATH}">`;

export function renderSignInPage(message?: string): string {
  const notice = message
    ? `<p class="permission-note" role="alert">${escapeHtml(message)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>${HEAD}<title>Sign in — Shipshape Rules</title></head>
  <body>
    <main class="consent-shell">
      <section class="consent-card">
        <div class="brand-row"><a class="wordmark" href="/">Shipshape <span>/ Rules</span></a><span class="eyebrow">Read only</span></div>
        <h1>Keep every repository in shape.</h1>
        <p>Write rules for repository settings, community files, GitHub Actions security, and branch protection. Shipshape checks your public repositories and shows the changes needed to address drift.</p>
        ${notice}
        <p class="permission-note">GitHub permission: <code>read:user</code>. Shipshape reads public repositories and never changes them.</p>
        <div class="button-row"><a class="button-link button-primary" href="/app/login">Continue with GitHub</a></div>
        <p class="legal-links"><a href="/privacy">Privacy</a></p>
      </section>
    </main>
  </body>
</html>`;
}

export function renderAppPage(login: string): string {
  const user = escapeHtml(login);

  return `<!doctype html>
<html lang="en">
  <head>${HEAD}<title>Settings drift — Shipshape Rules</title></head>
  <body>
    <main class="site-shell app-shell" data-login="${user}">
      <header class="masthead">
        <a class="wordmark" href="/">Shipshape <span>/ Rules</span></a>
        <div class="account">
          <span class="muted">Signed in as <strong>@${user}</strong></span>
          <form method="post" action="/app/logout"><button class="button-secondary button-small" type="submit">Sign out</button></form>
        </div>
      </header>
      <section class="app-intro">
        <p class="eyebrow">Settings drift</p>
        <h1 class="app-title">Rules in, fixes out.</h1>
      <p class="lead">Describe the settings and practices your repositories should follow. Shipshape checks public repository settings, recognized community files, and GitHub Actions workflows.</p>
      </section>
      <div class="app-grid">
        <form id="drift-form" class="panel" novalidate>
          <h2 class="panel-title">Policy</h2>
          <div class="field-row">
            <label class="field"><span>Owner</span><input name="owner" value="${user}" autocomplete="off" spellcheck="false" required maxlength="39"></label>
          </div>
          <p class="muted">Scan the owner’s repositories one GitHub page at a time. Use the results controls to continue; there is no total repository limit.</p>
          <label class="field"><span>Rules (YAML)</span><textarea name="policy" rows="22" spellcheck="false" autocomplete="off" required></textarea></label>
          <p class="muted">The full starter includes every built-in best-practice check; team review controls stay optional. Loading it replaces the YAML in this editor.</p>
          <div class="button-row">
            <button id="load-starter" class="button-secondary" type="button">Load full starter</button>
          </div>
          <div class="field-row preset-row">
            <label class="field"><span>Add a preset rule</span>
              <select id="preset">
                <option value="squash">Squash merges only</option>
                <option value="protect">Protect the default branch</option>
                <option value="review">Team review controls</option>
                <option value="signatures">Require signed commits</option>
                <option value="security">Security analysis on</option>
                <option value="onboarding">Repository health files</option>
                <option value="workflows">Harden GitHub Actions</option>
                <option value="vulnerability">Vulnerability reporting</option>
                <option value="rulesets">Active repository ruleset</option>
                <option value="tidy">Tidy repository features</option>
              </select>
            </label>
            <button id="add-preset" class="button-secondary" type="button">Add</button>
          </div>
          <div class="button-row">
            <button class="button-primary" type="submit">Check drift</button>
            <button id="save-rules" class="button-secondary" type="button">Save rules</button>
            <button id="download-rules" class="button-secondary" type="button">Download YAML</button>
          </div>
          <p id="form-status" class="form-status" role="status"></p>
          <details>
            <summary>Rule reference</summary>
            <p>Each rule has an <code>id</code>, optional <code>repositories</code> globs (<code>include</code>, <code>exclude</code>, <code>forks</code>, <code>archived</code>), and any of <code>merge</code>, <code>features</code>, <code>topics</code>, <code>security</code>, <code>repositoryFiles</code>, <code>workflowSecurity</code>, <code>repositoryRules</code>, and <code>branchProtection</code>. See the <a href="https://github.com/aranlucas/shipshape-mcp/blob/main/docs/settings-drift.md">settings drift guide</a>.</p>
          </details>
          <details>
            <summary>Coverage and limits</summary>
            <p>Scans paginate through public repositories and check settings, repository files, GitHub Actions workflows, and active rulesets. Dependabot alert status and code scanning setup need broader GitHub permissions than <code>read:user</code>, so review those in each repository’s Security settings. Workflow checks inspect YAML without running it.</p>
          </details>
        </form>
        <section id="results" class="panel results" aria-live="polite" aria-busy="false">
          <h2 class="panel-title">Results</h2>
          <p class="muted">Run a check to see which repositories match your rules.</p>
        </section>
      </div>
    </main>
    <script src="/app/app.js" defer></script>
  </body>
</html>`;
}
