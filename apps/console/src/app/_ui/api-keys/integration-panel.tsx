import Link from "next/link";
import { SectionTitle } from "../layout";
import { buildHref, readParam, type SearchParams } from "../params";
import {
  API_KEY_PLACEHOLDER,
  buildIntegrationGuides,
  type IntegrationPlatform,
} from "./integration-guide";

/**
 * The same setup instructions the one-time screen hands over, available again
 * from the key's detail. The secret is the only difference: it was shown once
 * at creation and is stored hashed, so here every snippet carries the
 * placeholder and the operator substitutes their own copy.
 */
export function IntegrationPanel({
  gatewayBaseUrl,
  model,
  params,
  pathname,
}: {
  gatewayBaseUrl: string;
  model: string;
  params: SearchParams;
  pathname: string;
}) {
  const guides = buildIntegrationGuides({
    apiKey: API_KEY_PLACEHOLDER,
    gatewayBaseUrl,
    model,
  });
  const selectedPlatform = (readParam(params, "guide") ??
    guides[0]?.platform) as IntegrationPlatform;
  const active = guides.find((entry) => entry.platform === selectedPlatform) ?? guides[0];

  if (!active) {
    return null;
  }

  return (
    <div>
      <SectionTitle
        className="mt-5"
        note={`${API_KEY_PLACEHOLDER} stands in for the secret, which is shown once at creation`}
      >
        Set up your agent
      </SectionTitle>
      <div
        role="tablist"
        aria-label="Integration platform"
        className="mt-[6px] flex flex-wrap overflow-x-auto border-b border-hair"
      >
        {guides.map((entry) => (
          <Link
            key={entry.platform}
            role="tab"
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

      <div className="mt-[14px] grid grid-cols-2 items-start gap-6 overflow-x-auto">
        <div>
          <div className="font-mono text-115 font-medium tracking-[.08em] text-dim">
            {active.guide.title}
          </div>
          <ol className="mt-[6px] list-decimal pl-6 marker:font-mono marker:text-faint">
            {active.guide.steps.map((step) => (
              <li key={step} className="mb-[7px] font-mono text-13 leading-[1.6] text-ink">
                {step}
              </li>
            ))}
          </ol>
        </div>
        <div className="flex flex-col gap-[10px]">
          {active.guide.codeBlocks.map((block) => (
            <div key={block.label}>
              <div className="font-mono text-115 font-medium tracking-[.08em] text-dim">
                {block.label}
              </div>
              <pre className="mt-[5px] whitespace-pre-wrap rounded-xs border border-rule bg-track px-3 py-[10px] font-mono text-12 leading-[1.65] text-ink">
                {block.code}
              </pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
