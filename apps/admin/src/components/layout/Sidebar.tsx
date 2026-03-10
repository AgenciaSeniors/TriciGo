'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const navItems = [
  { href: '/', label: 'Dashboard', icon: '📊' },
  { href: '/drivers', label: 'Conductores', icon: '🛺' },
  { href: '/rides', label: 'Viajes', icon: '🗺️' },
  { href: '/users', label: 'Usuarios', icon: '👥' },
  { href: '/wallet', label: 'Wallet', icon: '💰' },
  { href: '/incidents', label: 'Incidentes', icon: '🚨' },
  { href: '/settings', label: 'Configuración', icon: '⚙️' },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 bg-neutral-950 text-white flex flex-col">
      {/* Logo */}
      <div className="px-6 py-6 border-b border-neutral-800">
        <h1 className="text-2xl font-extrabold">
          <span className="text-white">Trici</span>
          <span className="text-primary-500">Go</span>
        </h1>
        <p className="text-xs text-neutral-500 mt-1">Panel de administración</p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => {
          const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`
                flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors
                ${isActive
                  ? 'bg-primary-500/10 text-primary-500'
                  : 'text-neutral-400 hover:text-white hover:bg-neutral-800'
                }
              `}
            >
              <span className="text-lg">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-neutral-800">
        <p className="text-xs text-neutral-600">TriciGo Admin v0.0.1</p>
      </div>
    </aside>
  );
}
