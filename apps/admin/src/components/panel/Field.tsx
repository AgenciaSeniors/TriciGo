/** A label and its value in the read-only detail pages; goes inside a <dl>. */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">{label}</dt>
      <dd className="text-[13px] text-ink">{children}</dd>
    </div>
  );
}
