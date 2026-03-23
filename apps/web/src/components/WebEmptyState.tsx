'use client';

export function WebEmptyState({ icon = '📋', title, description, action }: {
  icon?: string; title: string; description?: string;
  action?: { label: string; href: string };
}) {
  return (
    <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-tertiary)' }}>
      <span style={{ fontSize: '2.5rem', display: 'block', marginBottom: '0.75rem' }}>{icon}</span>
      <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.25rem' }}>{title}</h3>
      {description && <p style={{ fontSize: '0.85rem', marginBottom: '1rem' }}>{description}</p>}
      {action && (
        <a href={action.href} style={{ color: 'var(--primary)', fontWeight: 600, fontSize: '0.9rem', textDecoration: 'none' }}>
          {action.label} →
        </a>
      )}
    </div>
  );
}
