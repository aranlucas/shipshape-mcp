import type { OAuthStateStore } from "../../src/oauth-security";

export function memoryKv(): OAuthStateStore {
  const values = new Map<string, { value: string; expiresAt?: number }>();

  return {
    async delete(key) {
      values.delete(key);
    },
    async get(key) {
      const entry = values.get(key);

      if (
        !entry ||
        (entry.expiresAt !== undefined && entry.expiresAt <= Date.now())
      )
        return null;

      return entry.value;
    },
    async put(key, value, options) {
      const expiresAt =
        options?.expirationTtl === undefined
          ? undefined
          : Date.now() + options.expirationTtl * 1000;

      values.set(key, { value, expiresAt });
    },
  };
}
