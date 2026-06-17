import { PageHeader } from "../../_components/page-header";
import { Playground } from "../../playground";

function getPlaygroundGatewayBaseUrl(): string {
  return process.env.GATEWAY_PUBLIC_BASE_URL?.trim() || "http://127.0.0.1:4000";
}

export default function PlaygroundPage() {
  return (
    <div className="page">
      <PageHeader
        eyebrow="Tools"
        title="Playground"
        description="Send a live request through the gateway with an Agent API key."
      />
      <Playground defaultGatewayBaseUrl={getPlaygroundGatewayBaseUrl()} />
    </div>
  );
}
