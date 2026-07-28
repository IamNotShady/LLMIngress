import { buildHref, readParam, type SearchParams } from "../params";

/**
 * Picking a provider starts a new provider-scoped view. Only the model page
 * size is a view preference worth carrying; dialogs, drafts, feedback and
 * model filters all belong to the provider the operator is leaving.
 */
export function buildProviderSelectionHref(
  params: SearchParams,
  providerId: string,
): string {
  return buildHref(
    "/providers",
    {},
    {
      modelPageSize: readParam(params, "modelPageSize") ?? null,
      selected: providerId,
    },
  );
}
