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
            <span>通过 Gateway Public API 进行实时测试</span>
            <span className="playground-memory-note">
              提示：Agent API Key 只保存在浏览器内存中，Console 后端不保存明文。
            </span>
          </>
        }
      />
      <Playground defaultGatewayBaseUrl={getPlaygroundGatewayBaseUrl()} />
    </div>
  );
}
