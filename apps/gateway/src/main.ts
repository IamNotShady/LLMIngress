import { pathToFileURL } from "node:url";
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

async function startGateway() {
  const port = Number.parseInt(process.env.GATEWAY_PORT ?? "4000", 10);
  const app = createGatewayApp();

  await app.listen({
    host: "0.0.0.0",
    port,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startGateway().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
