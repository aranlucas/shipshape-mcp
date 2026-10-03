import { z } from "zod";

export const ConfigValueSchema = z.json();

export type ConfigValue = z.infer<typeof ConfigValueSchema>;

export const ConfigObjectSchema = z.record(z.string(), ConfigValueSchema);

export type ConfigDocument = z.infer<typeof ConfigObjectSchema>;

export function configObject(value: ConfigValue | undefined): ConfigDocument {
  return ConfigObjectSchema.safeParse(value).data ?? {};
}
