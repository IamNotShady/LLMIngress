export const realAgentOpenAICompatibleSmokeNames = {
  agentApiKey: "llmi_real_agent_openai_smoke_key_059",
  providerApiKey: "sk-fake-provider-real-agent-openai-059",
  providerModel: "gpt-4.1-mini",
  requestId: "req_real_agent_openai_compatible_059",
  virtualModel: "real-agent-openai-compatible-smoke",
} as const;

export function buildHermesLikeOpenAICompatibleChatBody(
  model = realAgentOpenAICompatibleSmokeNames.virtualModel,
) {
  return {
    max_tokens: 8192,
    messages: [
      {
        content:
          "You are Hermes, a local coding agent running through an OpenAI-compatible gateway. Use tools when needed, keep repository state exact, and do not reject long development prompts by default.",
        role: "system",
      },
      {
        content: buildLargeAgentPrompt(),
        role: "user",
      },
    ],
    model,
    stream: false,
    temperature: 0.1,
    tool_choice: "auto",
    tools: [
      {
        function: {
          description: "Read a UTF-8 text file from the active workspace.",
          name: "read_file",
          parameters: {
            additionalProperties: false,
            properties: {
              path: {
                description: "Absolute path to read.",
                type: "string",
              },
            },
            required: ["path"],
            type: "object",
          },
        },
        type: "function",
      },
      {
        function: {
          description: "Run a shell command in the active workspace.",
          name: "run_terminal_command",
          parameters: {
            additionalProperties: false,
            properties: {
              command: {
                description: "Command and arguments to execute.",
                type: "string",
              },
              timeout_ms: {
                description: "Maximum runtime in milliseconds.",
                type: "integer",
              },
            },
            required: ["command"],
            type: "object",
          },
        },
        type: "function",
      },
    ],
  } as const;
}

function buildLargeAgentPrompt(): string {
  const repeatedContext = Array.from({ length: 120 }, (_, index) => {
    const lineNumber = String(index + 1).padStart(3, "0");
    return `${lineNumber}. Inspect repository files, preserve existing behavior, write focused tests first, run verification, and report concrete evidence for the feature boundary.`;
  }).join("\n");

  return [
    "Complete one remaining feature in a TypeScript monorepo.",
    "The request intentionally includes a sizeable working-memory block and function tool schemas to match local agent clients.",
    repeatedContext,
    "Return a concise implementation summary only after tests and regression pass.",
  ].join("\n\n");
}
