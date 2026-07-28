/**
 * Copy that works where the console is actually run. `navigator.clipboard` is a
 * secure-context API: on a self-hosted box reached over plain http by IP or
 * hostname it is simply absent, and an optional-chained call there does nothing
 * at all — no error, no copy, a button that says it worked. The selection path
 * is the fallback every browser still honours from a click handler.
 *
 * Returns whether the value reached the clipboard, so the button can say so.
 */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      // Raced, because this promise does not always settle: a page the window
      // manager does not consider focused leaves the write pending forever in
      // Chromium, and an await on it would leave the button sitting on its own
      // label — the exact "did that work?" this function exists to answer.
      const wrote = await Promise.race([
        navigator.clipboard.writeText(value).then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), CLIPBOARD_TIMEOUT_MS)),
      ]);
      if (wrote) {
        return true;
      }
    }
  } catch {
    // Denied permission, or a document that is not focused: try the other way.
  }
  return copyBySelection(value);
}

/** Long enough for a clipboard that answers, short enough not to be a wait. */
const CLIPBOARD_TIMEOUT_MS = 1000;

function copyBySelection(value: string): boolean {
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    // Off-screen but selectable, and fixed so selecting it cannot scroll the
    // page under the operator.
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}
