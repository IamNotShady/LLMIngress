/**
 * The only spinning thing in the console. It exists for waits the server cannot
 * render — a request to the gateway in the browser — and it says what is being
 * waited on, because a bare spinner tells an operator nothing. Motion is
 * dropped for anyone who asked for less of it; the label carries the state.
 */
export function Spinner({ className = "", label }: { className?: string; label: string }) {
  return (
    <output
      aria-label={label}
      className={`flex items-center gap-2 font-mono text-125 text-faint ${className}`}
    >
      <span
        aria-hidden="true"
        className="size-[9px] flex-none animate-spin rounded-full border border-hair border-t-accent motion-reduce:animate-none"
      />
      {label}
    </output>
  );
}
