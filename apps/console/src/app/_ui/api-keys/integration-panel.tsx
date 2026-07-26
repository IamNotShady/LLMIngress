import Link from "next/link";
import { CopyButton } from "../copy-button";
import { buildHref, readParam, type SearchParams } from "../params";
import { buildIntegrationGuides, type IntegrationPlatform } from "./integration-guide";

/** What stands where the secret would be: unmistakably not a value. */
const KEY_PLACEHOLDER = "<YOUR_API_KEY>";

/**
 * The same setup the one-time screen hands over, available again from the key
 * it belongs to. The secret is the only difference: it was shown once and is
 * stored hashed, so these snippets carry a placeholder rather than the prefix.
 * A prefix makes a syntactically complete line holding a truncated secret —
 * copied and run, it fails as a wrong key instead of as a line that was never
 * filled in, and there is a Copy button right beside it. Which key this is
 * belongs in the note under the snippets, not in the snippets.
 */
export function IntegrationPanel({
  gatewayBaseUrl,
  keyPrefix,
  model,
  params,
  pathname,
}: {
  gatewayBaseUrl: string;
  /** Named in the note, so the operator knows which key to paste. */
  keyPrefix: string;
  model: string;
  params: SearchParams;
  pathname: string;
}) {
  const guides = buildIntegrationGuides({ apiKey: KEY_PLACEHOLDER, gatewayBaseUrl, model });
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
              {/* Same label, same button in the same corner, as the one-time
                  screen — the two are compared side by side. The button sits
                  over the block and outside the <pre>, so the snippet it copies
                  is the snippet and nothing else. */}
              <div className="font-mono text-115 font-medium uppercase tracking-[.08em] text-dim">
                {block.label}
              </div>
              <div className="relative mt-[5px]">
                <pre className="whitespace-pre-wrap rounded-xs border border-rule bg-track py-[10px] pl-3 pr-[66px] font-mono text-12 leading-[1.65] text-ink">
                  {block.code}
                </pre>
                <span className="absolute right-2 top-2">
                  <CopyButton size="row" value={block.code}>
                    Copy
                  </CopyButton>
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <p className="mt-4 rounded-xs border border-ambbd bg-ambbg px-3 py-[10px] font-mono text-13 leading-[1.6] text-ambtx">
        The secret was shown once and is stored hashed, so the snippets carry {KEY_PLACEHOLDER} —
        put your own copy of the key starting {keyPrefix} in its place, or delete this key and issue
        a new one.
      </p>
    </div>
  );
}
