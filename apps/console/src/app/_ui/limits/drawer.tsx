import type { ConsoleBudgetPeriod } from "@llmingress/db/console-api-key-limits";
import type { ConsoleApiKey } from "@llmingress/db/console-api-keys";
import { type ApiKeyLimitsView, ENFORCEMENT_NOTE } from "../api-keys/limits-view";
import { ConfirmForm } from "../confirm-form";
import { ActionButton, ActionLink, Field, Meter, SelectInput, TextInput } from "../controls";
import { formatCost, formatDateOnly, formatUntil } from "../format";
import { Dialog, DialogBody, DialogNote, Drawer } from "../overlay";
import { buildHref, readParam, type SearchParams } from "../params";

const BUDGET_PERIODS = ["day", "week", "month"] as const;

export function LimitsDrawer({
  apiKey,
  budgetPeriod,
  params,
  view,
}: {
  apiKey: ConsoleApiKey;
  budgetPeriod: ConsoleBudgetPeriod | undefined;
  params: SearchParams;
  view: ApiKeyLimitsView;
}) {
  const closeHref = buildHref("/limits", params, { dialog: null, selected: null });
  const headerNote =
    view.state === "none"
      ? "no rules · unlimited"
      : view.state === "disabled"
        ? "limits disabled · rules kept"
        : `limits enabled · ${view.enforcement}`;

  if (readParam(params, "dialog") === "deleteRules") {
    return (
      <DeleteRulesDialog
        apiKey={apiKey}
        closeHref={buildHref("/limits", params, { dialog: null })}
        params={params}
      />
    );
  }

  return (
    <Drawer
      closeHref={closeHref}
      subtitle={`${apiKey.keyPrefix} · ${headerNote}`}
      title={apiKey.name}
    >
      {view.state === "none" ? (
        <p className="mt-4 border-t border-hair pt-3 font-mono text-13 leading-[1.6] text-dim">
          No rules are set for this key — it runs unlimited. Fill the fields below and save to start
          enforcing.
        </p>
      ) : (
        <div className="mt-4 border-t border-hair pt-3">
          <div className="flex justify-between font-mono text-13 text-ink">
            <span>budget · {view.budgetPeriod ?? "no period"}</span>
            <span>
              <span
                className={`font-medium ${(view.spentRatio ?? 0) >= 0.8 ? "text-ambtx" : "text-ink"}`}
              >
                {formatCost(view.spentUsd)}
              </span>{" "}
              / {view.budgetLimit === null ? "unlimited" : formatCost(view.budgetLimit)}
            </span>
          </div>
          <Meter
            className="mt-[5px]"
            fillClassName={(view.spentRatio ?? 0) >= 0.8 ? "bg-amber" : "bg-green"}
            ratio={view.spentRatio ?? 0}
          />
          <p className="mt-1 font-mono text-12 text-faint">
            {budgetPeriod
              ? `period ${formatDateOnly(budgetPeriod.periodStart)} → ${formatDateOnly(
                  budgetPeriod.periodEnd,
                )} · resets ${formatUntil(budgetPeriod.periodEnd)}`
              : "no spend recorded in this period yet"}
          </p>
        </div>
      )}

      <form action="/api/api-key-limits" method="post">
        <input type="hidden" name="action" value="saveLimitRules" />
        <input type="hidden" name="apiKeyId" value={apiKey.id} />

        <div className="mt-[18px] border-b border-hair pb-[5px] font-mono text-115 font-medium tracking-[.08em] text-dim">
          RULES
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="BUDGET USD" hint="spend cap for the period · blocks past it">
            <TextInput
              name="budgetUsd"
              defaultValue={view.budgetLimit === null ? "" : String(view.budgetLimit)}
              inputMode="decimal"
              placeholder="unlimited"
              required
            />
          </Field>
          <Field label="PERIOD" hint="window the budget resets on">
            <SelectInput name="budgetPeriod" defaultValue={view.budgetPeriod ?? "month"}>
              {BUDGET_PERIODS.map((period) => (
                <option key={period} value={period}>
                  {period}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label="RPM" hint="requests per minute">
            <TextInput
              name="rpm"
              defaultValue={view.rpm === null ? "" : String(view.rpm)}
              inputMode="numeric"
              placeholder="unlimited"
              required
            />
          </Field>
          <Field label="TPM" hint="tokens per minute (input + output)">
            <TextInput
              name="tpm"
              defaultValue={view.tpm === null ? "" : String(view.tpm)}
              inputMode="numeric"
              placeholder="unlimited"
              required
            />
          </Field>
          <Field label="TOKENS / REQUEST" hint="max tokens a single request may use">
            <TextInput
              name="tokenLimit"
              defaultValue={view.tokensPerRequest === null ? "" : String(view.tokensPerRequest)}
              inputMode="numeric"
              placeholder="unlimited"
              required
            />
          </Field>
          <Field label="CONCURRENCY" hint="in-flight requests at the same time">
            <TextInput
              name="concurrency"
              defaultValue={view.concurrency === null ? "" : String(view.concurrency)}
              inputMode="numeric"
              placeholder="unlimited"
            />
          </Field>
          <Field label="ENFORCEMENT" hint={ENFORCEMENT_NOTE}>
            <SelectInput name="enforcementPolicy" defaultValue={view.enforcement}>
              <option value="block">block</option>
              <option value="warn_only">warn_only</option>
            </SelectInput>
          </Field>
        </div>
        <p className="mt-[10px] font-mono text-12 leading-[1.6] text-faint">
          warn_only records the breach and lets the request through. Budget checks use actual cost
          when known, estimated otherwise.
        </p>
        <div className="mt-[18px] flex flex-wrap items-center gap-2">
          <ActionButton className="px-[18px] py-[6px] text-135" tone="primary">
            Save rules
          </ActionButton>
        </div>
      </form>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {view.state === "none" ? null : (
          <form action="/api/api-key-limits" method="post">
            <input type="hidden" name="action" value="setLimitsEnabled" />
            <input type="hidden" name="apiKeyId" value={apiKey.id} />
            <input
              type="hidden"
              name="enabled"
              value={view.state === "enabled" ? "false" : "true"}
            />
            <ActionButton className="px-3 py-[6px] text-135">
              {view.state === "enabled" ? "Disable limits" : "Enable limits"}
            </ActionButton>
          </form>
        )}
        {view.state === "none" ? null : (
          <ActionLink
            className="px-3 py-[6px] text-135"
            href={buildHref("/limits", params, { dialog: "deleteRules" })}
            tone="danger"
          >
            Delete rules
          </ActionLink>
        )}
      </div>
      <p className="mt-3 font-mono text-12 leading-[1.6] text-faint">
        Disabling keeps every rule and stops enforcing them; deleting removes the rules and the key
        runs unlimited until new ones are set.
      </p>
    </Drawer>
  );
}

function DeleteRulesDialog({
  apiKey,
  closeHref,
  params,
}: {
  apiKey: ConsoleApiKey;
  closeHref: string;
  params: SearchParams;
}) {
  return (
    <Dialog
      closeHref={closeHref}
      danger
      tag="cannot be undone"
      title="Delete limit rules"
      width={460}
    >
      <DialogBody>
        All rules for <strong className="font-medium">{apiKey.name}</strong> are removed and the key
        runs unlimited until new rules are set. Recorded budget usage is kept.
      </DialogBody>
      <DialogNote>
        To pause enforcement without losing the rules, use Disable limits instead.
      </DialogNote>
      <ConfirmForm
        action="/api/api-key-limits"
        confirmLabel="Delete rules"
        onSuccessHref={buildHref("/limits", params, { dialog: null })}
        hiddenFields={{ action: "deleteLimitRules", apiKeyId: apiKey.id }}
      >
        <ActionLink href={buildHref("/limits", params, { dialog: null })}>Cancel</ActionLink>
      </ConfirmForm>
    </Dialog>
  );
}
