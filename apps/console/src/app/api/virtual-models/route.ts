import { normalizeRoutePolicyFormInput } from "@llmingress/db/console-route-policies";
import {
  createVirtualModelWithRoute,
  deleteVirtualModel,
  normalizeVirtualModelFormInput,
  updateVirtualModel,
  updateVirtualModelWithRoute,
} from "@llmingress/db/console-virtual-models";
import { NextResponse } from "next/server";
import { withConsoleAuth } from "../_auth";
import { consoleActionErrorResponse } from "../_errors";
import { readRequiredText, readText, readTextValues } from "../_form";
import { redirectToConsolePath } from "../_redirect";

export const POST = withConsoleAuth(async (request) => {
  const form = await request.formData();
  const action = readText(form, "action");

  try {
    if (action === "createWithRoute") {
      await createVirtualModelWithRoute({
        routePolicy: {
          endpointProtocol: readText(form, "endpointProtocol"),
          providerModelIds: readTextValues(form, "providerModelIds"),
          strategy: readText(form, "strategy"),
        },
        virtualModel: normalizeVirtualModelFormInput({
          description: readText(form, "description"),
          name: readText(form, "name"),
        }),
      });
    } else if (action === "update") {
      await updateVirtualModel({
        id: readRequiredText(form, "id"),
        virtualModel: normalizeVirtualModelFormInput({
          description: readText(form, "description"),
          name: readText(form, "name"),
        }),
      });
    } else if (action === "updateWithRoute") {
      // The editor saves the model and its route with one button, so they are
      // one write: a route the contract refuses must not leave a rename behind.
      const virtualModelId = readRequiredText(form, "id");
      const routePolicyId = readText(form, "routePolicyId");
      const providerModelIds = readTextValues(form, "providerModelIds");
      await updateVirtualModelWithRoute({
        id: virtualModelId,
        routePolicy:
          providerModelIds.length > 0
            ? normalizeRoutePolicyFormInput({
                endpointProtocol: readText(form, "endpointProtocol"),
                providerModelIds,
                strategy: readText(form, "strategy"),
                virtualModelId,
              })
            : null,
        routePolicyId: routePolicyId ?? null,
        virtualModel: normalizeVirtualModelFormInput({
          description: readText(form, "description"),
          name: readText(form, "name"),
        }),
      });
    } else if (action === "delete") {
      await deleteVirtualModel({
        id: readRequiredText(form, "id"),
      });
    } else {
      return NextResponse.json(
        { error: "Unknown virtual model action.", code: "virtual_model_action_unknown" },
        { status: 400 },
      );
    }
  } catch (error) {
    return consoleActionErrorResponse(error, "Virtual Model action failed.");
  }

  return redirectToConsolePath("/models");
});
