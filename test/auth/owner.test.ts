import { describe, expect, it } from "vitest";

import { isAllowedAccount, isOwner } from "@/auth/owner";

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

describe("isAllowedAccount", () => {
  const env = { ALLOWED_INSTALLATION_ACCOUNTS: " aranlucas, Sidequest-Labs ,," };

  it("matches allowlisted accounts case-insensitively, ignoring spaces and blanks", () => {
    expect(isAllowedAccount(env, "aranlucas")).toBe(true);
    expect(isAllowedAccount(env, "sidequest-labs")).toBe(true);
    expect(isAllowedAccount(env, "ARANLUCAS")).toBe(true);
  });

  it("rejects other accounts and an empty login", () => {
    expect(isAllowedAccount(env, "stranger")).toBe(false);
    expect(isAllowedAccount(env, "")).toBe(false);
    expect(isAllowedAccount({ ALLOWED_INSTALLATION_ACCOUNTS: "" }, "aranlucas")).toBe(false);
  });
});
