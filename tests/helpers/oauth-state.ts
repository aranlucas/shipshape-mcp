import type { OAuthStateStore } from "../../src/oauth-security";

interface MemoryKvEntry {
  value: string;
  expiresAt?: number;
}

interface MemoryKvPutOptions {
  expirationTtl?: number;
}

export function memoryKv(): OAuthStateStore {
  const values = new Map<string, MemoryKvEntry>();

  return {
    async delete(key: string) {
      values.delete(key);
    },
    async get(key: string) {
      const entry = values.get(key);

      if (
        !entry ||
        (entry.expiresAt !== undefined && entry.expiresAt <= Date.now())
      )
        return null;

      return entry.value;
    },
    async put(key: string, value: string, options?: MemoryKvPutOptions) {
      const expiresAt =
        options?.expirationTtl === undefined
          ? undefined
          : Date.now() + options.expirationTtl * 1000;

      values.set(key, { value, expiresAt });
    },
  };
}
