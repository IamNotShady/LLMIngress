"use client";

import { useState } from "react";

export type ProviderCreateChoice = {
  action: string;
  baseUrlMode: string;
  baseUrlPlaceholder?: string;
  displayName: string;
  fixedBaseUrl?: string;
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
  const [choiceId, setChoiceId] = useState(initialChoice.id);
  const choice = choices.find((item) => item.id === choiceId) ?? initialChoice;
  const isLocal = choice.baseUrlMode === "user_local_private";
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
        {choices.map((item) => (
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
      {isLocal ? (
        <label className="checkbox-label" htmlFor="provider-public-risk">
          <input
            id="provider-public-risk"
            name="publicNetworkRiskAccepted"
            type="checkbox"
            value="true"
          />
          Accept public network risk
        </label>
      ) : null}
      <button type="submit">Create provider</button>
    </form>
  );
}
