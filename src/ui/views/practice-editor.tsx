import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "preact/hooks";
import type {
  ApiErrorResponse,
  OverviewResponse,
  PracticeDetailResponse,
} from "../../api/contract";
import { ApiError } from "../api";
import { Distribution } from "../components/distribution";
import { StateMark } from "../components/state-mark";
import { STATE_WORDS } from "../format";
import { cellState, practiceCounts } from "../model";
import { deletePracticeMutationOptions, savePracticeMutationOptions } from "../mutations";
import { linkHandler, navigate, paths } from "../router";
import { practiceQuery } from "../queries";
import { startTask } from "../tasks";

const TEMPLATE = `version: 1
id: my-practice
title: My practice
summary: One line that says what this practice keeps true.
kind: files
appliesTo:
  languages: [TypeScript, JavaScript]
checks:
  - type: file-exists
    path: README.md
`;

interface Draft {
  yaml: string;
  instructions: string;
  files: Array<{ path: string; content: string }>;
}

type Tab = { kind: "yaml" } | { kind: "instructions" } | { kind: "file"; index: number };

function draftFrom(detail: PracticeDetailResponse | null): Draft {
  return {
    yaml: detail?.yaml ?? TEMPLATE,
    instructions: detail?.instructions ?? "",
    files: detail?.files.map((file) => ({ ...file })) ?? [],
  };
}

