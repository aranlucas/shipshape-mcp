export const STYLES_PATH = "/assets/shipshape.css" as const;

export const APP_CSS = `
:root {
  color-scheme: dark;
  --ink: #f5f3e9;
  --muted: #a9b8ba;
  --ocean: #07181e;
  --line: #23434a;
  --foam: #91e7d2;
  --signal: #ffc15c;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--ocean);
  color: var(--ink);
}

* { box-sizing: border-box; }
html { min-height: 100%; background: var(--ocean); }
body {
  min-height: 100vh;
  margin: 0;
  background:
    radial-gradient(circle at 78% 3%, rgb(45 103 106 / 24%), transparent 33rem),
    linear-gradient(180deg, #0a2027 0, var(--ocean) 34rem);
}
a { color: var(--foam); text-underline-offset: 0.22em; }
a:hover { color: var(--ink); }
a:focus-visible, button:focus-visible, summary:focus-visible {
  outline: 3px solid var(--signal);
  outline-offset: 3px;
}
code {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  overflow-wrap: anywhere;
}

.site-shell, .consent-shell {
  width: min(70rem, calc(100% - 2rem));
  margin-inline: auto;
}
.site-shell { padding: 1.25rem 0 3rem; }
.masthead, .site-footer, .brand-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.masthead { min-height: 3rem; }
.wordmark {
  color: var(--ink);
  font-size: 0.82rem;
  font-weight: 800;
  letter-spacing: 0.16em;
  text-decoration: none;
  text-transform: uppercase;
}
.wordmark span { color: var(--signal); }
.nav-list { display: flex; gap: 1.25rem; margin: 0; padding: 0; list-style: none; }
.nav-list a { color: var(--muted); font-size: 0.88rem; text-decoration: none; }

.hero { padding: clamp(5rem, 12vw, 9rem) 0 clamp(4rem, 9vw, 7rem); }
.eyebrow {
  margin: 0 0 1.25rem;
  color: var(--foam);
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}
h1, h2, p { text-wrap: pretty; }
h1 {
  max-width: 13ch;
  margin: 0;
  font-size: clamp(3.25rem, 9vw, 7.5rem);
  font-weight: 760;
  letter-spacing: -0.065em;
  line-height: 0.9;
}
.lead {
  max-width: 42rem;
  margin: 2rem 0 0;
  color: var(--muted);
  font-size: clamp(1.05rem, 2vw, 1.35rem);
  line-height: 1.65;
}
.endpoint {
  display: inline-flex;
  align-items: center;
  gap: 0.65rem;
  max-width: 100%;
  margin-top: 2rem;
  padding: 0.7rem 0.9rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: rgb(12 37 45 / 72%);
  color: var(--muted);
  font-size: 0.78rem;
}
.status-dot { width: 0.55rem; height: 0.55rem; border-radius: 50%; background: var(--foam); box-shadow: 0 0 1rem var(--foam); }

.signal-grid, .tool-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 1.25rem;
  background: var(--line);
}
.signal, .tool { background: rgb(12 37 45 / 94%); }
.signal { min-height: 13rem; padding: 1.5rem; }
.signal-number { display: block; color: var(--signal); font-family: "SFMono-Regular", Consolas, monospace; font-size: 0.78rem; }
.signal h2, .tool h3 { margin: 2.5rem 0 0.6rem; font-size: 1.08rem; }
.signal p, .tool p { color: var(--muted); line-height: 1.55; }

.tools { padding: clamp(4rem, 9vw, 7rem) 0; }
.section-label { margin: 0 0 1.25rem; color: var(--muted); font-size: 0.78rem; letter-spacing: 0.16em; text-transform: uppercase; }
.tool-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.tool { min-height: 10rem; padding: 1.4rem; }
.tool h3 { margin-top: 0; font-family: "SFMono-Regular", Consolas, monospace; font-size: 0.92rem; }
.tool p { margin-bottom: 0; }
.site-footer { padding-top: 1.5rem; border-top: 1px solid var(--line); color: var(--muted); font-size: 0.82rem; }

.consent-shell {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 2rem 0;
}
.consent-card {
  width: min(35rem, 100%);
  padding: clamp(1.4rem, 5vw, 2.5rem);
  border: 1px solid var(--line);
  border-radius: 1.25rem;
  background: rgb(12 37 45 / 96%);
  box-shadow: 0 2rem 7rem rgb(0 0 0 / 34%);
}
.consent-card h1, .legal-page h1 {
  max-width: none;
  margin-top: 2.5rem;
  font-size: clamp(2.2rem, 7vw, 3.6rem);
  letter-spacing: -0.045em;
  line-height: 1;
}
.consent-card h2 { margin-top: 2rem; font-size: 0.78rem; letter-spacing: 0.14em; text-transform: uppercase; }
.consent-card p, .consent-card li, .legal-page p { color: var(--muted); line-height: 1.6; }
.scope-list { padding-left: 1.25rem; }
.scope-list code { color: var(--ink); }
.permission-note { padding: 0.9rem 1rem; border-left: 3px solid var(--foam); background: rgb(145 231 210 / 6%); }
details { margin-top: 1.25rem; color: var(--muted); }
summary { cursor: pointer; color: var(--ink); }
.button-row { display: flex; gap: 0.75rem; margin-top: 2rem; }
button {
  min-height: 2.8rem;
  padding: 0.65rem 1rem;
  border: 1px solid var(--line);
  border-radius: 0.7rem;
  font: inherit;
  font-weight: 750;
  cursor: pointer;
}
.button-primary { border-color: var(--foam); background: var(--foam); color: #052027; }
.button-secondary { background: transparent; color: var(--muted); }
.legal-links { font-size: 0.82rem; }
.legal-page { width: min(42rem, 100%); padding: clamp(2rem, 8vw, 5rem) 0; }

.button-link {
  display: inline-flex;
  align-items: center;
  min-height: 2.8rem;
  padding: 0.65rem 1rem;
  border-radius: 0.7rem;
  font-weight: 750;
  text-decoration: none;
}
.button-link.button-primary:hover { color: #052027; filter: brightness(1.08); }
.button-small { min-height: 2rem; padding: 0.3rem 0.7rem; font-size: 0.82rem; }
.muted { color: var(--muted); }
.mono { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 0.86em; overflow-wrap: anywhere; }

.app-shell { width: min(84rem, calc(100% - 2rem)); }
.account { display: flex; align-items: center; gap: 0.9rem; font-size: 0.88rem; }
.account form { margin: 0; }
.app-intro { padding: clamp(2.5rem, 6vw, 4.5rem) 0 2rem; }
.app-title { max-width: none; font-size: clamp(2.4rem, 6vw, 4.4rem); }
.app-intro .lead { margin-top: 1.25rem; }
.app-grid {
  display: grid;
  grid-template-columns: minmax(0, 27rem) minmax(0, 1fr);
  gap: 1.25rem;
  align-items: start;
}
.panel {
  padding: clamp(1.1rem, 3vw, 1.6rem);
  border: 1px solid var(--line);
  border-radius: 1.25rem;
  background: rgb(12 37 45 / 94%);
}
.panel-title { margin: 0 0 1.1rem; font-size: 0.78rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
.field { display: grid; gap: 0.4rem; margin-bottom: 1rem; flex: 1; }
.field span { color: var(--muted); font-size: 0.82rem; font-weight: 650; }
.field-row { display: flex; gap: 0.75rem; align-items: end; }
.field-narrow { flex: 0 0 8rem; }
.preset-row button { margin-bottom: 1rem; }
input, textarea, select {
  width: 100%;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--line);
  border-radius: 0.6rem;
  background: #051318;
  color: var(--ink);
  font: inherit;
}
textarea { resize: vertical; min-height: 18rem; font-family: "SFMono-Regular", Consolas, monospace; font-size: 0.84rem; line-height: 1.5; tab-size: 2; }
input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 3px solid var(--signal); outline-offset: 1px; }
.app-grid .button-row { flex-wrap: wrap; margin-top: 0.5rem; }
.form-status { min-height: 1.4rem; margin: 1rem 0 0; color: var(--muted); }
.form-status[data-tone="error"] { color: #ff9b85; }
.form-status[data-tone="ok"] { color: var(--foam); }

.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.75rem; margin-bottom: 1rem; }
.tile { display: grid; gap: 0.2rem; padding: 0.9rem 1rem; border: 1px solid var(--line); border-radius: 0.9rem; background: #0a1f26; }
.tile-value { font-size: 1.8rem; font-weight: 760; letter-spacing: -0.03em; }
.tile-label { color: var(--muted); font-size: 0.78rem; }
.tile-fail .tile-value { color: #ff9b85; }
.tile-pass .tile-value { color: var(--foam); }
.tile-unknown .tile-value { color: var(--signal); }

.repo { margin-top: 0.9rem; padding: 0.9rem 1rem; border: 1px solid var(--line); border-radius: 0.9rem; background: #0a1f26; color: var(--ink); }
.repo summary { display: flex; flex-wrap: wrap; align-items: center; gap: 0.7rem; }
.repo summary .muted { margin-left: auto; font-size: 0.82rem; }
.repo-drifted { border-color: rgb(255 155 133 / 45%); }
.repo-section h4 { margin: 1.2rem 0 0.5rem; font-size: 0.78rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
.pill { display: inline-block; padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.74rem; font-weight: 750; text-transform: capitalize; }
.pill-pass, .pill-compliant { background: rgb(145 231 210 / 14%); color: var(--foam); }
.pill-fail, .pill-drifted { background: rgb(255 155 133 / 14%); color: #ff9b85; }
.pill-unknown { background: rgb(255 193 92 / 14%); color: var(--signal); }
.table-wrap { overflow-x: auto; margin-top: 0.6rem; }
.checks { width: 100%; min-width: 36rem; border-collapse: collapse; font-size: 0.86rem; }
.checks th { color: var(--muted); font-size: 0.74rem; font-weight: 650; text-align: left; text-transform: uppercase; letter-spacing: 0.08em; }
.checks th, .checks td { padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
.command { margin-top: 0.6rem; border: 1px solid var(--line); border-radius: 0.7rem; overflow: hidden; }
.command-header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.45rem 0.6rem 0.45rem 0.9rem; background: #0c262e; font-size: 0.86rem; }
.command pre { margin: 0; padding: 0.8rem 0.9rem; overflow-x: auto; background: #051318; white-space: pre-wrap; word-break: break-all; }
.notes { margin: 0; padding-left: 1.1rem; color: var(--muted); line-height: 1.55; }
.notes strong { color: var(--ink); }

@media (max-width: 62rem) {
  .app-grid { grid-template-columns: minmax(0, 1fr); }
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 46rem) {
  .signal-grid, .tool-grid { grid-template-columns: 1fr; }
  .masthead { align-items: flex-start; }
  .nav-list { gap: 0.8rem; }
  .hero { padding-top: 4rem; }
  .endpoint { align-items: flex-start; border-radius: 0.8rem; }
  .button-row { flex-direction: column; }
  button, .button-link { width: 100%; justify-content: center; }
  .account { flex-direction: column; align-items: flex-end; gap: 0.4rem; }
  .account button, .command-header button { width: auto; flex: none; }
  .field-row { flex-direction: column; align-items: stretch; }
  .field-narrow { flex-basis: auto; }
  .site-footer { align-items: flex-start; flex-direction: column; }
}
`;
