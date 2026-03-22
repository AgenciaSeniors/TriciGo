'use client';
import React from 'react';
import Link from 'next/link';

interface BreadcrumbItem { label: string; href?: string; }

export function AdminBreadcrumb({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400 mb-4" aria-label="Breadcrumb">
      {items.map((item, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span>/</span>}
          {item.href ? (
            <Link href={item.href} className="hover:text-primary-500 transition-colors">{item.label}</Link>
          ) : (
            <span className="text-neutral-900 dark:text-neutral-100 font-medium">{item.label}</span>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}
