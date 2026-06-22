"use client";

import { useState } from "react";
import { FlatIcon, type FlatIconName } from "../_components/flat-icon";

export type ProviderCreateChoice = {
  action: string;
  baseUrlMode: string;
  baseUrlPlaceholder?: string;
  displayName: string;
  fixedBaseUrl?: string;
  groupId: string;
  groupLabel: string;
  id: string;
  providerKey: string;
  providerType: string;
};

export function ProviderCreateForm({
  baseUrlError,
  choices,
  displayNameError,
  formError,
  initialBaseUrl,
  initialDisplayName,
  initialProviderKey,
  providerKeyError,
}: {
  baseUrlError?: string;
  choices: ProviderCreateChoice[];
  displayNameError?: string;
  formError?: string;
  initialBaseUrl: string;
  initialDisplayName: string;
  initialProviderKey: string;
  providerKeyError?: string;
}) {
  const fallbackChoice = choices[0];
  if (!fallbackChoice) {
    throw new Error("Provider choices are required.");
  }
  const initialChoice =
    choices.find((choice) => choice.providerKey === initialProviderKey) ?? fallbackChoice;
  const groups = buildChoiceGroups(choices);
  const [choiceId, setChoiceId] = useState(initialChoice.id);
  const [activeGroupId, setActiveGroupId] = useState(initialChoice.groupId);
  const choice = choices.find((item) => item.id === choiceId) ?? initialChoice;
  const visibleChoices = choices.filter((item) => item.groupId === activeGroupId);
  const isLocal = choice.baseUrlMode === "user_local_private";
  const isSubscription = choice.providerType === "subscription";
  const isDirectCreate = choice.baseUrlMode === "fixed_create";
  const baseUrlValue = isLocal ? initialBaseUrl : (choice.fixedBaseUrl ?? "");
  const displayNameValue =
    choice.providerKey === initialProviderKey && initialDisplayName
      ? initialDisplayName
      : choice.displayName;

  return (
    <form className="provider-create-form" action="/api/providers" method="post">
      <input type="hidden" name="action" value={choice.action} />
      <input type="hidden" name="providerKey" value={choice.providerKey} />
      <input type="hidden" name="providerType" value={choice.providerType} />
      <input type="hidden" name="templateId" value={choice.id} />
      {formError ? (
        <p className="form-error" role="alert">
          {formError}
        </p>
      ) : null}
      <div className="provider-create-tabs" role="tablist" aria-label="Provider type group">
        {groups.map((group) => (
          <button
            aria-selected={group.id === activeGroupId}
            className={group.id === activeGroupId ? "is-active" : undefined}
            key={group.id}
            onClick={() => {
              const nextChoice =
                choices.find((item) => item.groupId === group.id) ?? fallbackChoice;
              setActiveGroupId(group.id);
              setChoiceId(nextChoice.id);
            }}
            role="tab"
            type="button"
          >
            <FlatIcon name={readProviderCreateGroupIcon(group.id)} />
            <span>{group.label}</span>
          </button>
        ))}
      </div>
      <label htmlFor="provider-choice">Provider type</label>
      <select
        aria-describedby="provider-key-error"
        aria-invalid={providerKeyError ? true : undefined}
        className={providerKeyError ? "is-invalid" : undefined}
        id="provider-choice"
        name="providerChoice"
        onChange={(event) => setChoiceId(event.target.value)}
        required
        value={choice.id}
      >
        {visibleChoices.map((item) => (
          <option key={item.id} value={item.id}>
            {item.displayName}
          </option>
        ))}
      </select>
      <p
        className={providerKeyError ? "field-error is-visible" : "field-error"}
        id="provider-key-error"
      >
        {providerKeyError}
      </p>
      <label htmlFor="provider-display-name">Provider display name</label>
      <input
        aria-describedby="provider-display-name-error"
        aria-invalid={displayNameError ? true : undefined}
        className={displayNameError ? "is-invalid" : undefined}
        defaultValue={displayNameValue}
        id="provider-display-name"
        key={`display-${choice.id}`}
        name="displayName"
        required
      />
      <p
        className={displayNameError ? "field-error is-visible" : "field-error"}
        id="provider-display-name-error"
      >
        {displayNameError}
      </p>
      {isSubscription ? (
        <input type="hidden" name="baseUrl" value={choice.fixedBaseUrl ?? ""} />
      ) : (
        <>
          <label htmlFor="provider-base-url">Provider base URL</label>
          <input
            aria-describedby="provider-base-url-error"
            aria-invalid={baseUrlError ? true : undefined}
            className={baseUrlError ? "is-invalid" : undefined}
            id="provider-base-url"
            key={`${choice.id}-${baseUrlValue}`}
            name={isDirectCreate || isLocal ? "baseUrl" : undefined}
            placeholder={choice.baseUrlPlaceholder ?? choice.fixedBaseUrl ?? ""}
            required={isDirectCreate || isLocal}
            type="url"
            defaultValue={baseUrlValue}
          />
          <p
            className={baseUrlError ? "field-error is-visible" : "field-error"}
            id="provider-base-url-error"
          >
            {baseUrlError}
          </p>
        </>
      )}
      <button type="submit">
        <FlatIcon name="add" />
        <span>Create provider</span>
      </button>
    </form>
  );
}

function buildChoiceGroups(choices: ProviderCreateChoice[]): Array<{ id: string; label: string }> {
  const groupOrder = new Map([
    ["subscription", 0],
    ["remote_api_key", 1],
    ["local", 2],
  ]);
  const groups = new Map<string, string>();
  for (const choice of choices) {
    if (!groups.has(choice.groupId)) {
      groups.set(choice.groupId, choice.groupLabel);
    }
  }
  return Array.from(groups, ([id, label]) => ({ id, label })).sort(
    (left, right) => (groupOrder.get(left.id) ?? 99) - (groupOrder.get(right.id) ?? 99),
  );
}

function readProviderCreateGroupIcon(groupId: string): FlatIconName {
  if (groupId === "subscription") {
    return "unlock";
  }
  if (groupId === "local") {
    return "settings";
  }
  return "key";
}
