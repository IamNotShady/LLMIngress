// Accessible busy indicator for client-side in-flight states (Playground model
// loading and send). Pure-CSS ring; honors prefers-reduced-motion in globals.css.
export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span className="spinner" role="status" aria-label={label}>
      <span className="spinner-ring" aria-hidden="true" />
    </span>
  );
}
