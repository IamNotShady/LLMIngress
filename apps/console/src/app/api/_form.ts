import { consoleValidationError } from "@llmingress/db/console-operation-error";

export function readText(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readRequiredText(form: FormData, name: string, ...fallbackNames: string[]): string {
  for (const candidate of [name, ...fallbackNames]) {
    const value = readText(form, candidate);
    if (value) {
      return value;
    }
  }
  throw consoleValidationError(`${name} is required.`, "form_field_required", { field: name });
}

export function readNullableText(form: FormData, name: string): string | null | undefined {
  const value = form.get(name);
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim() || null;
}

/**
 * Absent means absent; present-but-not-a-number is a refusal. Returning
 * undefined for both let callers fall back to their default, so typing "high"
 * into PRIORITY saved 100 and said nothing — the field the operator typed in
 * disagreeing with the row they get back.
 */
export function readNumber(form: FormData, name: string): number | undefined {
  const value = readText(form, name);
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw consoleValidationError(`${name} must be a number.`, `${toSnakeCase(name)}_not_a_number`, {
      field: name,
    });
  }
  return parsed;
}

function toSnakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export function readTextValues(form: FormData, name: string): string[] {
  return form
    .getAll(name)
    .flatMap((value) => (typeof value === "string" && value.trim() ? [value.trim()] : []));
}
