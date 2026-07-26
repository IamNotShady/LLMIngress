import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import {
  getFreePort,
  signInFromFirstRun,
  startConsoleProcess,
  stopConsoleProcess,
  waitForConsole,
} from "../support/console-app";

const FRAME_GAP_MS = 400;
const FRAMES = ["first ", "second ", "third"];

/**
 * A gateway that writes its answer a piece at a time, the way a real one does.
 * Playwright's own route interception cannot express this: it fulfils a request
 * with one body, which is exactly the case that hid this bug.
 */
function startStreamingGateway(): Promise<{ close: () => Promise<void>; url: string }> {
  const server: Server = createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }
    if (request.url?.startsWith("/v1/models")) {
      response.writeHead(200, { ...corsHeaders(), "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "stream-vm" }] }));
      return;
    }

    response.writeHead(200, {
      ...corsHeaders(),
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
      "x-llmingress-request-id": "playground-stream-request",
    });
    let index = 0;
    const timer = setInterval(() => {
      const frame = FRAMES[index];
      index += 1;
      if (frame === undefined) {
        clearInterval(timer);
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: frame } }] })}\n\n`);
    }, FRAME_GAP_MS);
    request.on("close", () => clearInterval(timer));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        close: () => new Promise<void>((done) => server.close(() => done())),
        url: `http://127.0.0.1:${port}`,
      });
    });
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "x-llmingress-request-id",
  };
}

test("the Playground shows a streamed answer while it is still being written", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_playground_stream_${randomUUID().replaceAll("-", "_")}`,
  });
  const gateway = await startStreamingGateway();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const consoleApp = startConsoleProcess({
      databaseUrl: fixture.databaseUrl,
      env: { GATEWAY_URL: gateway.url },
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://localhost:${consoleApp.port}`;
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await waitForConsole(baseUrl, consoleApp);
        await signInFromFirstRun(page, baseUrl);
        await page.goto(`${baseUrl}/playground`, { waitUntil: "networkidle" });

        await page.getByLabel("API key", { exact: true }).fill("llmi_stream_probe");
        await expect(page.getByLabel("STREAM")).toHaveValue("true");
        await page.getByRole("button", { name: "Send request" }).click();

        // The first frame is on screen while the rest are still being written:
        // reading the whole body first would show nothing until the end.
        const streamed = page.getByTestId("playground-stream");
        await expect(streamed).toHaveText("first ", { timeout: 15_000 });
        await expect(page.getByText("streaming…")).toBeVisible();
        await expect(streamed).toHaveText("first second ", { timeout: 15_000 });

        // When it ends, the answer is the whole answer and the response panel
        // takes over from the live one.
        await expect(page.getByText("200 OK")).toBeVisible({ timeout: 20_000 });
        await expect(page.getByTestId("playground-stream")).toHaveCount(0);
        await expect(page.getByText("first second third")).toBeVisible();
      } finally {
        await context.close();
      }
    } finally {
      await stopConsoleProcess(consoleApp);
    }
  } finally {
    await gateway.close();
    await fixture.dispose();
  }
});
