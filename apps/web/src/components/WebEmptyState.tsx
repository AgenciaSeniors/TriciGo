'use client';

export function WebEmptyState({ icon = '📋', title, description, action }: {
  icon?: string; title: string; description?: string;
  // `href` → link; `onClick` → button (for in-page actions like resetting a
  // filter or scrolling to a section). Provide one or the other.
  action?: { label: string; href?: string; onClick?: () => void };
}) {
  return (
    <div style={{
      textAlign: 'center',
      padding: '3rem 1rem',
      color: 'var(--text-tertiary)',
      animation: 'fadeInUp 0.4s ease',
    }}>
      <span style={{ fontSize: '2.5rem', display: 'block', marginBottom: '0.75rem' }}>{icon}</span>
      <h3 style={{ fontSize: 'var(--text-xl)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.25rem' }}>{title}</h3>
      {description && <p style={{ fontSize: 'var(--text-base)', marginBottom: '1rem', lineHeight: 1.5 }}>{description}</p>}
      {action && (action.onClick ? (
        <button
          type="button"
          onClick={action.onClick}
          className="btn-base btn-primary-solid"
          style={{ display: 'inline-flex', marginTop: '0.5rem', cursor: 'pointer', border: 'none' }}
        >
          {action.label}
        </button>
      ) : (
        <a
          href={action.href}
          className="btn-base btn-primary-solid"
          style={{ display: 'inline-flex', marginTop: '0.5rem' }}
        >
          {action.label}
        </a>
      ))}
    </div>
  );
}
