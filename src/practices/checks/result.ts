import type { CheckResult } from "../../api/contract";
import type { ConfigValue } from "../config-value";
import { checkLabel, type Check } from "../schema";
import { z } from "zod";

const DiagnosticText = z.string();

/** Evidence stays structured until the result is prepared for storage. */
export interface CheckOutcome {
  state: CheckResult["state"];
  path?: string | null;
  expected?: ConfigValue;
  actual?: ConfigValue;
  detail?: string | null;
}

const MAX_DIAGNOSTIC_BYTES = 2 * 1024;

const DIAGNOSTIC_TRUNCATION_SUFFIX = "… [truncated for storage]";

const diagnosticEncoder = new TextEncoder();

function stringified(value: ConfigValue): string | null {
  const text = DiagnosticText.safeParse(value);

  if (text.success) {
    return text.data;
  }

  const serialized = JSON.stringify(value);

  return serialized ?? null;
}

interface DiagnosticPreview {
  text: string | null;
  truncated: boolean;
}

function encodedDiagnosticBytes(text: string): number {
  return diagnosticEncoder.encode(JSON.stringify(text)).byteLength;
}

function diagnosticPreview(value: ConfigValue): DiagnosticPreview {
  const text = stringified(value);

  if (text === null || encodedDiagnosticBytes(text) <= MAX_DIAGNOSTIC_BYTES) {
    return { text, truncated: false };
  }

  let prefix = "";

  for (const character of text) {
    const candidate = `${prefix}${character}${DIAGNOSTIC_TRUNCATION_SUFFIX}`;

    if (encodedDiagnosticBytes(candidate) > MAX_DIAGNOSTIC_BYTES) {
      break;
    }

    prefix += character;
  }

  return { text: `${prefix}${DIAGNOSTIC_TRUNCATION_SUFFIX}`, truncated: true };
}

export function formatCheckResult(check: Check, outcome: CheckOutcome): CheckResult {
  const absentDiagnostic: DiagnosticPreview = { text: null, truncated: false };

  const expected =
    outcome.expected === undefined ? absentDiagnostic : diagnosticPreview(outcome.expected);

  const actual =
    outcome.actual === undefined ? absentDiagnostic : diagnosticPreview(outcome.actual);

  const detail =
    outcome.detail === undefined || outcome.detail === null
      ? absentDiagnostic
      : diagnosticPreview(outcome.detail);

  const detailText =
    expected.truncated || actual.truncated
      ? diagnosticPreview(
          detail.text
            ? `${detail.text} Diagnostic values were truncated for storage.`
            : "Diagnostic values were truncated for storage.",
        ).text
      : detail.text;

  return {
    type: check.type,
    label: checkLabel(check),
    state: outcome.state,
    path: outcome.path ?? null,
    expected: expected.text,
    actual: actual.text,
    detail: detailText,
  };
}
