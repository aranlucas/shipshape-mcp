import { securityHeaders } from "./oauth-security";
import { SHIPSHAPE_CSS, STYLES_PATH } from "./styles";

const HEAD = `<meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="${STYLES_PATH}">`;

const LANDING_PAGE = `<!doctype html>
<html lang="en">
  <head>
    ${HEAD}
    <meta name="description" content="Read-only, evidence-backed GitHub maintenance priorities over MCP.">
    <title>Shipshape MCP — know what to fix next</title>
  </head>
  <body>
    <main class="site-shell">
      <header class="masthead">
        <a class="wordmark" href="/">Shipshape <span>/ MCP</span></a>
        <nav aria-label="Service links"><ul class="nav-list"><li><a href="/privacy">Privacy</a></li><li><a href="/health">Health</a></li></ul></nav>
      </header>
      <section class="hero">
        <p class="eyebrow">Repository intelligence, without the guesswork</p>
        <h1>Know what to fix next.</h1>
        <p class="lead">Shipshape turns public GitHub evidence into a small, ranked maintenance queue. It reads; it never pushes, edits, clones, or executes a repository.</p>
        <div class="endpoint"><span class="status-dot" aria-hidden="true"></span><code>shipshape-mcp.aranlucas.workers.dev/mcp</code></div>
      </section>
      <section class="signal-grid" aria-label="Design principles">
        <article class="signal"><span class="signal-number">01 / READ ONLY</span><h2>Safe by construction</h2><p>One narrow GitHub OAuth scope, public repositories only, and a client with no mutation method.</p></article>
        <article class="signal"><span class="signal-number">02 / REPRODUCIBLE</span><h2>Rules, not vibes</h2><p>Stable checks and fixed weights make every score explainable and every recommendation traceable.</p></article>
        <article class="signal"><span class="signal-number">03 / HONEST</span><h2>Unknown stays unknown</h2><p>Permission- and plan-gated evidence never quietly becomes a passing security signal.</p></article>
      </section>
      <section class="tools">
        <p class="section-label">Six focused tools</p>
        <div class="tool-grid">
          <article class="tool"><h3>portfolio_snapshot</h3><p>Find recently active public repositories that most need attention.</p></article>
          <article class="tool"><h3>repo_readiness</h3><p>Audit publication, branch, delivery, and security signals together.</p></article>
          <article class="tool"><h3>branch_risk</h3><p>Inspect the protections around a branch before follow-up work begins.</p></article>
          <article class="tool"><h3>delivery_hygiene</h3><p>Summarize recent commits, pull requests, and workflow health.</p></article>
          <article class="tool"><h3>security_posture</h3><p>Normalize code, dependency, and secret-scanning evidence.</p></article>
          <article class="tool"><h3>action_plan</h3><p>Turn failed and unknown checks into a bounded maintenance queue.</p></article>
        </div>
      </section>
      <footer class="site-footer"><span>Built on Cloudflare Workers.</span><span>Public evidence in. Concrete next steps out.</span></footer>
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
      <p>Shipshape uses GitHub OAuth to identify you and make authorized, read-only requests about public repositories. It requests <code>read:user</code>; it does not request the broad <code>repo</code> scope.</p>
      <p>OAuth access tokens are stored only in encrypted authorization properties. They are never put in URLs, logs, tool output, or rendered pages.</p>
      <p>Short-lived OAuth state and grants are stored in Cloudflare KV. You can revoke access from GitHub or your MCP client. Shipshape does not sell personal information and does not clone or execute repository code.</p>
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
  if (request.method !== "GET") return methodNotAllowed();

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

export function landingPageResponse(): Response {
  return htmlResponse(LANDING_PAGE);
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
  return new Response(SHIPSHAPE_CSS, { status: 200, headers });
}

export function notFoundResponse(): Response {
  return htmlResponse(NOT_FOUND_PAGE, 404);
}

export function methodNotAllowed(): Response {
  const headers = securityHeaders();
  headers.set("Allow", "GET");
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
