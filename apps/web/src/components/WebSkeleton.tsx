'use client';

export function WebSkeleton({ width = '100%', height = '1rem', rounded = '0.5rem' }: {
  width?: string; height?: string; rounded?: string;
}) {
  return (
    <div style={{
      width, height, borderRadius: rounded,
      background: 'linear-gradient(90deg, var(--border-light) 25%, var(--bg-hover) 50%, var(--border-light) 75%)',
      backgroundSize: '200% 100%',
      animation: 'shimmer 1.5s ease-in-out infinite',
    }} />
  );
}

export function WebSkeletonCard() {
  return (
    <div style={{
      padding: '1rem',
      borderRadius: 'var(--radius-md)',
      border: '1px solid var(--border-light)',
      marginBottom: '0.75rem',
      background: 'var(--bg-card)',
    }}>
      <WebSkeleton width="60%" height="1rem" />
      <div style={{ marginTop: '0.5rem' }}><WebSkeleton width="90%" height="0.75rem" /></div>
      <div style={{ marginTop: '0.5rem' }}><WebSkeleton width="40%" height="0.75rem" /></div>
    </div>
  );
}

export function WebSkeletonList({ count = 3 }: { count?: number }) {
  return <>{Array.from({ length: count }).map((_, i) => <WebSkeletonCard key={i} />)}</>;
}
