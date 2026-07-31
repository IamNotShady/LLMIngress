import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, type Page, test } from "@playwright/test";
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

/** The virtual model whose seeded route matched the tag it was asked for. */
const HIT_MODEL = "tag-hit-vm";
/** The one whose seeded route fell back to the default candidate. */
const MISS_MODEL = "tag-miss-vm";

/** Every request the stub gateway actually received. */
type SentRequest = {
  requestId: string | undefined;
  routeTag: string | undefined;
};

/**
 * A gateway that answers preflights the way the real one does — with the same
 * static allowlist apps/gateway/src/cors.ts states — because a browser will not
 * send a custom header until one says it may.
 */
function startHeaderProbeGateway(sent: SentRequest[]): Promise<{
  close: () => Promise<void>;
  url: string;
}> {
  const server: Server = createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }
    if (request.url?.startsWith("/v1/models")) {
      response.writeHead(200, { ...corsHeaders(), "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: HIT_MODEL }, { id: MISS_MODEL }] }));
      return;
    }

    let requestBody = "";
    request.on("data", (chunk) => {
      requestBody += String(chunk);
    });
    request.on("end", () => {
      const routeTag = request.headers["x-llmingress-route-tag"];
      const incomingRequestId = request.headers["x-request-id"];
      sent.push({
        requestId: Array.isArray(incomingRequestId) ? incomingRequestId[0] : incomingRequestId,
        routeTag: Array.isArray(routeTag) ? routeTag[0] : routeTag,
      });
      const activityRequestId = requestBody.includes(MISS_MODEL)
        ? "playground-tag-miss-request"
        : "playground-tag-hit-request";
      response.writeHead(200, {
        ...corsHeaders(),
        "content-type": "application/json",
        "x-llmingress-request-id": activityRequestId,
      });
      response.end(
        JSON.stringify({ choices: [{ message: { content: "answered by the stub gateway" } }] }),
      );
    });
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
    "access-control-allow-headers":
      "authorization, content-type, x-api-key, x-request-id, x-client-request-id, x-llmingress-route-tag, openai-organization, openai-project, openai-beta, anthropic-version, anthropic-beta",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "x-llmingress-request-id",
  };
}

/** The value beside a Route trace label, which is the row's second cell. */
function traceValue(page: Page, label: string) {
  return page.getByText(label, { exact: true }).locator("xpath=following-sibling::span");
}

/**
 * Two requests as the gateway would have recorded them: one whose tag named a
 * candidate, and one whose tag named none and was served by the default anyway.
 */
async function seedTagRoutes(databaseUrl: string): Promise<void> {
  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    const providerId = randomUUID();
    const taggedModelId = randomUUID();
    const defaultModelId = randomUUID();
    const apiKeyId = randomUUID();
    await client.query(
      `insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
       values ($1, 'api_key', 'deepseek', 'Stub Provider', 'https://stub.test/v1', true)`,
      [providerId],
    );
    await client.query(
      `insert into provider_models (id, provider_id, model_id, display_name, availability)
       values ($1, $2, 'stub-tagged-model', 'Stub Tagged Model', 'available'),
              ($3, $2, 'stub-default-model', 'Stub Default Model', 'available')`,
      [taggedModelId, providerId, defaultModelId],
    );
    await client.query(
      `insert into api_keys (id, name, key_prefix, key_hash, enabled)
       values ($1, 'header-probe-key', 'llmi_header', gen_random_uuid()::text, true)`,
      [apiKeyId],
    );

    const insertActivity = async (
      requestId: string,
      model: string,
      providerModelId: string,
      providerModelName: string,
      routeReason: unknown,
    ) => {
      await client.query(
        `insert into request_activity (
           id, request_id, api_key_id, api_key_prefix, protocol, model, stream, status, http_status,
           latency_ms, route_reason, started_at, completed_at,
           provider_id, provider_model_id, provider_display_name_snapshot,
           provider_model_name_snapshot
         )
         values ($1, $2, $6, 'llmi_header', 'chat_completions', $3, false, 'succeeded', 200, 90,
                 $4::jsonb, now(), now(), $7, $5, 'Stub Provider', $8)`,
        [
          randomUUID(),
          requestId,
          model,
          JSON.stringify(routeReason),
          providerModelId,
          apiKeyId,
          providerId,
          providerModelName,
        ],
      );
    };

    await insertActivity(
      "playground-tag-hit-request",
      HIT_MODEL,
      taggedModelId,
      "stub-tagged-model",
      {
        candidateExplanations: [
          {
            candidateOrder: 2,
            eligible: true,
            providerModelId: taggedModelId,
            reasons: ["selected by tag strategy"],
          },
          {
            candidateOrder: 1,
            eligible: true,
            providerModelId: defaultModelId,
            reasons: ["default candidate"],
          },
        ],
        matchedTag: "fast",
        message: 'tag route for tag-hit-vm selected candidate 2 for tag "fast".',
        requestedTag: "fast",
        selectedCandidateOrder: 2,
        strategy: "tag",
        tagFallback: false,
      },
    );
    await insertActivity(
      "playground-tag-miss-request",
      MISS_MODEL,
      defaultModelId,
      "stub-default-model",
      {
        candidateExplanations: [
          {
            candidateOrder: 1,
            eligible: true,
            providerModelId: defaultModelId,
            reasons: ["default candidate"],
          },
        ],
        message:
          'tag route for tag-miss-vm fell back to default candidate 1 because tag "fast" matched no candidate.',
        requestedTag: "fast",
        selectedCandidateOrder: 1,
        strategy: "tag",
        tagFallback: true,
      },
    );
  });
}

