import { securityHeaders } from "./oauth-security";
import { APP_CSS, STYLES_PATH } from "./styles";

const HEAD = `<meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="${STYLES_PATH}">`;

const LANDING_PAGE = `<!doctype html>
<html lang="en">
  <head>
    ${HEAD}
    <meta name="description" content="Shipshape checks Lucas's engineering practices across his repositories.">
    <title>Shipshape — personal engineering practices</title>
  </head>
  <body>
    <main class="site-shell">
      <header class="masthead">
        <a class="wordmark" href="/">Shipshape <span>/ MCP</span></a>
        <nav aria-label="Service links"><ul class="nav-list"><li><a href="/app">Dashboard</a></li><li><a href="/privacy">Privacy</a></li><li><a href="/health">Health</a></li></ul></nav>
      </header>
      <section class="hero">
        <p class="eyebrow">Personal engineering practices</p>
        <h1>Keep every repository in practice.</h1>
        <p class="lead">Shipshape checks Lucas's engineering practices across his repositories.</p>
        <div class="endpoint"><span class="status-dot" aria-hidden="true"></span><code>shipshape-mcp.aranlucas.workers.dev/mcp</code></div>
        <p class="lead">Ready to see the results? <a href="/app">Sign in with GitHub</a>.</p>
      </section>
      <section class="signal-grid" aria-label="Design principles">
        <article class="signal"><span class="signal-number">01 / COVERAGE</span><h2>Every repository</h2><p>One GitHub App keeps the repository inventory current across personal and organization installations.</p></article>
        <article class="signal"><span class="signal-number">02 / PRACTICES</span><h2>Rules you can inspect</h2><p>Practice definitions live in a catalog repository as readable YAML and canonical files.</p></article>
        <article class="signal"><span class="signal-number">03 / EVIDENCE</span><h2>Unknown stays unknown</h2><p>Results retain the evidence state when a repository feature cannot be read.</p></article>
      </section>
      <section class="tools">
        <p class="section-label">Practice checks</p>
        <div class="tool-grid">
          <article class="tool"><h3>Files</h3><p>Compare repository files with canonical practice content.</p></article>
          <article class="tool"><h3>Workflows</h3><p>Inspect workflow permissions, pinned actions, and dependency review.</p></article>
          <article class="tool"><h3>Dependencies</h3><p>Check exact dependency declarations in package manifests.</p></article>
          <article class="tool"><h3>Repository settings</h3><p>Read merge, security, and feature settings from GitHub.</p></article>
          <article class="tool"><h3>Branch protection</h3><p>Read required branch safeguards from the default branch.</p></article>
          <article class="tool"><h3>Applicability</h3><p>Target practices by owner, language, files, and repository name.</p></article>
          <article class="tool"><h3>Catalog</h3><p>Load practice definitions from a versioned Git repository.</p></article>
          <article class="tool"><h3>Results</h3><p>Keep pass, fail, unknown, and not-applicable states visible.</p></article>
        </div>
      </section>
      <footer class="site-footer"><span>Built on Cloudflare Workers.</span><span>Engineering practices in. Clear results out.</span></footer>
    </main>
  </body>
</html>`;

const PRIVACY_PAGE = `<!doctype html>
<html lang="en">
  <head>${HEAD}<title>Privacy — Shipshape MCP</title></head>
  <body>
    <main class="consent-shell"><article class="legal-page">
      <a class="wordmark" href="/">Shipshape <span>/ MCP</span></a>
      <h1>Privacy, in plain language.</h1>
      <p>Shipshape uses the GitHub App OAuth flow to identify Lucas and protect the dashboard and MCP. GitHub App installation tokens read every repository the App can access, including private and organization repositories.</p>
      <p>The user token used to identify the account is not stored. The dashboard session stores only the GitHub login and numeric user id in an encrypted, HttpOnly cookie-backed session.</p>
      <p>Short-lived OAuth state and grants are stored in Cloudflare KV. You can revoke the App installation or MCP client authorization from GitHub.</p>
      <p>Shipshape does not sell personal information and does not clone or execute repository code.</p>
      <p><a href="/">Return to Shipshape MCP</a></p>
    </article></main>
  </body>
</html>`;

const NOT_FOUND_PAGE = `<!doctype html>
<html lang="en">
  <head>${HEAD}<title>Not found — Shipshape MCP</title></head>
  <body><main class="consent-shell"><article class="legal-page"><a class="wordmark" href="/">Shipshape <span>/ MCP</span></a><h1>Off the chart.</h1><p>The requested page does not exist.</p><p><a href="/">Return to safe harbor</a></p></article></main></body>
</html>`;

export function landingHandler(request: Request): Response {
  const url = new URL(request.url);

  if (request.method !== "GET") {
    return methodNotAllowed();
  }

  switch (url.pathname) {
    case "/":
      return htmlResponse(LANDING_PAGE);
    case "/privacy":
      return htmlResponse(PRIVACY_PAGE);
    case "/health":
      return healthResponse();
    case STYLES_PATH:
      return stylesheetResponse();
    default:
      return notFoundResponse();
  }
}

export function privacyPageResponse(): Response {
  return htmlResponse(PRIVACY_PAGE);
}

export function healthResponse(): Response {
  const headers = securityHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");

  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers,
  });
}

export function stylesheetResponse(): Response {
  const headers = securityHeaders();
  headers.set("Content-Type", "text/css; charset=utf-8");
  headers.set("Cache-Control", "public, max-age=86400");

  return new Response(APP_CSS, { status: 200, headers });
}

export function notFoundResponse(): Response {
  return htmlResponse(NOT_FOUND_PAGE, 404);
}

export function methodNotAllowed(allow = "GET"): Response {
  const headers = securityHeaders();
  headers.set("Allow", allow);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "no-store");

  return new Response("Method not allowed", { status: 405, headers });
}

function htmlResponse(body: string, status = 200): Response {
  const headers = securityHeaders();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");

  return new Response(body, { status, headers });
}
