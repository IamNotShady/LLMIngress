import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildTagRouteCoverageWarnings,
  normalizeRoutePolicyFormInput,
  type TagRouteCoverageCandidate,
} from "../../packages/db/src/console-route-policies";

const virtualModelId = randomUUID();
const modelIds = [randomUUID(), randomUUID(), randomUUID()] as const;

function normalizeTagForm(input: {
  candidateTags: string[];
  providerModelIds?: readonly string[];
  strategy?: string;
}) {
  return normalizeRoutePolicyFormInput({
    candidateTags: input.candidateTags,
    endpointProtocol: "chat_completions",
    providerModelIds: input.providerModelIds ?? modelIds.slice(0, input.candidateTags.length),
    strategy: input.strategy ?? "tag",
    virtualModelId,
  });
}

function coverageCandidate(
  overrides: Partial<TagRouteCoverageCandidate> = {},
): TagRouteCoverageCandidate {
  return {
    contextWindow: 128_000,
    inputModalities: ["text"],
    maxOutputTokens: 8_192,
    optionLabel: "OpenAI - Default (default-model)",
    outputModalities: ["text"],
    supportsFunctionCalling: true,
    supportsReasoning: true,
    tags: ["default"],
    ...overrides,
  };
}

function taggedCoverageCandidate(
  overrides: Partial<TagRouteCoverageCandidate> = {},
): TagRouteCoverageCandidate {
  return coverageCandidate({
    optionLabel: "OpenAI - Fast (fast-model)",
    tags: ["fast"],
    ...overrides,
  });
}

describe("tag route policy form normalization", () => {
  it("keeps one normalized tag list per candidate, aligned with the candidate order", () => {
    expect(normalizeTagForm({ candidateTags: ["Default, Cheap", " fast "] })).toMatchObject({
      candidateTags: [["default", "cheap"], ["fast"]],
      strategy: "tag",
    });
  });

  it("refuses a tag shape a request header cannot carry", () => {
    expect(() => normalizeTagForm({ candidateTags: ["default", "not a tag!"] })).toThrow(
      expect.objectContaining({ code: "route_policy_tag_invalid" }),
    );
  });

  it("refuses the same tag on two candidates", () => {
    expect(() => normalizeTagForm({ candidateTags: ["default, fast", "fast"] })).toThrow(
      expect.objectContaining({ code: "route_policy_tag_duplicate" }),
    );
    // Two default candidates are the same collision: the fallback must be one row.
    expect(() => normalizeTagForm({ candidateTags: ["default", "default"] })).toThrow(
      expect.objectContaining({ code: "route_policy_tag_duplicate" }),
    );
  });

  it("requires exactly one candidate to carry the default tag", () => {
    expect(() => normalizeTagForm({ candidateTags: ["fast", "cheap"] })).toThrow(
      expect.objectContaining({ code: "route_policy_tag_default_required" }),
    );
  });

  it("requires every candidate of a tag route to carry a tag", () => {
    expect(() => normalizeTagForm({ candidateTags: ["default", "  "] })).toThrow(
      expect.objectContaining({ code: "route_policy_tag_missing" }),
    );
    expect(() =>
      normalizeRoutePolicyFormInput({
        endpointProtocol: "chat_completions",
        providerModelIds: modelIds.slice(0, 2),
        strategy: "tag",
        virtualModelId,
      }),
    ).toThrow(expect.objectContaining({ code: "route_policy_tag_missing" }));
  });

  it("clears candidate tags for the strategies that do not route by tag", () => {
    expect(
      normalizeTagForm({ candidateTags: ["default", "fast"], strategy: "fixed" }),
    ).toMatchObject({
      candidateTags: [[], []],
      strategy: "fixed",
    });
  });
});

describe("tag route coverage warnings", () => {
  it("reports a default candidate that cannot absorb a tagged candidate's request", () => {
    const warnings = buildTagRouteCoverageWarnings([
      coverageCandidate(),
      taggedCoverageCandidate({ contextWindow: 200_000 }),
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("OpenAI - Fast (fast-model)");
    expect(warnings[0]).toContain("context window");
    expect(warnings[0]).toContain("200000");
    expect(warnings[0]).toContain("128000");
  });

  it("reports a smaller default output ceiling", () => {
    const warnings = buildTagRouteCoverageWarnings([
      coverageCandidate(),
      taggedCoverageCandidate({ maxOutputTokens: 16_384 }),
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("max output tokens");
  });

  it("reports input and output modalities the default candidate does not accept", () => {
    const warnings = buildTagRouteCoverageWarnings([
      coverageCandidate(),
      taggedCoverageCandidate({
        inputModalities: ["text", "image"],
        outputModalities: ["text", "image"],
      }),
    ]);

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("input modalities");
    expect(warnings[0]).toContain("image");
    expect(warnings[1]).toContain("output modalities");
  });

  it("reports function calling and reasoning the default candidate cannot serve", () => {
    const warnings = buildTagRouteCoverageWarnings([
      coverageCandidate({ supportsFunctionCalling: false, supportsReasoning: false }),
      taggedCoverageCandidate(),
    ]);

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("function calling");
    expect(warnings[1]).toContain("reasoning");
  });

  it("stays silent on unknown values rather than guessing coverage", () => {
    expect(
      buildTagRouteCoverageWarnings([
        coverageCandidate({
          contextWindow: null,
          inputModalities: null,
          maxOutputTokens: null,
          outputModalities: null,
          supportsFunctionCalling: null,
          supportsReasoning: null,
        }),
        taggedCoverageCandidate({ contextWindow: 200_000 }),
      ]),
    ).toEqual([]);

    expect(
      buildTagRouteCoverageWarnings([
        coverageCandidate(),
        taggedCoverageCandidate({
          contextWindow: null,
          inputModalities: null,
          maxOutputTokens: null,
          outputModalities: null,
          supportsFunctionCalling: null,
          supportsReasoning: null,
        }),
      ]),
    ).toEqual([]);
  });

  it("stays silent when the default candidate covers every tagged candidate", () => {
    expect(
      buildTagRouteCoverageWarnings([
        coverageCandidate({
          contextWindow: 1_000_000,
          inputModalities: ["text", "image"],
          maxOutputTokens: 32_000,
        }),
        taggedCoverageCandidate(),
        taggedCoverageCandidate({
          optionLabel: "OpenAI - Cheap (cheap-model)",
          supportsFunctionCalling: false,
          supportsReasoning: false,
          tags: ["cheap"],
        }),
      ]),
    ).toEqual([]);
  });

  it("stays silent for a candidate set with no default tag", () => {
    expect(
      buildTagRouteCoverageWarnings([
        taggedCoverageCandidate({ contextWindow: 200_000 }),
        taggedCoverageCandidate({ optionLabel: "OpenAI - Cheap (cheap-model)", tags: ["cheap"] }),
      ]),
    ).toEqual([]);
  });
});
