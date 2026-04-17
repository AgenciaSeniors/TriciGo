import type { Metadata } from 'next';
import { AdminShell } from '@/components/layout/AdminShell';
import './globals.css';

export const metadata: Metadata = {
  title: 'TriciGo Admin',
  description: 'Panel de administración de TriciGo',
  icons: {
    icon: '/favicon.png',
    apple: '/icon-192.png',
  },
};

const themeInitScript = `
(function () {
  try {
    var saved = localStorage.getItem('admin-theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = saved === 'light' || saved === 'dark' ? saved : (prefersDark ? 'dark' : 'light');
    if (theme === 'dark') document.documentElement.classList.add('dark');
    document.documentElement.style.colorScheme = theme;
  } catch (_) {}
})();
`.trim();

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="bg-surface-sunken text-ink antialiased">
        <AdminShell>{children}</AdminShell>
      </body>
    </html>
  );
}
