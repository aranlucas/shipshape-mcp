import { describe, expect, it } from "vitest";

import { isOwner } from "@/auth/owner";

describe("owner gate", () => {
  it("matches the configured numeric GitHub id", () => {
    expect(isOwner({ OWNER_GITHUB_ID: "1001" }, { login: "aranlucas", userId: 1001 })).toBe(true);
    expect(isOwner({ OWNER_GITHUB_ID: "1001" }, { login: "aranlucas", userId: 1002 })).toBe(false);
  });

  it("locks everyone out when the owner id is unconfigured", () => {
    expect(isOwner({ OWNER_GITHUB_ID: "0" }, { login: "aranlucas", userId: 0 })).toBe(false);
    expect(isOwner({ OWNER_GITHUB_ID: "" }, { login: "aranlucas", userId: 1001 })).toBe(false);
  });

  it("uses the id rather than the login as the authority", () => {
    expect(isOwner({ OWNER_GITHUB_ID: "1001" }, { login: "someone-else", userId: 1002 })).toBe(
      false,
    );
  });
});
