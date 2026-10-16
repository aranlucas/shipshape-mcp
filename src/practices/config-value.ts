import { z } from "zod";

export const ConfigValueSchema = z.json();

export type ConfigValue = z.infer<typeof ConfigValueSchema>;

export const ConfigObjectSchema = z.record(z.string(), ConfigValueSchema);

export type ConfigDocument = z.infer<typeof ConfigObjectSchema>;

export function configObject(value: ConfigValue | undefined): ConfigDocument {
  return ConfigObjectSchema.safeParse(value).data ?? {};
}

export type LocatedValue = { present: true; value: ConfigValue } | { present: false };

export function locateConfigValue(root: ConfigValue, path: string): LocatedValue {
  let current = root;

  for (const segment of path.split(".")) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Narrow validated JSON values before reading own properties.
    if (current === null || typeof current !== "object") {
      return { present: false };
    }

    if (Array.isArray(current) && segment === "length") {
      current = current.length;
      continue;
    }

    const entry = Object.entries<ConfigValue>(current).find(([key]) => key === segment);

    if (!entry) {
      return { present: false };
    }

    current = entry[1];
  }

  return { present: true, value: current };
}
