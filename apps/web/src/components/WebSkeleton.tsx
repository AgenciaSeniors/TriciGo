'use client';

export function WebSkeleton({ width = '100%', height = '1rem', rounded = '0.5rem' }: {
  width?: string; height?: string; rounded?: string;
}) {
  return (
    <div style={{
      width, height, borderRadius: rounded,
      background: 'var(--border-light)',
      animation: 'pulse 1.5s ease-in-out infinite',
    }} />
  );
}

export function WebSkeletonCard() {
  return (
    <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid var(--border)', marginBottom: '0.75rem' }}>
      <WebSkeleton width="60%" height="1rem" />
      <div style={{ marginTop: '0.5rem' }}><WebSkeleton width="90%" height="0.75rem" /></div>
      <div style={{ marginTop: '0.5rem' }}><WebSkeleton width="40%" height="0.75rem" /></div>
    </div>
  );
}

export function WebSkeletonList({ count = 3 }: { count?: number }) {
  return <>{Array.from({ length: count }).map((_, i) => <WebSkeletonCard key={i} />)}</>;
}
