import type { ReactNode } from "react";
import { MutationForm } from "../mutation-form";

/**
 * Saving an existing key posts in place like every other editor, so a refusal —
 * a name already taken, a limit that does not parse — is shown where the
 * operator was working.
 *
 * Creating one cannot: the response *is* the one-time secret screen, and the
 * plaintext exists only in that response. Asking for it as JSON would put the
 * secret through client code and leave the console to re-render it; a plain
 * post lands the browser on the page the server rendered. The refusal path is
 * covered instead by the route, which sends the operator back to this dialog
 * with the message and what they had typed.
 */
export function ApiKeyEditorForm({
  children,
  closeHref,
  editing,
  formError,
}: {
  children: ReactNode;
  /** Where a save lands: the list as the operator left it, dialog closed. */
  closeHref: string;
  editing: boolean;
  /** A refused creation comes back through the URL rather than the response. */
  formError?: string;
}) {
  if (!editing) {
    return (
      <form action="/api/api-keys" method="post">
        {formError ? (
          <p
            role="alert"
            className="mb-3 mt-3 rounded-xs border border-ambbd bg-ambbg px-[10px] py-2 font-mono text-13 text-redtx"
          >
            {formError}
          </p>
        ) : null}
        {children}
      </form>
    );
  }
  return (
    <MutationForm
      action="/api/api-keys"
      fallbackError="The key could not be saved."
      invalidFieldOnError="name"
      onSuccessHref={closeHref}
    >
      {children}
    </MutationForm>
  );
}