function yamlId(yaml: string): string | null {
  return /^id:\s*["']?([a-z0-9]+(?:-[a-z0-9]+)*)["']?\s*$/mu.exec(yaml)?.[1] ?? null;
}

/** Tab inserts two spaces so YAML can be indented without leaving the editor. */
function indentOnTab(event: KeyboardEvent) {
  if (event.key !== "Tab" || event.shiftKey) {
    return;
  }

  const area = event.currentTarget;

  if (!(area instanceof HTMLTextAreaElement)) {
    return;
  }

  event.preventDefault();
  area.setRangeText("  ", area.selectionStart, area.selectionEnd, "end");
  area.dispatchEvent(new Event("input", { bubbles: true }));
}

type Issues = NonNullable<ApiErrorResponse["issues"]>;

type SaveResult = { ok: true; sha: string } | { ok: false; error: string; issues: Issues };

interface EditorProps {
  overview: OverviewResponse;
  id: string | null;
}

interface FormProps extends EditorProps {
  detail: PracticeDetailResponse | null;
}

export function PracticeEditor({ overview, id }: EditorProps) {
  const query = useQuery(practiceQuery(id));

  if (id !== null && query.isPending) {
    return <p class="loading">Loading practice…</p>;
  }

  if (id !== null && query.isError && !query.data) {
    return (
      <section class="empty-state">
        <h1>
          {query.error instanceof ApiError
            ? query.error.message
            : "The practice couldn't be loaded."}
        </h1>
        <p>
          <button type="button" class="link-button" onClick={() => startTask(query.refetch())}>
            Try again
          </button>
        </p>
        <p>
          <a href={paths.practices} onClick={linkHandler(paths.practices)}>
            Back to practices
          </a>
        </p>
      </section>
    );
  }

  return <PracticeForm key={id ?? "new"} overview={overview} id={id} detail={query.data ?? null} />;
}

function PracticeForm({ overview, id, detail }: FormProps) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(detail));
  const [tab, setTab] = useState<Tab>({ kind: "yaml" });
  const [result, setResult] = useState<SaveResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newPath, setNewPath] = useState("");
  const feedback = useRef<HTMLDivElement>(null);

  const saveMutation = useMutation(savePracticeMutationOptions(client));
  const deleteMutation = useMutation(deletePracticeMutationOptions(client));

  const saving = saveMutation.isPending || deleteMutation.isPending;

  useEffect(() => {
    if (result) {
      feedback.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [result]);

  const original = draftFrom(detail);
  const dirty = JSON.stringify(draft) !== JSON.stringify(original) || id === null;
  const summary = overview.practices.find((item) => item.id === id) ?? detail?.practice ?? null;

  function save(event: Event) {
    event.preventDefault();
    const target = id ?? yamlId(draft.yaml);

    if (!target) {
      setResult({
        ok: false,
        error: "Add an id to practice.yml before saving.",
        issues: [
          { path: "id", message: "Use lowercase words joined by hyphens, like husky-lint-staged." },
        ],
      });

      return;
    }

    setResult(null);

    saveMutation.mutate(
      {
        id: target,
        body: {
          yaml: draft.yaml,
          instructions: draft.instructions.trim() ? draft.instructions : null,
          files: draft.files,
        },
      },
      {
        onSuccess: (saved, variables) => {
          setResult({ ok: true, sha: saved.catalogSha });

          if (id === null) {
            navigate(paths.practice(variables.id), { replace: true });
          }
        },
        onError: (cause) =>
          setResult({
            ok: false,
            error: cause instanceof ApiError ? cause.message : "The practice couldn't be saved.",
            issues: cause instanceof ApiError ? cause.issues : [],
          }),
      },
    );
  }

  function remove() {
    if (!id) {
      return;
    }

    deleteMutation.mutate(id, {
      onSuccess: () => navigate(paths.practices, { replace: true }),
      onError: (cause) =>
        setResult({
          ok: false,
          error: cause instanceof ApiError ? cause.message : "The practice couldn't be deleted.",
          issues: [],
        }),
    });
  }

  const tabValue =
    tab.kind === "yaml"
      ? draft.yaml
      : tab.kind === "instructions"
        ? draft.instructions
        : (draft.files[tab.index]?.content ?? "");

  const tabName =
    tab.kind === "yaml"
      ? "practice.yml"
      : tab.kind === "instructions"
        ? "instructions.md"
        : `files/${draft.files[tab.index]?.path ?? ""}`;

  function updateTab(value: string) {
    setDraft((previous) => {
      if (tab.kind === "yaml") {
        return { ...previous, yaml: value };
      }

      if (tab.kind === "instructions") {
        return { ...previous, instructions: value };
      }

      return {
        ...previous,
        files: previous.files.map((file, index) =>
          index === tab.index ? { ...file, content: value } : file,
        ),
      };
    });
  }

  const counts = id ? practiceCounts(overview, id) : null;

  const attention = id
    ? overview.repos
        .map((repo) => ({ repo, state: cellState(overview, repo.fullName, id) }))
        .filter((item) => item.state === "fail" || item.state === "unknown")
        .toSorted((a, b) =>
          a.state === b.state
            ? a.repo.fullName.localeCompare(b.repo.fullName)
            : a.state === "fail"
              ? -1
              : 1,
        )
    : [];

  return (
    <>
      <nav class="crumbs" aria-label="Breadcrumb">
        <a href={paths.practices} onClick={linkHandler(paths.practices)}>
          Practices
        </a>
      </nav>
      <header class="page-head">
        <div>
          <h1>{id === null ? "New practice" : (summary?.title ?? id)}</h1>
          <p class="page-lead">
            {id === null
              ? "Describe what every matching repository should have. Shipshape checks it everywhere once you save."
              : summary?.valid === false
                ? `This practice is invalid, so it is not checked: ${summary.error ?? "unknown error"}`
                : summary?.summary}
          </p>
        </div>
      </header>

      {counts && <Distribution counts={counts} />}

      <div class="editor-layout">
        <form class="editor" onSubmit={save}>
          <div class="tabs" role="tablist" aria-label="Practice files">
            <button
              type="button"
              role="tab"
              aria-selected={tab.kind === "yaml"}
              onClick={() => setTab({ kind: "yaml" })}
            >
              practice.yml
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab.kind === "instructions"}
              onClick={() => setTab({ kind: "instructions" })}
            >
              instructions.md
            </button>
            {draft.files.map((file, index) => (
              <button
                key={file.path}
                type="button"
                role="tab"
                aria-selected={tab.kind === "file" && tab.index === index}
                onClick={() => setTab({ kind: "file", index })}
              >
                {file.path}
              </button>
            ))}
          </div>

          <label class="code-field">
            <span class="sr-only">{tabName}</span>
            <textarea
              class="code"
              spellcheck={false}
              autocomplete="off"
              rows={Math.max(16, tabValue.split("\n").length + 2)}
              value={tabValue}
              placeholder={
                tab.kind === "instructions"
                  ? "Guidance for the agent that fixes this practice, such as what to adapt per repository."
                  : undefined
              }
              onInput={(event) => updateTab(event.currentTarget.value)}
              onKeyDown={indentOnTab}
            />
          </label>

          <div class="file-tools">
            {tab.kind === "file" ? (
              <button
                type="button"
                class="link-button"
                onClick={() => {
                  setDraft((previous) => ({
                    ...previous,
                    files: previous.files.filter((_, index) => index !== tab.index),
                  }));
                  setTab({ kind: "yaml" });
                }}
              >
                Remove {tabName}
              </button>
            ) : (
              <span class="hint">
                Canonical files are compared by <code>file-matches</code> checks, as{" "}
                <code>source: files/…</code>.
              </span>
            )}
            <span class="add-file">
              <label>
                <span class="sr-only">New file path</span>
                <input
                  type="text"
                  placeholder=".github/dependabot.yml"
                  value={newPath}
                  onInput={(event) => setNewPath(event.currentTarget.value)}
                />
              </label>
              <button
                type="button"
                class="button button-small"
                disabled={
                  !newPath.trim() || draft.files.some((file) => file.path === newPath.trim())
                }
                onClick={() => {
                  const path = newPath.trim().replace(/^\/+/u, "");
                  setDraft((previous) => ({
                    ...previous,
                    files: [...previous.files, { path, content: "" }],
                  }));
                  setTab({ kind: "file", index: draft.files.length });
                  setNewPath("");
                }}
              >
                Add file
              </button>
            </span>
          </div>

          <div ref={feedback} />
          {result && !result.ok && (
            <div class="notice notice-error" role="alert">
              <p>{result.error}</p>
              {result.issues.length > 0 && (
                <ul class="issues">
                  {result.issues.map((issue) => (
                    <li key={`${issue.path}:${issue.message}`}>
                      <code>{issue.path || "practice.yml"}</code> {issue.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {result?.ok && (
            <p class="notice notice-ok" role="status">
              Saved to {overview.catalog.repo} as commit <code>{result.sha.slice(0, 7)}</code>.
              Repositories are being checked again.
            </p>
          )}

          <div class="editor-actions">
            <button type="submit" class="button button-primary" disabled={saving || !dirty}>
              {saving ? "Saving…" : id === null ? "Add practice" : "Save practice"}
            </button>
            {id !== null && (
              <button
                type="button"
                class="button button-quiet"
                disabled={saving || !dirty}
                onClick={() => setDraft(original)}
              >
                Discard changes
              </button>
            )}
            {id !== null &&
              (confirmDelete ? (
                <span class="confirm" role="group" aria-label="Confirm delete">
                  Delete {id} from the catalog?
                  <button
                    type="button"
                    class="button button-danger button-small"
                    disabled={saving}
                    onClick={remove}
                  >
                    Delete practice
                  </button>
                  <button
                    type="button"
                    class="button button-quiet button-small"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Keep it
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  class="button button-quiet push-end"
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete practice
                </button>
              ))}
          </div>
        </form>

        {id !== null && (
          <aside class="attention" aria-labelledby="attention-title">
            <h2 id="attention-title">Needs attention</h2>
            {attention.length === 0 ? (
              <p class="hint">Every repository this practice applies to follows it.</p>
            ) : (
              <ul>
                {attention.map(({ repo, state }) => {
                  const href = paths.repo(repo.fullName);

                  return (
                    <li key={repo.fullName}>
                      <StateMark state={state} label={STATE_WORDS[state]} />
                      <a href={href} onClick={linkHandler(href)}>
                        <span class="attention-owner">{repo.owner}/</span>
                        {repo.name}
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>
        )}
      </div>
    </>
  );
}
