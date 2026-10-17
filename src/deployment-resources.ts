interface ResourceVariables {
  PREVIEW_D1_DATABASE_ID?: string;
  PREVIEW_OAUTH_KV_ID?: string;
}

const PRODUCTION_KV_ID = "9653a49921874566b41d5d4e17c88c15";

/** A preview must never fall back to production state when its resources are missing. */
export function deploymentResources(
  mode: string,
  productionDatabaseId: string,
  vars: ResourceVariables,
) {
  if (mode !== "preview") {
    return {
      databaseId: productionDatabaseId,
      kvId: PRODUCTION_KV_ID,
      prefix: "shipshape",
      readOnly: "false",
    };
  }

  const databaseId = vars.PREVIEW_D1_DATABASE_ID;
  const kvId = vars.PREVIEW_OAUTH_KV_ID;

  if (!databaseId || !kvId) {
    throw new Error(
      "Previews require PREVIEW_D1_DATABASE_ID and PREVIEW_OAUTH_KV_ID for isolated resources",
    );
  }

  if (
    databaseId.toLowerCase() === productionDatabaseId.toLowerCase() ||
    kvId.toLowerCase() === PRODUCTION_KV_ID
  ) {
    throw new Error("Preview D1 and KV must differ from production resources");
  }

  return { databaseId, kvId, prefix: "shipshape-preview", readOnly: "true" };
}
