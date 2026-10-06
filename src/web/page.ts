import { escapeHtml } from "../oauth-security";
import { MAX_SETTINGS_DRIFT_REPOSITORIES } from "../drift/limits";
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
        <p>Write rules for merge strategy, features, topics, security analysis, and branch protection. Shipshape checks your public repositories against them and hands you the exact commands to fix any drift.</p>
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
        <p class="lead">Describe the settings your repositories should have. Shipshape checks the public ones and lists the <code>gh api</code> commands that would bring each back in line.</p>
      </section>
      <div class="app-grid">
        <form id="drift-form" class="panel" novalidate>
          <h2 class="panel-title">Policy</h2>
          <div class="field-row">
            <label class="field"><span>Owner</span><input name="owner" value="${user}" autocomplete="off" spellcheck="false" required maxlength="39"></label>
            <label class="field field-narrow"><span>Repositories</span><input name="limit" type="number" min="1" max="${MAX_SETTINGS_DRIFT_REPOSITORIES}" value="10" required></label>
          </div>
          <label class="field"><span>Rules (YAML)</span><textarea name="policy" rows="22" spellcheck="false" autocomplete="off" required></textarea></label>
          <div class="field-row preset-row">
            <label class="field"><span>Add a preset rule</span>
              <select id="preset">
                <option value="squash">Squash merges only</option>
                <option value="protect">Protect the default branch</option>
                <option value="review">Stronger pull request reviews</option>
                <option value="signatures">Require signed commits</option>
                <option value="security">Security analysis on</option>
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
            <p>Each rule has an <code>id</code>, optional <code>repositories</code> globs (<code>include</code>, <code>exclude</code>, <code>forks</code>, <code>archived</code>), and any of <code>merge</code>, <code>features</code>, <code>topics</code>, <code>security</code>, and <code>branchProtection</code>. See the <a href="https://github.com/aranlucas/shipshape-mcp/blob/main/docs/settings-drift.md">settings drift guide</a>.</p>
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
