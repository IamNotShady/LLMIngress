import type { ConsoleBudgetPeriod } from "@llmingress/db/console-api-key-limits";
import type { ConsoleApiKey } from "@llmingress/db/console-api-keys";
import { type ApiKeyLimitsView, ENFORCEMENT_NOTE } from "../api-keys/limits-view";
import { ConfirmForm } from "../confirm-form";
import { ActionButton, ActionLink, Field, Meter, SelectInput, TextInput } from "../controls";
import { formatCost, formatDateOnly, formatUntil } from "../format";
import { MutationForm } from "../mutation-form";
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

  if (readParam(params, "dialog") === "toggleLimits") {
    return (
      <ToggleLimitsDialog
        apiKey={apiKey}
        closeHref={buildHref("/limits", params, { dialog: null })}
        enable={view.state !== "enabled"}
        params={params}
        view={view}
      />
    );
  }

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

      <MutationForm
        action="/api/api-key-limits"
        fallbackError="The rules could not be saved."
        invalidFieldOnError="budgetUsd"
        onSuccessHref={buildHref("/limits", params, { dialog: null })}
      >
        <input type="hidden" name="action" value="saveLimitRules" />
        <input type="hidden" name="apiKeyId" value={apiKey.id} />

        <div className="mt-[18px] flex items-baseline gap-[10px] border-b border-hair pb-[5px]">
          <span className="font-mono text-115 font-medium tracking-[.08em] text-dim">RULES</span>
          <span className="ml-auto font-mono text-12 text-faint">
            Leave a field empty for unlimited
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="BUDGET USD" hint="spend cap for the period · blocks past it">
            <TextInput
              name="budgetUsd"
              defaultValue={view.budgetLimit === null ? "" : String(view.budgetLimit)}
              inputMode="decimal"
              placeholder="unlimited"
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
            />
          </Field>
          <Field label="TPM" hint="tokens per minute (input + output)">
            <TextInput
              name="tpm"
              defaultValue={view.tpm === null ? "" : String(view.tpm)}
              inputMode="numeric"
              placeholder="unlimited"
            />
          </Field>
          <Field label="TOKENS / REQUEST" hint="max tokens a single request may use">
            <TextInput
              name="tokenLimit"
              defaultValue={view.tokensPerRequest === null ? "" : String(view.tokensPerRequest)}
              inputMode="numeric"
              placeholder="unlimited"
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
          <ActionButton size="dialog" tone="primary">
            Save rules
          </ActionButton>
        </div>
      </MutationForm>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {view.state === "none" ? null : (
          <ActionLink size="dialog" href={buildHref("/limits", params, { dialog: "toggleLimits" })}>
            {view.state === "enabled" ? "Disable limits" : "Enable limits"}
          </ActionLink>
        )}
        {view.state === "none" ? null : (
          <ActionLink
            size="dialog"
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

/**
 * Enforcement is what stands between a key and an unbounded bill, so switching
 * it says which way traffic changes and that the rules themselves are kept.
 */
function ToggleLimitsDialog({
  apiKey,
  closeHref,
  enable,
  params,
  view,
}: {
  apiKey: ConsoleApiKey;
  closeHref: string;
  enable: boolean;
  params: SearchParams;
  view: ApiKeyLimitsView;
}) {
  return (
    <Dialog
      closeHref={closeHref}
      danger={!enable}
      title={enable ? "Enable limits" : "Disable limits"}
      width={460}
    >
      <DialogBody>
        {enable ? (
          <>
            Requests presenting <strong className="font-medium">{apiKey.name}</strong> start being
            checked against its rules again,{" "}
            {view.enforcement === "warn_only" ? "recording" : "and"}{" "}
            {view.enforcement === "warn_only"
              ? "a breach without stopping the request"
              : "a request past a ceiling is rejected"}
            .
          </>
        ) : (
          <>
            Nothing stops requests presenting <strong className="font-medium">{apiKey.name}</strong>{" "}
            — no budget, rate or concurrency ceiling is checked until limits are switched back on.
            The rules are kept exactly as they are, and recorded spend keeps accumulating.
          </>
        )}
      </DialogBody>
      <DialogNote>
        {enable
          ? "The rules were never deleted; this only starts enforcing them again."
          : "To stop this key entirely instead, disable the key itself in API Keys."}
      </DialogNote>
      <ConfirmForm
        action="/api/api-key-limits"
        confirmLabel={enable ? "Enable limits" : "Disable limits"}
        onSuccessHref={buildHref("/limits", params, { dialog: null })}
        hiddenFields={{
          action: "setLimitsEnabled",
          apiKeyId: apiKey.id,
          enabled: enable ? "true" : "false",
        }}
        tone={enable ? "primary" : "danger"}
      >
        <ActionLink href={buildHref("/limits", params, { dialog: null })}>Cancel</ActionLink>
      </ConfirmForm>
    </Dialog>
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
