"use client";

import { TextInput } from "../controls";

/** Every keystroke must leave the field a prefix of a valid two-decimal
    weight: "", "0", "1", "0.", "0.1", "0.12", "1.", "1.0", "1.00". Anything
    else - a third decimal digit, a letter, a second dot, an integer part
    other than 0 or 1 - is swallowed by restoring the last valid draft, so
    only the cross-candidate sum rule is left for the server to refuse. */
const partialWeightPattern = /^$|^[01]$|^0\.\d{0,2}$|^1\.0{0,2}$/;

export function WeightInput(props: { "aria-label": string; defaultValue: string; name: string }) {
  return (
    <TextInput
      aria-label={props["aria-label"]}
      defaultValue={props.defaultValue}
      inputMode="decimal"
      name={props.name}
      onInput={(event) => {
        const input = event.currentTarget;
        if (partialWeightPattern.test(input.value)) {
          input.dataset.lastValidDraft = input.value;
          return;
        }
        // Before any valid keystroke the dataset is empty, so an edit that
        // starts invalid falls back to the stored value the field opened with.
        input.value = input.dataset.lastValidDraft ?? props.defaultValue;
      }}
      placeholder="0.25"
    />
  );
}
