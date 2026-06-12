import { pathToFileURL } from "node:url";
import { loadBootstrapRuntimeConfig } from "@llmingress/config";
import Fastify from "fastify";

export function createGatewayApp() {
  const app = Fastify({
    logger: true,
  });

  app.get("/health", async () => ({
    service: "gateway",
    status: "ok",
  }));

  return app;
}

export async function startGateway() {
  const config = loadBootstrapRuntimeConfig();
  const app = createGatewayApp();

  await app.listen({
    host: "0.0.0.0",
    port: config.gatewayPort,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startGateway().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
