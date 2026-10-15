import { escapeHtml } from "../oauth-security";
import { STYLES_PATH } from "../styles";

const HEAD = `<meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="Personal engineering practices across every repository.">
    <link rel="stylesheet" href="${STYLES_PATH}">`;

export function renderSignInPage(message?: string): string {
  const notice = message
    ? `<p class="permission-note" role="alert">${escapeHtml(message)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>${HEAD}<title>Sign in — Shipshape</title></head>
  <body>
    <main class="consent-shell">
      <section class="consent-card">
        <div class="brand-row"><a class="wordmark" href="/">Shipshape <span>/ Practices</span></a><span class="eyebrow">GitHub App identity</span></div>
        <h1>Keep every repository in practice.</h1>
        <p>Shipshape checks Lucas's engineering practices across his repositories.</p>
        ${notice}
        <p class="permission-note">GitHub permission: identity only. Repository reads use GitHub App installation tokens, and your user token is never stored.</p>
        <div class="button-row"><a class="button-link button-primary" href="/app/login">Continue with GitHub</a></div>
        <p class="legal-links"><a href="/privacy">Privacy</a></p>
      </section>
    </main>
  </body>
</html>`;
}

export function renderPlaceholderPage(login: string): string {
  const user = escapeHtml(login);

  return `<!doctype html>
<html lang="en">
  <head>${HEAD}<title>Dashboard — Shipshape</title></head>
  <body>
    <main class="site-shell app-shell" data-login="${user}">
      <header class="masthead">
        <a class="wordmark" href="/">Shipshape <span>/ Practices</span></a>
        <div class="account">
          <span class="muted">Signed in as <strong>@${user}</strong></span>
          <form method="post" action="/app/logout"><button class="button-secondary button-small" type="submit">Sign out</button></form>
        </div>
      </header>
      <section class="app-intro">
        <p class="eyebrow">Personal practices</p>
        <h1 class="app-title">Your dashboard is on its way.</h1>
        <p class="lead">The new dashboard is being built. Practice results are available at /app/api/overview.</p>
      </section>
    </main>
  </body>
</html>`;
}
