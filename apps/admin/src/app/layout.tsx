import type { Metadata } from 'next';
import { Montserrat } from 'next/font/google';
import { AdminShell } from '@/components/layout/AdminShell';
import './globals.css';

const montserrat = Montserrat({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-montserrat',
});

export const metadata: Metadata = {
  title: 'TriciGo Admin',
  description: 'Panel de administración de TriciGo',
  icons: {
    icon: '/favicon.png',
    apple: '/icon-192.png',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" className={montserrat.variable}>
      <body className="bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 font-sans">
        <AdminShell>{children}</AdminShell>
      </body>
    </html>
  );
}
