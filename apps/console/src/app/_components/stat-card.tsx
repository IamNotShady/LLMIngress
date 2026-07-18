// KPI stat card used across the redesigned dashboard pages (Overview, API Keys,
// Virtual Models, Usage, Limits). Matches the prototype's metric tiles.
// Delta tones carry valence (good/bad/neutral), not direction — callers decide
// per metric whether up or down is the good direction.
export function StatCard({
  icon: _icon,
  label,
  value,
  valueTone,
  delta,
  deltaTone,
}: {
  icon: string;
  label: string;
  value: string;
  valueTone?: "danger" | "warn";
  delta?: string;
  deltaTone?: "good" | "bad" | "neutral";
}) {
  const deltaClass = deltaTone ? ` is-${deltaTone}` : "";
  const valueClass = valueTone ? ` is-${valueTone}` : "";
  return (
    <article className="stat-card">
      <div className="stat-card-head">
        <span className="stat-card-label">{label}</span>
      </div>
      <span className={`stat-card-value${valueClass}`}>{value}</span>
      {delta ? <span className={`stat-card-delta${deltaClass}`}>{delta}</span> : null}
    </article>
  );
}
