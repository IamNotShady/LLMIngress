import { sessionCookieName, verifyConsoleSession } from "@llmingress/db/console-auth";
import {
  createRoutePolicy,
  normalizeRoutePolicyFormInput,
  updateRoutePolicy,
} from "@llmingress/db/console-route-policies";
import {
  createVirtualModel,
  deleteVirtualModel,
  normalizeVirtualModelFormInput,
  updateVirtualModel,
} from "@llmingress/db/console-virtual-models";
import { type NextRequest, NextResponse } from "next/server";
import { readRequiredText, readText, readTextValues } from "../_form";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const form = await request.formData();
  const action = readText(form, "action");

  try {
    if (action === "create") {
      await createVirtualModel({
        virtualModel: normalizeVirtualModelFormInput({
          description: readText(form, "description"),
          name: readText(form, "name"),
        }),
      });
    } else if (action === "createWithRoute") {
      const virtualModel = await createVirtualModel({
        virtualModel: normalizeVirtualModelFormInput({
          description: readText(form, "description"),
          name: readText(form, "name"),
        }),
      });
      const providerModelIds = readTextValues(form, "providerModelIds");
      if (providerModelIds.length > 0) {
        await createRoutePolicy({
          routePolicy: normalizeRoutePolicyFormInput({
            providerModelIds,
            strategy: readText(form, "strategy"),
            virtualModelId: virtualModel.id,
          }),
        });
      }
    } else if (action === "update") {
      await updateVirtualModel({
        id: readRequiredText(form, "id"),
        virtualModel: normalizeVirtualModelFormInput({
          description: readText(form, "description"),
          name: readText(form, "name"),
        }),
      });
    } else if (action === "updateWithRoute") {
      await updateVirtualModel({
        id: readRequiredText(form, "id"),
        virtualModel: normalizeVirtualModelFormInput({
          description: readText(form, "description"),
          name: readText(form, "name"),
        }),
      });
      const routePolicyId = readText(form, "routePolicyId");
      const providerModelIds = readTextValues(form, "providerModelIds");
      if (routePolicyId && providerModelIds.length > 0) {
        await updateRoutePolicy({
          id: routePolicyId,
          routePolicy: normalizeRoutePolicyFormInput({
            providerModelIds,
            strategy: readText(form, "strategy"),
            virtualModelId: readRequiredText(form, "id"),
          }),
        });
      } else if (!routePolicyId && providerModelIds.length > 0) {
        await createRoutePolicy({
          routePolicy: normalizeRoutePolicyFormInput({
            providerModelIds,
            strategy: readText(form, "strategy"),
            virtualModelId: readRequiredText(form, "id"),
          }),
        });
      }
    } else if (action === "delete") {
      await deleteVirtualModel({
        id: readRequiredText(form, "id"),
      });
    } else {
      return NextResponse.json({ error: "Unknown virtual model action." }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Virtual Model action failed." },
      { status: 400 },
    );
  }

  return NextResponse.redirect(new URL("/models", request.url), { status: 303 });
}
