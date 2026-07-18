"use client";

import { useState } from "react";

type VirtualModelOption = {
  id: string;
  name: string;
};

export function ApiKeyVirtualModelFields({
  idPrefix,
  initialDefaultVirtualModelId = "",
  initialSelectedVirtualModelIds,
  virtualModels,
}: {
  idPrefix: string;
  initialDefaultVirtualModelId?: string;
  initialSelectedVirtualModelIds: readonly string[];
  virtualModels: readonly VirtualModelOption[];
}) {
  const [selectedVirtualModelIds, setSelectedVirtualModelIds] = useState(
    () => new Set(initialSelectedVirtualModelIds),
  );
  const [defaultVirtualModelId, setDefaultVirtualModelId] = useState(initialDefaultVirtualModelId);
  const labelId = `${idPrefix}-allowed-virtual-models-label`;

  const toggleVirtualModel = (virtualModelId: string, checked: boolean) => {
    if (!checked && defaultVirtualModelId === virtualModelId) {
      setDefaultVirtualModelId("");
    }
    setSelectedVirtualModelIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(virtualModelId);
      } else {
        next.delete(virtualModelId);
      }
      return next;
    });
  };

  return (
    <>
      <span className="form-label" id={labelId}>
        Allowed virtual models
      </span>
      {virtualModels.length === 0 ? (
        <p className="form-hint">No virtual models configured.</p>
      ) : (
        <fieldset aria-labelledby={labelId} className="api-key-vm-checkbox-list">
          {virtualModels.map((virtualModel) => {
            const inputId = `${labelId}-${virtualModel.id}`;
            return (
              <label className="checkbox-label" htmlFor={inputId} key={virtualModel.id}>
                <input
                  checked={selectedVirtualModelIds.has(virtualModel.id)}
                  id={inputId}
                  name="allowedVirtualModelIds"
                  onChange={(event) => toggleVirtualModel(virtualModel.id, event.target.checked)}
                  type="checkbox"
                  value={virtualModel.id}
                />
                <span>{virtualModel.name}</span>
              </label>
            );
          })}
        </fieldset>
      )}
      <label htmlFor={`${idPrefix}-default-virtual-model`}>Default virtual model</label>
      <select
        id={`${idPrefix}-default-virtual-model`}
        name="defaultVirtualModelId"
        onChange={(event) => setDefaultVirtualModelId(event.target.value)}
        value={defaultVirtualModelId}
      >
        <option value="">No default virtual model</option>
        {virtualModels
          .filter((virtualModel) => selectedVirtualModelIds.has(virtualModel.id))
          .map((virtualModel) => (
            <option key={virtualModel.id} value={virtualModel.id}>
              {virtualModel.name}
            </option>
          ))}
      </select>
    </>
  );
}
