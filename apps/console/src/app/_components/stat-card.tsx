// KPI stat card used across the redesigned dashboard pages (Overview, Agents,
// Virtual Models, Usage, Limits). Matches the prototype's metric tiles.
export function StatCard({
  icon: _icon,
  label,
  value,
  delta,
  deltaTone,
}: {
  icon: string;
  label: string;
  value: string;
  delta?: string;
  deltaTone?: "up" | "down";
}) {
  const deltaClass = deltaTone ? ` is-${deltaTone}` : "";
  return (
    <article className="stat-card">
      <div className="stat-card-head">
        <span className="stat-card-label">{label}</span>
      </div>
      <span className="stat-card-value">{value}</span>
      {delta ? <span className={`stat-card-delta${deltaClass}`}>{delta}</span> : null}
    </article>
  );
}
