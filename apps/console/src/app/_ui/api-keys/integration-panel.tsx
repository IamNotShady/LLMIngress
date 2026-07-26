import Link from "next/link";
import { CopyButton } from "../copy-button";
import { buildHref, readParam, type SearchParams } from "../params";
import { buildIntegrationGuides, type IntegrationPlatform } from "./integration-guide";

/**
 * The same setup the one-time screen hands over, available again from the key
 * it belongs to. The secret is the only difference: it was shown once and is
 * stored hashed, so the snippets here carry the prefix and say so — an operator
 * who pastes one unchanged gets a 401, which is a better failure than a snippet
 * that looks complete and quietly authenticates as nothing.
 */
export function IntegrationPanel({
  gatewayBaseUrl,
  keyPrefix,
  model,
  params,
  pathname,
}: {
  gatewayBaseUrl: string;
  /** Stands in for the secret in every snippet. */
  keyPrefix: string;
  model: string;
  params: SearchParams;
  pathname: string;
}) {
  const guides = buildIntegrationGuides({ apiKey: keyPrefix, gatewayBaseUrl, model });
  const selectedPlatform = (readParam(params, "guide") ??
    guides[0]?.platform) as IntegrationPlatform;
  const active = guides.find((entry) => entry.platform === selectedPlatform) ?? guides[0];

  if (!active) {
    return null;
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Integration platform"
        className="flex flex-wrap overflow-x-auto border-b border-hair"
      >
        {guides.map((entry) => (
          <Link
            key={entry.platform}
            role="tab"
            data-guide-tab=""
            aria-selected={entry.platform === active.platform}
            href={buildHref(pathname, params, { guide: entry.platform })}
            className={`whitespace-nowrap px-3 py-[6px] font-mono text-13 ${
              entry.platform === active.platform
                ? "font-medium text-ink shadow-[inset_0_-2px_0_var(--accent)]"
                : "text-dim"
            }`}
          >
            {entry.label}
          </Link>
        ))}
      </div>

      <div
        data-guide-panel=""
        className="mt-[14px] grid grid-cols-2 items-start gap-6 overflow-x-auto"
      >
        <div>
          <div className="font-mono text-135 font-medium text-ink">{active.guide.title}</div>
          <ol className="mt-[6px] list-decimal pl-6 marker:font-mono marker:text-faint">
            {active.guide.steps.map((step) => (
              // A step can name the key itself, which has no spaces to break at.
              <li
                key={step}
                className="mb-[7px] break-words font-mono text-13 leading-[1.6] text-ink"
              >
                {step}
              </li>
            ))}
          </ol>
          {active.guide.note ? (
            <p className="mt-3 font-mono text-13 leading-[1.6] text-faint">{active.guide.note}</p>
          ) : null}
        </div>
        <div className="flex flex-col gap-[10px]">
          {active.guide.codeBlocks.map((block) => (
            <div key={block.label}>
              {/* Same row, same label, as the one-time screen — the two are
                  compared side by side and have to stay identical. */}
              <div className="flex items-center gap-2">
                <div className="font-mono text-115 font-medium uppercase tracking-[.08em] text-dim">
                  {block.label}
                </div>
                <span className="ml-auto">
                  <CopyButton size="row" value={block.code}>
                    Copy
                  </CopyButton>
                </span>
              </div>
              <pre className="mt-[5px] whitespace-pre-wrap rounded-xs border border-rule bg-track px-3 py-[10px] font-mono text-12 leading-[1.65] text-ink">
                {block.code}
              </pre>
            </div>
          ))}
        </div>
      </div>

      <p className="mt-4 rounded-xs border border-ambbd bg-ambbg px-3 py-[10px] font-mono text-13 leading-[1.6] text-ambtx">
        The secret is stored hashed, so snippets show the prefix only — paste your own copy in place
        of {keyPrefix}, or delete this key and issue a new one.
      </p>
    </div>
  );
}
