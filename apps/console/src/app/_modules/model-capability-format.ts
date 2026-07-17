/**
 * Renders a model's context window as an exact, grouped token count (e.g.
 * `1,048,576`). Unlike the abbreviated `1.0M`/`1M` display, this keeps
 * near-identical context windows visually distinct — two candidates whose
 * context windows differ (and therefore fail the route-policy capability
 * contract) must not render as the same value.
 */
export function formatModelContextTokens(contextWindow: number | null): string {
  return contextWindow === null ? "Unknown" : contextWindow.toLocaleString("en-US");
}
