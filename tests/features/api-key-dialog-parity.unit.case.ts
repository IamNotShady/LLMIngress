import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PLAYGROUND_KEY_HANDOFF } from "../../apps/console/src/app/_ui/playground/handoff.ts";
import { standaloneThemeCss } from "../../apps/console/src/app/api/_standalone-theme.ts";
import { renderOneTimeApiKeyResponse } from "../../apps/console/src/app/api/api-keys/_created-page.ts";

const rootDir = process.cwd();
const appDir = join(rootDir, "apps/console/src/app");
const source = (file: string) => readFileSync(join(appDir, file), "utf8");

const renderCreatedPage = () =>
  renderOneTimeApiKeyResponse({
    createdAt: new Date("2026-07-26T00:00:00.000Z"),
    defaultVirtualModelName: "contract-vm",
    enabled: true,
    keyPrefix: "llmi_contract",
    limits: [],
    name: "contract-key",
    plaintext: "llmi_contract_secret_value",
    virtualModelName: "contract-vm",
    virtualModels: [],
  }).text();

describe("api key presentation contract", () => {
  test("the plaintext secret appears only on the one-time page", () => {
    const createdPage = source("api/api-keys/_created-page.ts");
    const detail = source("_ui/api-keys/detail.tsx");
    const dialogs = source("_ui/api-keys/dialogs.tsx");

    expect(createdPage).toContain("SECRET · SHOWN ONCE");
    // Everywhere else only the stored prefix exists, and that is all the console
    // renders — the plaintext is not kept anywhere to be shown again.
    expect(detail).toContain("apiKey.keyPrefix");
    expect(detail).not.toContain("plaintext");
    expect(dialogs).not.toContain("plaintext");
    expect(dialogs).toContain(
      "the llmi_ secret cannot be shown or changed — delete the key and issue a new one to rotate it",
    );
  });

  test("the one-time page never introduces a script into interpolated markup", () => {
    const createdPage = source("api/api-keys/_created-page.ts");
    // The page is assembled by string interpolation around user-controlled
    // names; a script tag there turns an escaping slip into code execution. It
    // needs one — the copy buttons — and that is only safe while its body is a
    // constant, so every script tag here must be a bare call into the shared
    // module and nothing else.
    for (const tag of createdPage.match(/<script[\s\S]*?<\/script>/g) ?? []) {
      expect(tag).toMatch(/^<script>\$\{[A-Za-z]+\(\)\}<\/script>$/);
    }
    expect(createdPage).toContain("function escapeHtml");
  });

  test("every copy button on the one-time page points at a value that is there", async () => {
    const html = await renderCreatedPage();
    const targets = [...html.matchAll(/data-copy="#([^"]+)"/g)].map((match) => match[1]);
    // The secret and both Codex snippets, at least — a button that points at
    // nothing looks identical to one that works until it is pressed.
    expect(targets.length).toBeGreaterThanOrEqual(3);
    for (const target of targets) {
      expect(html, target).toContain(`id="${target}"`);
    }
    // Outside the <pre>, or the word "Copy" is copied with the snippet.
    expect(html).not.toMatch(/<pre[^>]*>[^<]*<button/);
  });

  test("the one-time page resolves the theme the way the console does", async () => {
    const html = await renderCreatedPage();
    // It is rendered by the route handler, outside the layout that stamps the
    // attribute, so it carries the same bootstrap and the same rule: a stored
    // choice wins, and only without one does the system preference decide.
    expect(html).toContain("llmingress-console-theme");
    expect(html).toContain(':root[data-theme="dark"]');
    expect(html).toContain(':root:not([data-theme="light"])');
  });

  test("Test in Playground hands the secret over without putting it in a URL", async () => {
    const html = await renderCreatedPage();
    expect(html).toMatch(/<a href="\/playground" data-handoff="#secret">/);
    expect(html).toContain(PLAYGROUND_KEY_HANDOFF);
    // The link itself stays clean: the value rides in sessionStorage.
    expect(html).not.toContain("/playground?");

    const playground = source("_ui/playground/playground.tsx");
    expect(playground).toContain("sessionStorage.getItem(PLAYGROUND_KEY_HANDOFF)");
    expect(playground).toContain("sessionStorage.removeItem(PLAYGROUND_KEY_HANDOFF)");
  });

  test("the created page and the detail view state the same configuration facts", () => {
    const createdPage = source("api/api-keys/_created-page.ts");
    const detail = source("_ui/api-keys/detail.tsx");

    for (const fact of ["gateway", "default model", "limits"]) {
      expect(createdPage, fact).toContain(fact);
    }
    expect(detail).toContain("Virtual Model access");
    expect(detail).toContain("Limits");
  });

  test("the create result carries limits so the created page can render them", () => {
    const db = readFileSync(join(rootDir, "packages/db/src/console-api-keys.ts"), "utf8");
    expect(db).toContain("limits: ConsoleApiKeyLimit[]");
    expect(db).toContain("readApiKeyLimitsWithClient");

    const limits = readFileSync(join(rootDir, "packages/db/src/console-api-key-limits.ts"), "utf8");
    expect(limits).toContain("export async function readApiKeyLimitsWithClient");

    const createdPage = source("api/api-keys/_created-page.ts");
    expect(createdPage).toContain("limits: input.limits");
    expect(createdPage).toContain("virtualModels: input.virtualModels");
  });
});

describe("the pages rendered outside the console shell", () => {
  const standaloneCss = standaloneThemeCss();
  const globals = readFileSync(join(rootDir, "apps/console/src/app/globals.css"), "utf8");
  const pages = [
    ["api/api-keys/_created-page.ts", source("api/api-keys/_created-page.ts")],
    ["api/provider-keys/route.ts", source("api/provider-keys/route.ts")],
  ] as const;

  const defined = new Set(
    Array.from(standaloneCss.matchAll(/(--[a-z0-9-]+)\s*:/g), (match) => match[1] as string),
  );

  test("define every token they use", () => {
    // The sheet is a hand-written copy of the console's tokens, and a page that
    // reaches for one it forgot to copy renders with the property unset — an
    // invisible border, black-on-black text — with nothing to catch it.
    for (const [name, page] of pages) {
      for (const [, token] of page.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
        expect(defined, `${name} uses ${token}`).toContain(token);
      }
      // And no colour written by hand beside the tokens — including inside a
      // shadow, which is where the last hand-written rgba was hiding.
      expect(page, name).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(page, name).not.toMatch(/box-shadow:[^;]*(?:#[0-9a-f]{3,8}|rgba?\()/i);
    }
  });

  test("copy the console's own values, so the two cannot drift apart", () => {
    // The two font tokens are named differently on purpose: the console's
    // resolve to next/font variables, which are stamped by the layout these
    // pages are rendered outside of, so they carry the families themselves.
    const namedDifferently = new Set(["--sans", "--mono"]);
    for (const token of defined) {
      if (namedDifferently.has(token)) {
        continue;
      }
      const inGlobals = new RegExp(`${token}:\\s*([^;\\n]+)`).exec(globals);
      expect(inGlobals, `${token} is not a console token`).not.toBeNull();
      const standaloneValue = new RegExp(`${token}:([^;}]+)`).exec(standaloneCss)?.[1]?.trim();
      expect(normalizeCssValue(standaloneValue), token).toBe(
        normalizeCssValue(inGlobals?.[1]?.trim()),
      );
    }
  });
});

/** Whitespace is not a difference; anything else is. */
function normalizeCssValue(value: string | undefined): string {
  return (value ?? "").replaceAll(/\s+/g, "");
}
