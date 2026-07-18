import { gatewayPublicBaseUrl } from "@llmingress/config";
import { PageHeader } from "../../_components/page-header";
import { Playground } from "../../playground";

function getPlaygroundGatewayBaseUrl(): string {
  return gatewayPublicBaseUrl();
}

export default function PlaygroundPage() {
  return (
    <div className="page playground-page">
      <PageHeader
        title="Playground"
        description={
          <>
            <span>Test live requests through the Gateway Public API.</span>
            <span className="playground-memory-note">
              Note: API key stays in browser memory only. The Console backend does not store
              plaintext keys.
            </span>
          </>
        }
      />
      <Playground defaultGatewayBaseUrl={getPlaygroundGatewayBaseUrl()} />
    </div>
  );
}
