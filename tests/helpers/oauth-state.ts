import type { OAuthStateStore } from "../../src/oauth-security";

export function memoryKv(): OAuthStateStore {
  const values = new Map<string, StoredValue>();

  return {
    delete(key) {
      values.delete(key);

      return Promise.resolve();
    },
    get(key) {
      const entry = values.get(key);

      if (!entry || (entry.expiresAt !== undefined && entry.expiresAt <= Date.now())) {
        return Promise.resolve(null);
      }

      return Promise.resolve(entry.value);
    },
    put(key, value, options) {
      const expiresAt =
        options?.expirationTtl === undefined
          ? undefined
          : Date.now() + options.expirationTtl * 1000;

      values.set(key, { value, expiresAt });

      return Promise.resolve();
    },
  };
}

type StoredValue = { value: string; expiresAt?: number };
