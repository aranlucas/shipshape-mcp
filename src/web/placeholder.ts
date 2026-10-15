import { escapeHtml } from "../oauth-security";
import { STYLES_PATH } from "../styles";

const HEAD = `<meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="Personal engineering practices across every repository.">
    <link rel="stylesheet" href="${STYLES_PATH}">`;

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
