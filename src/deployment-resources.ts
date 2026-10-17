interface ResourceConfig {
  d1DatabaseId: string;
  previewD1DatabaseId?: string;
  previewOAuthKvId?: string;
}

interface ResourceVariables {
  PREVIEW_D1_DATABASE_ID?: string;
  PREVIEW_OAUTH_KV_ID?: string;
}

const PRODUCTION_KV_ID = "9653a49921874566b41d5d4e17c88c15";

/** A preview must never fall back to production state when its resources are missing. */
export function deploymentResources(mode: string, config: ResourceConfig, vars: ResourceVariables) {
  if (mode !== "preview") {
    return {
      databaseId: config.d1DatabaseId,
      kvId: PRODUCTION_KV_ID,
      prefix: "shipshape",
      readOnly: "false",
    };
  }

  const databaseId = vars.PREVIEW_D1_DATABASE_ID ?? config.previewD1DatabaseId;
  const kvId = vars.PREVIEW_OAUTH_KV_ID ?? config.previewOAuthKvId;

  if (!databaseId || !kvId) {
    throw new Error(
      "Previews require dedicated D1 and KV IDs in package.json config or PREVIEW_D1_DATABASE_ID and PREVIEW_OAUTH_KV_ID",
    );
  }

  if (
    databaseId.toLowerCase() === config.d1DatabaseId.toLowerCase() ||
    kvId.toLowerCase() === PRODUCTION_KV_ID
  ) {
    throw new Error("Preview D1 and KV must differ from production resources");
  }

  return { databaseId, kvId, prefix: "shipshape-preview", readOnly: "true" };
}
