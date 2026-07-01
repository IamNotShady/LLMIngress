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
  throw new Error(`${name} is required.`);
}

export function readNullableText(form: FormData, name: string): string | null | undefined {
  const value = form.get(name);
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim() || null;
}

export function readNumber(form: FormData, name: string): number | undefined {
  const value = readText(form, name);
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readTextValues(form: FormData, name: string): string[] {
  return form
    .getAll(name)
    .flatMap((value) => (typeof value === "string" && value.trim() ? [value.trim()] : []));
}
