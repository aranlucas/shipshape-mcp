import { z } from "zod";

export const ConfigValueSchema = z.json();

export type ConfigValue = z.infer<typeof ConfigValueSchema>;

export const ConfigObjectSchema = z.record(z.string(), ConfigValueSchema);

export type ConfigDocument = z.infer<typeof ConfigObjectSchema>;

const ConfigContainerSchema = z.union([ConfigObjectSchema, z.array(ConfigValueSchema)]);

export function configObject(value: ConfigValue | undefined): ConfigDocument {
  return ConfigObjectSchema.safeParse(value).data ?? {};
}

export type LocatedValue = { present: true; value: ConfigValue } | { present: false };

export function locateConfigValue(root: ConfigValue, path: string): LocatedValue {
  let current = root;

  for (const segment of path.split(".")) {
    const container = ConfigContainerSchema.safeParse(current);

    if (!container.success) {
      return { present: false };
    }

    if (Array.isArray(container.data) && segment === "length") {
      current = container.data.length;
      continue;
    }

    const entry = Object.entries<ConfigValue>(container.data).find(([key]) => key === segment);

    if (!entry) {
      return { present: false };
    }

    current = entry[1];
  }

  return { present: true, value: current };
}
