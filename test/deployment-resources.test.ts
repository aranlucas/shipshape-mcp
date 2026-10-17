import { describe, expect, it } from "vitest";
import { deploymentResources } from "@/deployment-resources";
import manifest from "../package.json" with { type: "json" };

const config = {
  d1DatabaseId: "production-database",
  previewD1DatabaseId: "preview-database",
  previewOAuthKvId: "preview-kv",
};

describe("preview resource isolation", () => {
  it("configures real project defaults for Workers Builds", () => {
    const resources = deploymentResources("preview", manifest.config, {});
    expect(resources.databaseId).not.toBe(manifest.config.d1DatabaseId);
    expect(resources.kvId).not.toBe(deploymentResources("production", manifest.config, {}).kvId);
    expect(resources.readOnly).toBe("true");
  });

  it("builds a preview with project defaults and no build variables", () => {
    expect(deploymentResources("preview", config, {})).toEqual({
      databaseId: config.previewD1DatabaseId,
      kvId: config.previewOAuthKvId,
      prefix: "shipshape-preview",
      readOnly: "true",
    });
  });

  it("keeps production bindings when preview overrides are present", () => {
    expect(
      deploymentResources("production", config, {
        PREVIEW_D1_DATABASE_ID: "branch-database",
        PREVIEW_OAUTH_KV_ID: "branch-kv",
      }),
    ).toMatchObject({ databaseId: config.d1DatabaseId, readOnly: "false" });
  });

  it("requires dedicated resources if project defaults are missing", () => {
    expect(() =>
      deploymentResources(
        "preview",
        { ...config, previewD1DatabaseId: "", previewOAuthKvId: "" },
        {},
      ),
    ).toThrow("Previews require");
  });

  it("rejects production bindings supplied through overrides", () => {
    const production = deploymentResources("production", config, {});
    expect(() =>
      deploymentResources("preview", config, {
        PREVIEW_D1_DATABASE_ID: config.d1DatabaseId.toUpperCase(),
      }),
    ).toThrow("must differ");
    expect(() =>
      deploymentResources("preview", config, {
        PREVIEW_OAUTH_KV_ID: production.kvId.toUpperCase(),
      }),
    ).toThrow("must differ");
  });

  it("rejects production bindings supplied through project defaults", () => {
    const production = deploymentResources("production", config, {});
    expect(() =>
      deploymentResources("preview", { ...config, previewD1DatabaseId: config.d1DatabaseId }, {}),
    ).toThrow("must differ");
    expect(() =>
      deploymentResources("preview", { ...config, previewOAuthKvId: production.kvId }, {}),
    ).toThrow("must differ");
  });

  it("allows a branch to override either preview resource independently", () => {
    expect(
      deploymentResources("preview", config, { PREVIEW_D1_DATABASE_ID: "branch-database" }),
    ).toMatchObject({ databaseId: "branch-database", kvId: config.previewOAuthKvId });
    expect(
      deploymentResources("preview", config, { PREVIEW_OAUTH_KV_ID: "branch-kv" }),
    ).toMatchObject({ databaseId: config.previewD1DatabaseId, kvId: "branch-kv" });
  });
});
