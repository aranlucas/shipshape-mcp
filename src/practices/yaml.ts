import { parseDocument } from "yaml";
import { ConfigValueSchema, type ConfigValue } from "./config-value";

export function parseYaml(text: string): ConfigValue {
  const document = parseDocument(text, { uniqueKeys: true });

  if (document.errors.length > 0) {
    throw new Error("Invalid YAML");
  }

  return ConfigValueSchema.parse(document.toJS({ maxAliasCount: 20 }));
}
