import { z } from "zod";

import type { AppEnv } from "../env";

export interface OwnerIdentity {
  login: string;
  userId: number;
}

const OwnerIdSchema = z.coerce.number().int().positive();

export function isOwner(env: Pick<AppEnv, "OWNER_GITHUB_ID">, identity: OwnerIdentity): boolean {
  const configured = OwnerIdSchema.safeParse(env.OWNER_GITHUB_ID);

  return configured.success && configured.data === identity.userId;
}
