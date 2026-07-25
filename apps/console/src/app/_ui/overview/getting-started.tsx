import Link from "next/link";
import { ActionLink } from "../controls";
import { buildHref, readParam, type SearchParams } from "../params";

export type SetupCounts = {
  apiKeyCount: number;
  connectionCount: number;
  providerCount: number;
  unlimitedKeyCount: number;
  virtualModelCount: number;
};

/**
 * The four steps a console has to go through before it can serve traffic. Each
 * one is checked from the tables themselves, so the checklist cannot drift from
 * the actual configuration.
 */
export function GettingStarted({ counts, params }: { counts: SetupCounts; params: SearchParams }) {
  const open = readParam(params, "setup") !== "closed";
  const steps = [
    {
      body: "Pick a template, then add an API key, authorize a subscription, or point at a local server. A connection probe and model refresh run automatically.",
      done: counts.providerCount > 0,
      links: [{ href: "/providers", label: "Providers" }],
      note: `${counts.providerCount} providers · ${counts.connectionCount} connections`,
      title: "1 · Connect a provider",
    },
    {
      body: "Give your agents one stable model name, choose its endpoint protocol, then order the provider models it may route to.",
      done: counts.virtualModelCount > 0,
      links: [{ href: "/models", label: "Virtual Models" }],
      note: `${counts.virtualModelCount} ${counts.virtualModelCount === 1 ? "model" : "models"}`,
      title: "2 · Create a virtual model",
    },
    {
      body: "One llmi_ secret per agent, granting the virtual models it may call. Setup snippets for Codex, Claude Code, Cursor and more are shown on creation.",
      done: counts.apiKeyCount > 0,
      links: [{ href: "/api-keys", label: "API Keys" }],
      note: `${counts.apiKeyCount} ${counts.apiKeyCount === 1 ? "key" : "keys"}`,
      title: "3 · Issue an API key",
    },
    {
      body: "Give each key a budget and rate ceiling, then send a real request from the Playground to confirm routing before handing the key over.",
      done: counts.apiKeyCount > 0 && counts.unlimitedKeyCount === 0,
      links: [
        { href: "/limits", label: "Limits" },
        { href: "/playground", label: "Playground" },
      ],
      note:
        counts.unlimitedKeyCount > 0
          ? `${counts.unlimitedKeyCount} ${counts.unlimitedKeyCount === 1 ? "key" : "keys"} unlimited`
          : "every key has rules",
      title: "4 · Set limits, then verify",
    },
  ];
  const doneCount = steps.filter((step) => step.done).length;

  return (
    <>
      <div className="mt-[18px] flex items-center gap-[10px] overflow-x-auto border-b border-hair pb-[6px]">
        <span className="whitespace-nowrap font-sans text-155 font-semibold text-ink">
          Getting started
        </span>
        <span className="font-mono text-12 text-faint">
          {doneCount} of {steps.length} done
        </span>
        <Link
          href={buildHref("/", params, { setup: open ? "closed" : "open" })}
          className="ml-auto flex-none whitespace-nowrap font-mono text-13 text-dim"
        >
          {open ? "Hide" : "Show"}
        </Link>
      </div>

      {open ? (
        <div className="mt-[14px] overflow-x-auto">
          <div className="grid min-w-[1000px] grid-cols-4 gap-[14px]">
            {steps.map((step) => (
              <div
                key={step.title}
                className={`rounded-sm border px-[14px] py-3 ${
                  step.done ? "border-rule bg-btnbg" : "border-ambbd bg-ambbg"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`grid size-[17px] flex-none place-items-center rounded-full font-mono text-115 font-medium ${
                      step.done ? "bg-green text-bg" : "border-[1.5px] border-ambtx text-ambtx"
                    }`}
                  >
                    {step.done ? "✓" : step.title.slice(0, 1)}
                  </span>
                  <span className="font-mono text-13 font-medium text-ink">{step.title}</span>
                </div>
                <p className="mt-2 font-mono text-12 leading-[1.6] text-dim">{step.body}</p>
                <div className="mt-[10px] flex flex-wrap items-center gap-2">
                  {step.links.map((link) => (
                    <ActionLink
                      key={link.href}
                      className="px-[9px] py-[3px] text-12"
                      href={link.href}
                    >
                      {link.label}
                    </ActionLink>
                  ))}
                  <span className={`font-mono text-12 ${step.done ? "text-faint" : "text-ambtx"}`}>
                    {step.note}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
