import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function src(path: string): string {
  return readFileSync(path, "utf8");
}

describe("gateway cohesion fitness", () => {
  it("loads gateway source files for structural assertions", () => {
    expect(src("packages/db/src/gateway-chat-completions.ts")).toContain(
      "executeGatewayOpenAIChatCompletion",
    );
  });

  it("credential subsystem lives outside the chat endpoint module", () => {
    const chat = src("packages/db/src/gateway-chat-completions.ts");
    expect(chat).not.toContain("readProviderCredentials");
    expect(chat).not.toContain("refreshProviderOAuthTokenWithLock");
    expect(chat).not.toContain("provider_oauth");
    for (const file of ["gateway-embeddings", "gateway-responses", "gateway-messages"]) {
      expect(src(`packages/db/src/${file}.ts`)).not.toContain('from "./gateway-chat-completions');
    }
    const streamingChatImport = src("packages/db/src/gateway-streaming.ts").match(
      /import \{([^}]*)\} from "\.\/gateway-chat-completions\.ts"/s,
    );
    const imported = (streamingChatImport?.[1] ?? "")
      .split(",")
      .map((symbol) => symbol.trim())
      .filter(Boolean);
    expect(imported).toEqual(["normalizeOpenAIChatCompletionRequest"]);
  });

  it("uses one gateway error code union without casts", () => {
    for (const file of [
      "gateway-chat-completions",
      "gateway-embeddings",
      "gateway-messages",
      "gateway-responses",
      "gateway-streaming",
    ]) {
      const content = src(`packages/db/src/${file}.ts`);
      expect(content).not.toMatch(/as Gateway\w+ErrorCode/);
      expect(content).not.toMatch(/^export type Gateway\w+ErrorCode/m);
    }
  });

  it("keeps SSE parsing, baseline selection, and budget math out of the usage recorder", () => {
    const recorder = src("packages/db/src/gateway-usage-recorder.ts");
    expect(recorder).not.toContain("createGatewayStreamingUsageCollector");
    expect(recorder).not.toContain("selectGatewayBaselineCandidate");
    expect(recorder).not.toContain("buildGatewayBudgetActualUsage");
  });

  it("keeps orchestration calls only in the protocol template", () => {
    for (const file of [
      "gateway-chat-completions",
      "gateway-embeddings",
      "gateway-messages",
      "gateway-responses",
    ]) {
      const content = src(`packages/db/src/${file}.ts`);
      expect(content).not.toContain("enforceGatewayRateLimits");
      expect(content).not.toContain("reserveGatewayBudget");
      expect(content).not.toContain("selectRouteAttempts");
      expect(content).not.toContain("releaseGatewayConcurrency");
    }
  });

  it("resolves provider dialects through the registry, not string dispatch", () => {
    const streaming = src("packages/db/src/gateway-streaming.ts");
    expect(streaming).not.toMatch(/providerKey === "/);
    expect(streaming).toContain("resolveProviderStreamingDialect");
  });

  it("owns stream wrapper composition in one module", () => {
    const streaming = src("packages/db/src/gateway-streaming.ts");
    expect(streaming).not.toContain("wrapProviderStreamWithErrorRecording(");
    expect(streaming).toContain("composeGatewayProviderStreamPipeline");
    const recording = src("apps/gateway/src/request-recording.ts");
    expect(recording).not.toContain("finalizeGatewayBudgetReservation");
    expect(recording).toContain("settleGatewayStreamBudget");
  });

  it("centralizes gateway env readers and agent naming", () => {
    for (const file of [
      "gateway-streaming",
      "gateway-budgets",
      "gateway-request-metadata",
      "gateway-stream-pipeline",
    ]) {
      expect(src(`packages/db/src/${file}.ts`)).not.toMatch(/process\.env\.(GATEWAY|LLMINGRESS)_/);
    }
    const allowedAgentApiKeyIdCompatibility = 'readRequiredText(form, "agentId", "agentApiKeyId")';
    for (const file of allSourceFiles([
      "packages/db/src",
      "apps/gateway/src",
      "apps/console/src",
      "apps/worker/src",
    ])) {
      const forbiddenLines = src(file)
        .split("\n")
        .filter(
          (line) =>
            line.includes("agentApiKey" + "Id") &&
            !line.includes(allowedAgentApiKeyIdCompatibility),
        );
      expect(forbiddenLines).toEqual([]);
    }
  });
});

function allSourceFiles(directories: string[]): string[] {
  const files: string[] = [];
  for (const directory of directories) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        files.push(...allSourceFiles([path]));
      } else if (entry.isFile() && (path.endsWith(".ts") || path.endsWith(".tsx"))) {
        files.push(path);
      }
    }
  }
  return files;
}
