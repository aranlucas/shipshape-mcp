import { describe, expect, it } from "vitest";
import { deploymentResources } from "@/deployment-resources";

const productionDatabaseId = "production-database";

describe("preview resource isolation", () => {
  it("requires dedicated resources before building a preview", () => {
    expect(() => deploymentResources("preview", productionDatabaseId, {})).toThrow(
      "Previews require",
    );
  });

  it("rejects accidental production bindings", () => {
    const production = deploymentResources("production", productionDatabaseId, {});
    expect(() =>
      deploymentResources("preview", productionDatabaseId, {
        PREVIEW_D1_DATABASE_ID: productionDatabaseId,
        PREVIEW_OAUTH_KV_ID: "preview-kv",
      }),
    ).toThrow("must differ");
    expect(() =>
      deploymentResources("preview", productionDatabaseId, {
        PREVIEW_D1_DATABASE_ID: "preview-database",
        PREVIEW_OAUTH_KV_ID: production.kvId,
      }),
    ).toThrow("must differ");
  });

  it("uses separate preview resources and queue names with read-only APIs", () => {
    expect(
      deploymentResources("preview", productionDatabaseId, {
        PREVIEW_D1_DATABASE_ID: "preview-database",
        PREVIEW_OAUTH_KV_ID: "preview-kv",
      }),
    ).toEqual({
      databaseId: "preview-database",
      kvId: "preview-kv",
      prefix: "shipshape-preview",
      readOnly: "true",
    });
  });
});
