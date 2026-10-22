import { z } from "zod";

const JsonValueSchema = z.json();

export type JsonValue = z.infer<typeof JsonValueSchema>;

export async function parseJson(response: Response): Promise<JsonValue> {
  return JsonValueSchema.parse(await response.json());
}
