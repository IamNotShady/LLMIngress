"use client";

import { useId, useMemo, useState } from "react";

type VirtualModelOption = {
  id: string;
  label: string;
};

type AgentVirtualModelMultiSelectProps = {
  defaultValue?: readonly string[];
  id: string;
  name: string;
  options: readonly VirtualModelOption[];
};

export function AgentVirtualModelMultiSelect({
  defaultValue = [],
  id,
  name,
  options,
}: AgentVirtualModelMultiSelectProps) {
  const panelId = useId();
  const optionIds = useMemo(() => new Set(options.map((option) => option.id)), [options]);
  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() =>
    Array.from(new Set(defaultValue.filter((value) => optionIds.has(value)))),
  );
  const selectedLabels = options
    .filter((option) => selectedIds.includes(option.id))
    .map((option) => option.label);
  const summary =
    selectedLabels.length === 0 ? "No allowed virtual models" : selectedLabels.join(", ");

  function syncFromNativeSelect(value: HTMLSelectElement) {
    setSelectedIds(Array.from(value.selectedOptions, (option) => option.value));
  }

  function toggleOption(optionId: string) {
    setSelectedIds((current) =>
      current.includes(optionId)
        ? current.filter((currentId) => currentId !== optionId)
        : [...current, optionId],
    );
  }

  return (
    <div className="agent-vm-multi-select">
      <select
        className="agent-vm-multi-select-native"
        id={id}
        multiple
        name={name}
        onChange={(event) => syncFromNativeSelect(event.currentTarget)}
        tabIndex={-1}
        value={selectedIds}
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        className="agent-vm-multi-select-button"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span
          className={
            selectedLabels.length === 0
              ? "agent-vm-multi-select-summary is-empty"
              : "agent-vm-multi-select-summary"
          }
        >
          {summary}
        </span>
        <span aria-hidden="true" className="agent-vm-multi-select-chevron" />
      </button>
      {open ? (
        <fieldset
          aria-label="Allowed virtual models options"
          className="agent-vm-multi-select-panel"
          id={panelId}
        >
          <legend className="sr-only">Allowed virtual models options</legend>
          {options.length === 0 ? (
            <p className="agent-vm-multi-select-empty">No virtual models available.</p>
          ) : (
            options.map((option) => {
              const selected = selectedIds.includes(option.id);
              return (
                <label className="agent-vm-multi-select-option" key={option.id}>
                  <input
                    checked={selected}
                    onChange={() => toggleOption(option.id)}
                    type="checkbox"
                  />
                  <span>{option.label}</span>
                </label>
              );
            })
          )}
        </fieldset>
      ) : null}
    </div>
  );
}
