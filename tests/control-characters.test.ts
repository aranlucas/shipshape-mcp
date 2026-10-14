import { describe, expect, it } from "vitest";
import { hasControlCharacters, stripControlCharacters } from "../src/control-characters";
import { GitHubRefInputSchema } from "../src/github/schemas";
import { escapeHtml } from "../src/oauth-security";

const controls = [...Array.from({ length: 32 }, (_, index) => index), 127];

describe("ASCII control character boundaries", () => {
  it.each(controls)("rejects and strips ASCII control code %i", (codePoint) => {
    const value = `before${String.fromCodePoint(codePoint)}after`;

    expect(hasControlCharacters(value)).toBe(true);
    expect(stripControlCharacters(value)).toBe("beforeafter");
    expect(escapeHtml(value)).toBe("beforeafter");
    expect(GitHubRefInputSchema.safeParse(value).success).toBe(false);
  });

  it("preserves spaces, Unicode, and surrogate code units during sanitization", () => {
    const value = " café 😀 \u0080 \uD800 \uDC00 ";

    expect(hasControlCharacters(value)).toBe(false);
    expect(stripControlCharacters(value)).toBe(value);
    expect(escapeHtml(`<${value}>&"'`)).toBe(`&lt;${value}&gt;&amp;&quot;&#x27;`);
  });

  it("still rejects Git ref punctuation and spaces while accepting Unicode", () => {
    for (const character of [" ", "~", "^", ":", "?", "*", "[", "\\"]) {
      expect(GitHubRefInputSchema.safeParse(`before${character}after`).success).toBe(false);
    }

    expect(GitHubRefInputSchema.safeParse("feature/café-😀").success).toBe(true);
  });
});
