import { LoadingRows, PageShell, PageTitleRow } from "../../_ui/layout";

/**
 * What the module looks like while the server is still reading. The rows are
 * the shape the table will have, so the page does not jump when they arrive,
 * and the note says what is being waited on rather than spinning silently.
 */
export default function Loading() {
  return (
    <PageShell label="Virtual Models">
      <PageTitleRow title="Virtual Models" />
      <LoadingRows note="Reading virtual models and their routes…" />
    </PageShell>
  );
}
