# Repository review desk

Open `/app/review` after signing in. The existing `/app` settings-drift policy
editor stays available through the dashboard navigation.

1. Load an owner's public repositories, one page of 20 at a time.
2. Choose **Inspect** to collect a bounded report for one repository. A listing
   is explicitly **Not checked**, rather than a passing result.
3. Filter collected reports by repository, category or state. Reports remain in
   the current page's memory while browsing repository pages, and clear when
   changing owner or reloading the browser.
4. Review the current observation, desired state, proposed next step, evidence,
   confidence and priority. Refresh before acting on old evidence.

The desk proposes review work. It has no repository mutation, approval, merge,
archive or deletion endpoint. Any resulting change must be reviewed and approved
in the user's normal workflow. No extra OAuth scope is requested.

## Evidence and coverage

Reports include collection time and the inspected default-branch commit. Static
file evidence links use that immutable commit; PR evidence identifies the
observed PR head separately. These observations can become stale immediately
after collection, and the two heads need not match.

- **Standards:** the existing standards evaluator remains the source of truth
  for baseline adoption, declared quality gates, exact opt-in Oxforge versions,
  recognized lint preset wiring and dated exceptions. Extra convention evidence
  is static and does not prove commands run, tests are useful or configuration
  evaluates the way a regular expression suggests.
- **Pull requests:** bounded current-head check and status observations distinguish
  pending, unavailable and failed evidence. Missing checks never imply merge
  readiness. Failure conclusions alone do not establish code failure or runner
  outage. Provider or runner causes require supporting evidence.
- **Dependencies:** declared related tools are grouped for compatibility review.
  Declared versions do not establish resolved compatibility, unused packages,
  advisories or upgrade safety.
- **Cleanup:** source entrypoints, public APIs, package exports, dynamic imports,
  framework discovery and diagnostic tooling must be understood before removal.
  A missing local reference or a small test alone is not grounds to delete.
- **Repository purpose:** last-push metadata prompts contextual review of dormant
  repositories. It is not a health score or proof that archiving or consolidation
  is appropriate. Consolidation remains unassessed until consumers and ownership
  are compared.

Forks and archived repositories are exempt from convergence and cleanup inspection.
Private/internal repositories are unavailable under the public-only connection.
Vendored and generated files are not new convergence targets. Partial source trees,
unreadable files, capped PR/check lists and unavailable endpoints stay explicit in
findings or report coverage; unknown is never turned into a pass.

## Safety and request budget

The two dashboard APIs are authenticated, same-origin read-only GETs:

- `/app/api/review/repos?owner=OWNER&page=1`
- `/app/api/review/repository?owner=OWNER&repo=REPOSITORY`

Owner/repository coordinates are schema-validated and only fixed GitHub API routes
are used. Repository metadata is checked before any deeper read. No arbitrary URL,
private source, token, workflow log archive or executable is accepted from the
browser. The browser renders provider content with `textContent` and permits only
HTTPS evidence links without URL credentials.

The browser allows one listing or inspection request at a time. Source reads reuse
the standards collector's four-request concurrency, 80 selected-file / 2 MB budget (plus local and optional shared-policy reads) and
128 KB per-file ceiling. PR reports cap pull requests and check/status observations,
report truncation, and do not automatically retry provider limits. The source tree
is never cloned or executed by Shipshape. Reports are not stored server-side.