test("the Playground sends a typed route tag and shows what the route did with it", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const sent: SentRequest[] = [];
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_playground_headers_${randomUUID().replaceAll("-", "_")}`,
  });
  const gateway = await startHeaderProbeGateway(sent);

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedTagRoutes(fixture.databaseUrl);
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

        await page.getByLabel("API key", { exact: true }).fill("llmi_header_probe");
        await expect(page.getByLabel("Virtual model")).toHaveValue(HIT_MODEL, { timeout: 20_000 });
        await page.getByLabel("STREAM").selectOption("false");

        // --- A header row picked here reaches the gateway. Until the editor
        // existed the Playground could send only the key and the content type,
        // so a tag route could not be tried from the console at all. A new row
        // opens on the tag header, which is the one this page exists to send.
        await page.getByRole("button", { name: "Add header", exact: true }).click();
        await expect(page.getByLabel("Header name 1", { exact: true })).toHaveValue(
          "x-llmingress-route-tag",
        );
        await page.getByLabel("Header value 1", { exact: true }).fill("fast");
        await page.getByRole("button", { name: "Send request" }).click();

        await expect(page.getByText("200 OK")).toBeVisible({ timeout: 20_000 });
        expect(sent.at(-1)?.routeTag).toBe("fast");
        expect(sent.at(-1)?.requestId).toMatch(/^playground_[0-9a-f-]{36}$/);
        // --- and what the route made of it: the tag matched a candidate.
        await expect(traceValue(page, "route tag")).toHaveText("fast", { timeout: 20_000 });

        // --- A tag that matched no candidate was still answered, by the
        // default candidate. The 200 body cannot say so; the trace has to.
        await page.getByLabel("Virtual model").selectOption(MISS_MODEL);
        await page.getByRole("button", { name: "Send request" }).click();
        await expect(traceValue(page, "route tag")).toHaveText("fast → default (no match)", {
          timeout: 20_000,
        });
        expect(sent).toHaveLength(2);
        expect(sent[1]?.requestId).toMatch(/^playground_[0-9a-f-]{36}$/);
        expect(sent[1]?.requestId).not.toBe(sent[0]?.requestId);

        // --- A second row for a header the first row already carries is not a
        // merge and not a silent overwrite: it is said in red and it stops the
        // send, because only the operator knows which of the two was meant.
        await page.getByRole("button", { name: "Add header", exact: true }).click();
        await page.getByLabel("Header value 2", { exact: true }).fill("cheap");
        await expect(
          page.getByText("row 2: x-llmingress-route-tag is already set on a row above"),
        ).toBeVisible();
        const beforeBlocked = sent.length;
        await page.getByRole("button", { name: "Send request" }).click();
        await expect(page.getByText("header rows", { exact: false })).toBeVisible();
        expect(sent.length).toBe(beforeBlocked);

        // --- An empty value is a row that was started and not finished. Sending
        // it would put a blank header on the wire and change the route silently.
        await page.getByLabel("Header value 2", { exact: true }).fill("");
        await expect(page.getByText("row 2: x-llmingress-route-tag has no value")).toBeVisible();
        await page.getByRole("button", { name: "Send request" }).click();
        expect(sent.length).toBe(beforeBlocked);

        // --- Removing the row removes the reason the send was stopped, and the
        // request goes out carrying the row that is left.
        await page.getByRole("button", { name: "Remove header row 2" }).click();
        await expect(page.getByLabel("Header value 2", { exact: true })).toHaveCount(0);
        await expect(page.getByText("row 2:", { exact: false })).toHaveCount(0);
        await page.getByRole("button", { name: "Send request" }).click();
        await expect(traceValue(page, "route tag")).toHaveText("fast → default (no match)", {
          timeout: 20_000,
        });
        expect(sent).toHaveLength(3);
        expect(sent.at(-1)?.routeTag).toBe("fast");
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
