import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gatewayListenHost } from "../../packages/gateway-runtime/src/gateway-env";

describe("gateway listen host", () => {
  it("defaults to loopback when GATEWAY_HOST is unset", () => {
    expect(gatewayListenHost({})).toBe("127.0.0.1");
  });

  it("honors a GATEWAY_HOST override", () => {
    expect(gatewayListenHost({ GATEWAY_HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });

  it("treats blank GATEWAY_HOST as unset", () => {
    expect(gatewayListenHost({ GATEWAY_HOST: "   " })).toBe("127.0.0.1");
  });

  it("keeps the hardcoded bind address out of gateway main", () => {
    const source = readFileSync("apps/gateway/src/main.ts", "utf8");
    expect(source).not.toContain('"0.0.0.0"');
    expect(source).toContain("gatewayListenHost()");
  });

  it("keeps Docker listening on all interfaces", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");
    expect(compose).toContain("GATEWAY_HOST: 0.0.0.0");
  });
});
