import type { ReactNode } from "react";

// Shared empty-state block: shown when a table or panel has no rows yet.
// Consolidates the ad-hoc `<p>No …</p>` and colspan "no data" cells scattered
// across the dashboard sections. `action` renders an optional CTA — put the
// existing `.empty-state-action` link class on the element passed in.
export function EmptyState({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state" role="note">
      <p className="empty-state-title">{title}</p>
      {description ? <p className="empty-state-description">{description}</p> : null}
      {action ? <div className="empty-state-cta">{action}</div> : null}
    </div>
  );
}
