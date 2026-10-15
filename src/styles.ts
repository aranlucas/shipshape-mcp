export const STYLES_PATH = "/assets/shipshape.css" as const;

/**
 * Styles for the few server-rendered pages (landing, sign-in, MCP consent,
 * privacy, 404). The dashboard bundle in src/ui uses the same chart palette.
 */
export const APP_CSS = `
:root {
  color-scheme: light;
  --paper: #fbfcfd;
  --shoal-soft: #eef4f8;
  --ink: #0e2a3b;
  --sounding: #5c7586;
  --rule: #c9d7e1;
  --hazard: #c2187f;
  --focus: #1f6fb2;
  font-family: "Overpass Variable", "Overpass", system-ui, -apple-system, "Segoe UI", sans-serif;
  line-height: 1.5;
  color: var(--ink);
  background: var(--paper);
}

* { box-sizing: border-box; }
body { margin: 0; }
h1, h2, p { margin: 0; text-wrap: pretty; }
a { color: inherit; text-decoration-thickness: 1px; text-underline-offset: 0.2em; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
code { font-family: "Overpass Mono", ui-monospace, monospace; font-size: 0.92em; overflow-wrap: anywhere; }

.site-shell { width: min(44rem, calc(100% - 2rem)); margin-inline: auto; padding: 1.25rem 0 3rem; }
.masthead { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; }
.wordmark { font-size: 1.125rem; font-weight: 800; letter-spacing: -0.01em; text-decoration: none; }
.wordmark span { color: var(--sounding); font-weight: 400; }
.nav-list { display: flex; gap: 1.25rem; margin: 0; padding: 0; list-style: none; font-size: 0.875rem; }
.nav-list a { color: var(--sounding); text-decoration: none; }
.nav-list a:hover { color: var(--ink); }

.hero { padding: clamp(4rem, 12vw, 8rem) 0 3rem; }
.hero h1 { font-size: clamp(2.25rem, 6vw, 3.5rem); font-weight: 600; letter-spacing: -0.025em; line-height: 1.08; }
.lead { max-width: 38rem; margin-top: 1.25rem; color: var(--sounding); font-size: 1.125rem; }
.endpoint { display: inline-block; margin-top: 2rem; padding: 0.45rem 0.75rem; border: 1px solid var(--rule); border-radius: 4px; background: #fff; font-size: 0.875rem; }
.site-footer { padding-top: 1rem; border-top: 1px solid var(--rule); color: var(--sounding); font-size: 0.8125rem; }

.consent-shell { display: grid; min-height: 100vh; place-items: center; padding: 2rem 1rem; }
.consent-card, .legal-page { width: min(34rem, 100%); }
.consent-card { padding: clamp(1.5rem, 5vw, 2.25rem); border: 1px solid var(--rule); border-top: 3px solid var(--ink); background: #fff; }
.brand-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.eyebrow { color: var(--sounding); font-size: 0.8125rem; }
.consent-card h1, .legal-page h1 { margin-top: 1.75rem; font-size: clamp(1.75rem, 5vw, 2.25rem); font-weight: 600; letter-spacing: -0.02em; line-height: 1.15; }
.consent-card p, .consent-card li, .legal-page p { margin-top: 0.9rem; color: var(--sounding); }
.legal-page { padding: clamp(2rem, 8vw, 5rem) 0; }
.scope-list { margin: 0.9rem 0 0; padding-left: 1.25rem; }
.scope-list code { color: var(--ink); }
.permission-note { padding: 0.7rem 0.9rem; border-left: 3px solid var(--rule); background: var(--shoal-soft); }
.permission-note[role="alert"] { border-left-color: var(--hazard); background: #fbe9f3; color: var(--ink); }
.legal-links { font-size: 0.8125rem; }
.muted { color: var(--sounding); }

.button-row { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1.75rem; }
button, .button-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 2.5rem;
  padding: 0.5rem 1rem;
  border: 1px solid var(--ink);
  border-radius: 6px;
  background: var(--paper);
  color: var(--ink);
  font: inherit;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}
.button-primary { background: var(--ink); color: var(--paper); }
.button-primary:hover { background: #1a3d52; }
.button-secondary { border-color: var(--rule); }
.button-small { min-height: 2rem; padding: 0.25rem 0.7rem; font-size: 0.8125rem; }

.app-shell { width: min(44rem, calc(100% - 2rem)); margin-inline: auto; padding: 1.25rem 0 3rem; }
.account { display: flex; align-items: center; gap: 0.75rem; font-size: 0.875rem; }
.account form { margin: 0; }
.app-intro { padding: 4rem 0 2rem; }
.app-title { font-size: 2rem; font-weight: 600; letter-spacing: -0.02em; }
.app-intro .lead { margin-top: 1rem; }
`;
