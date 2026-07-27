import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import {
  createTestPostgresFixture,
  runMigrations,
  withDedicatedPostgresClient,
} from "../../packages/db/src/index";
import {
  getFreePort,
  signInFromFirstRun,
  startConsoleProcess,
  stopConsoleProcess,
  waitForConsole,
} from "../support/console-app";

// Wide enough that a loaded machine still observes the partial answer: the
// claim is that text renders before the request finishes, not that a poll lands
// between two particular frames.
const FRAME_GAP_MS = 1200;
const FRAMES = ["first ", "second ", "third"];
/** Asking for this model gets a stream that is cut off after one frame. */
const CUT_MODEL = "cut-stream-vm";

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
      response.end(JSON.stringify({ data: [{ id: "stream-vm" }, { id: CUT_MODEL }] }));
      return;
    }
    // A key the gateway does not accept: nothing is counted against limits and
    // nothing reaches Activity, because there is no key to attribute it to.
    if (request.url?.startsWith("/v1/responses")) {
      response.writeHead(401, { ...corsHeaders(), "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { code: "invalid_api_key", message: "Unknown API key." } }),
      );
      return;
    }
    // The endpoint this virtual model is not routed to answers the way the
    // gateway does: a code and a message, not an empty body.
    if (request.url?.startsWith("/v1/messages")) {
      response.writeHead(400, {
        ...corsHeaders(),
        "content-type": "application/json",
        "x-llmingress-request-id": "playground-refused-request",
      });
      response.end(
        JSON.stringify({
          error: {
            code: "route_not_found",
            message: "No route policy is available for the selected Virtual Model.",
          },
          requestId: "playground-refused-request",
        }),
      );
      return;
    }

    let requestBody = "";
    request.on("data", (chunk) => {
      requestBody += String(chunk);
    });
    request.on("end", () => {
      // A stream that stops in the middle: the socket closes after one frame,
      // which is what a dropped connection looks like to the reader.
      if (requestBody.includes(CUT_MODEL)) {
        response.writeHead(200, {
          ...corsHeaders(),
          "content-type": "text/event-stream",
          "x-llmingress-request-id": "playground-cut-request",
        });
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "half " } }] })}\n\n`,
        );
        setTimeout(() => response.destroy(), 200);
        return;
      }
      streamFrames(response);
    });
  });

  function streamFrames(response: ServerResponse): void {
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
    // The request stream ends as soon as its body is read, so the timer follows
    // the response: it stops when the answer is finished or the client leaves.
    response.on("close", () => clearInterval(timer));
  }

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

/**
 * The request the stub gateway is about to answer, as the gateway would have
 * recorded it: the console polls its own trace by request id, and the route it
 * shows has to be the recorded one rather than a guess from the response.
 */
async function seedRecordedRoute(databaseUrl: string): Promise<void> {
  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    const providerId = randomUUID();
    const servingModelId = randomUUID();
    const filteredModelId = randomUUID();
    const apiKeyId = randomUUID();
    await client.query(
      `insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
       values ($1, 'api_key', 'deepseek', 'Stub Provider', 'https://stub.test/v1', true)`,
      [providerId],
    );
    await client.query(
      `insert into provider_models (id, provider_id, model_id, display_name, availability)
       values ($1, $2, 'stub-serving-model', 'Stub Serving Model', 'available'),
              ($3, $2, 'stub-filtered-model', 'Stub Filtered Model', 'available')`,
      [servingModelId, providerId, filteredModelId],
    );
    await client.query(
      `insert into api_keys (id, name, key_prefix, key_hash, enabled)
       values ($1, 'stream-probe-key', 'llmi_stream', gen_random_uuid()::text, true)`,
      [apiKeyId],
    );
    await client.query(
      `insert into request_activity (
         id, request_id, api_key_id, api_key_prefix, protocol, model, stream, status, http_status,
         latency_ms, route_reason, started_at, completed_at,
         provider_id, provider_model_id, provider_display_name_snapshot,
         provider_model_name_snapshot
       )
       values ($1, 'playground-stream-request', $5, 'llmi_stream', 'chat_completions', 'stream-vm',
               true, 'succeeded', 200, 120, $2::jsonb, now(), now(), $3, $4,
               'Stub Provider', 'stub-serving-model')`,
      [
        randomUUID(),
        JSON.stringify({
          candidateExplanations: [
            {
              candidateOrder: 1,
              eligible: true,
              providerModelId: servingModelId,
              reasons: ["selected by fixed strategy"],
            },
            {
              candidateOrder: 2,
              eligible: false,
              providerModelId: filteredModelId,
              reasons: ["context window is too small"],
            },
          ],
          message: "fixed route for stream-vm",
        }),
        providerId,
        servingModelId,
        apiKeyId,
      ],
    );
  });
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
    await seedRecordedRoute(fixture.databaseUrl);
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

        // Text is on screen while the rest is still being written: reading the
        // whole body first would show nothing until the end.
        const streamed = page.getByTestId("playground-stream");
        await expect(streamed).toContainText("first", { timeout: 20_000 });
        await expect(page.getByText("streaming…")).toBeVisible();
        await expect(page.getByText("200 OK")).toHaveCount(0);
        await expect(streamed).toContainText("second", { timeout: 20_000 });

        // When it ends, the answer is the whole answer and the response panel
        // takes over from the live one.
        await expect(page.getByText("200 OK")).toBeVisible({ timeout: 20_000 });
        await expect(page.getByTestId("playground-stream")).toHaveCount(0);
        await expect(page.getByText("first second third")).toBeVisible();

        // --- The route the gateway took, including the candidate it dropped
        // before trying anything. It is recorded on the request and nowhere in
        // the answer, which is the reason to read a trace at all.
        await expect(page.getByText("1 — listed below")).toBeVisible({ timeout: 20_000 });
        await expect(page.getByText("FILTERED OUT")).toBeVisible();
        await expect(
          page.getByText("Stub Provider · Stub Filtered Model — context window is too small"),
        ).toBeVisible();

        // --- A refused request says why. The status alone leaves the operator
        // guessing which of the controls on the left was the wrong one.
        await page.getByRole("button", { name: "messages", exact: true }).click();
        await page.getByRole("button", { name: "Send request" }).click();
        await expect(page.getByText("400 error")).toBeVisible({ timeout: 20_000 });
        await expect(
          page.getByText(
            "route_not_found · No route policy is available for the selected Virtual Model.",
          ),
        ).toBeVisible();
        await expect(page.getByText("No response text")).toHaveCount(0);

        // --- A key the gateway did not accept counted against nothing. The
        // toast used to promise Activity would show it, which sends the
        // operator looking for a request that was never recorded.
        await page.getByRole("button", { name: "responses", exact: true }).click();
        await page.getByRole("button", { name: "Send request" }).click();
        await expect(page.getByText("401 error")).toBeVisible({ timeout: 20_000 });
        await expect(page.getByText("Gateway returned an error")).toBeVisible();
        await expect(page.getByText("It counted toward the key's limits")).toHaveCount(0);
        await expect(page.getByText("did not accept this key")).toBeVisible();

        // --- A stream that stops in the middle stops saying it is streaming.
        // The pane used to sit on "streaming…" for the rest of the session,
        // with the error only in the small line under the controls.
        await page.getByRole("button", { name: "chat_completions", exact: true }).click();
        await page.getByLabel("Virtual model").selectOption(CUT_MODEL);
        await page.getByRole("button", { name: "Send request" }).click();
        await expect(page.getByText("Could not reach Gateway")).toBeVisible({ timeout: 20_000 });
        await expect(page.getByText("streaming…")).toHaveCount(0);
        await expect(page.getByTestId("playground-stream")).toHaveCount(0);
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
