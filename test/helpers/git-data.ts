import { z } from "zod";

const GitTreeEntrySchema = z.object({
  path: z.string(),
  sha: z.string().nullable(),
  mode: z.string().optional(),
  type: z.string().optional(),
});

export const GitDataRequestBodySchema = z.object({
  base_tree: z.string().optional(),
  tree: z.union([z.string(), z.array(GitTreeEntrySchema)]).optional(),
  message: z.string().optional(),
  sha: z.string().optional(),
  force: z.boolean().optional(),
  content: z.string().optional(),
  encoding: z.string().optional(),
  parents: z.array(z.string()).optional(),
});

export interface RecordedGitRequest {
  method: string;
  path: string;
  body: z.infer<typeof GitDataRequestBodySchema> | null;
}

const GitTreeBodySchema = z.object({ tree: z.array(GitTreeEntrySchema) });

export function gitTreeEntries(request: RecordedGitRequest | undefined) {
  return GitTreeBodySchema.parse(request?.body).tree;
}
