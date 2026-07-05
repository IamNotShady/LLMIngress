import { readFileSync } from "node:fs";
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
});
