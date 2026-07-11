import {
  createRoutePolicy,
  deleteRoutePolicy,
  normalizeRoutePolicyFormInput,
  updateRoutePolicy,
} from "@llmingress/db/console-route-policies";
import { NextResponse } from "next/server";
import { withConsoleAuth } from "../_auth";
import { consoleActionErrorResponse } from "../_errors";
import { readRequiredText, readText, readTextValues } from "../_form";
import { redirectToConsolePath } from "../_redirect";

export const POST = withConsoleAuth(async (request) => {
  const form = await request.formData();
  const action = readText(form, "action");

  try {
    if (action === "create") {
      await createRoutePolicy({
        routePolicy: normalizeRoutePolicyFormInput({
          endpointProtocol: readText(form, "endpointProtocol"),
          providerModelIds: readTextValues(form, "providerModelIds"),
          strategy: readText(form, "strategy"),
          virtualModelId: readText(form, "virtualModelId"),
        }),
      });
    } else if (action === "update") {
      await updateRoutePolicy({
        id: readRequiredText(form, "id"),
        routePolicy: normalizeRoutePolicyFormInput({
          endpointProtocol: readText(form, "endpointProtocol"),
          providerModelIds: readTextValues(form, "providerModelIds"),
          strategy: readText(form, "strategy"),
          virtualModelId: readText(form, "virtualModelId"),
        }),
      });
    } else if (action === "delete") {
      await deleteRoutePolicy({
        id: readRequiredText(form, "id"),
      });
    } else {
      return NextResponse.json(
        { error: "Unknown route policy action.", code: "route_policy_action_unknown" },
        { status: 400 },
      );
    }
  } catch (error) {
    return consoleActionErrorResponse(error, "Route Policy action failed.");
  }

  return redirectToConsolePath("/models");
});
