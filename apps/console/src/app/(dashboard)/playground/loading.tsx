import { LoadingRows, PageShell, PageTitleRow } from "../../_ui/layout";

/**
 * What the module looks like while the server is still reading. The Playground
 * needs the virtual models a request can name before its form means anything,
 * so it waits like the rest rather than rendering an empty picker.
 */
export default function Loading() {
  return (
    <PageShell label="Playground">
      <PageTitleRow title="Playground" />
      <LoadingRows note="Reading the virtual models this console can call…" />
    </PageShell>
  );
}
