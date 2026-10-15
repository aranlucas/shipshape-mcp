import { z } from "zod";

import type { AppEnv } from "../env";

export interface OwnerIdentity {
  login: string;
  userId: number;
}

const OwnerIdSchema = z.coerce.number().int().positive();

/** True when an App installation's account is allowlisted (case-insensitive). */
export function isAllowedAccount(
  env: Pick<AppEnv, "ALLOWED_INSTALLATION_ACCOUNTS">,
  login: string,
): boolean {
  return env.ALLOWED_INSTALLATION_ACCOUNTS.split(",")
    .map((account) => account.trim().toLowerCase())
    .some((account) => account.length > 0 && account === login.toLowerCase());
}

export function isOwner(env: Pick<AppEnv, "OWNER_GITHUB_ID">, identity: OwnerIdentity): boolean {
  const configured = OwnerIdSchema.safeParse(env.OWNER_GITHUB_ID);

  return configured.success && configured.data === identity.userId;
}
