import type { ConfigValue } from "./config-value";
import { z } from "zod";

interface LogicalParts {
  or: string[];
  and: string[];
  inner: string | null;
}

const DRAFT_GUARDS = new Set([
  "github.event.pull_request.draft!=true",
  "github.event.pull_request.draft==false",
  "!github.event.pull_request.draft",
  "true!=github.event.pull_request.draft",
  "false==github.event.pull_request.draft",
]);

/** A small, bounded recognizer, not an evaluator for arbitrary Actions expressions. */
function logicalParts(expression: string): LogicalParts | null {
  const or: string[] = [];
  const and: string[] = [];
  let depth = 0;
  let quoted = false;
  let orStart = 0;
  let andStart = 0;
  let outerCloses = -1;

  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];

    if (character === "'") {
      if (quoted && expression[index + 1] === "'") {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted) {
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;

        if (depth === 0 && outerCloses === -1) {
          outerCloses = index;
        }
      } else if (depth === 0 && expression.slice(index, index + 2) === "||") {
        or.push(expression.slice(orStart, index));
        orStart = index + 2;
        index += 1;
      } else if (depth === 0 && expression.slice(index, index + 2) === "&&") {
        and.push(expression.slice(andStart, index));
        andStart = index + 2;
        index += 1;
      }

      if (depth < 0 || depth > 32) {
        return null;
      }
    }
  }

  if (quoted || depth !== 0) {
    return null;
  }

  if (or.length) {
    or.push(expression.slice(orStart));
  }

  if (and.length) {
    and.push(expression.slice(andStart));
  }

  if ([...or, ...and].some((part) => !part.trim())) {
    return null;
  }

  return {
    or,
    and,
    inner:
      expression.startsWith("(") && outerCloses === expression.length - 1
        ? expression.slice(1, -1)
        : null,
  };
}

function recognizesGuard(expression: string, depth = 0): boolean | null {
  if (depth > 32 || !expression.trim()) {
    return null;
  }

  const text = expression.trim();
  const parts = logicalParts(text);

  if (!parts) {
    return null;
  }

  if (parts.inner !== null) {
    return recognizesGuard(parts.inner, depth + 1);
  }

  if (parts.or.length || parts.and.length) {
    const branches = new Set(
      (parts.or.length ? parts.or : parts.and).map((part) => recognizesGuard(part, depth + 1)),
    );

    // Every OR arm must exclude drafts; a mandatory AND guard is sufficient.
    if (parts.or.length) {
      return branches.has(false) ? false : branches.has(null) ? null : true;
    }

    return branches.has(true) ? true : branches.has(null) ? null : false;
  }

  const compact = text.replaceAll(/\s/gu, "").toLowerCase();

  if (DRAFT_GUARDS.has(compact)) {
    return true;
  }

  return compact.includes("draft") || compact.includes("${{") ? null : false;
}

export function inspectDraftJobGuard(value: ConfigValue | undefined): boolean | null {
  if (value === undefined || value === true || value === false) {
    return value === false;
  }

  const parsed = z.string().safeParse(value);

  if (!parsed.success) {
    return null;
  }

  const text = parsed.data.trim();
  const expression = text.startsWith("${{") && text.endsWith("}}") ? text.slice(3, -2) : text;

  return recognizesGuard(expression);
}
