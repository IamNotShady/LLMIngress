import { gatewayPublicBaseUrl } from "@llmingress/config";
import { listRoutePolicies } from "@llmingress/db/console-route-policies";
import { PageShell, PageTitleRow } from "../../_ui/layout";
import { Playground } from "../../_ui/playground/playground";

export default async function PlaygroundPage() {
  const routePolicies = await listRoutePolicies();

  return (
    <PageShell label="Playground">
      <PageTitleRow
        title="Playground"
        meta="send a real request through the gateway — it counts toward the key's limits and appears in Activity"
      />
      <Playground
        gatewayBaseUrl={gatewayPublicBaseUrl()}
        virtualModels={routePolicies.map((policy) => ({
          endpointProtocol: policy.endpointProtocol,
          name: policy.virtualModelName,
          strategy: policy.strategy,
        }))}
      />
    </PageShell>
  );
}
