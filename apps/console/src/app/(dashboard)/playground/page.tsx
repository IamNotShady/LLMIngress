import { PageHeader } from "../../_components/page-header";
import { Playground } from "../../playground";

function getPlaygroundGatewayBaseUrl(): string {
  return process.env.GATEWAY_PUBLIC_BASE_URL?.trim() || "http://127.0.0.1:4000";
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
              Note: Agent API Key stays in browser memory only. The Console backend does not store
              plaintext keys.
            </span>
          </>
        }
      />
      <Playground defaultGatewayBaseUrl={getPlaygroundGatewayBaseUrl()} />
    </div>
  );
}
