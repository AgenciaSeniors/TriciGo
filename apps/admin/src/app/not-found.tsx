import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen">
      <h1 className="text-6xl font-extrabold text-ink">404</h1>
      <p className="mt-4 text-lg text-ink-muted">Pagina no encontrada</p>
      <Link
        href="/"
        className="mt-8 px-6 py-3 bg-ink text-surface rounded-lg hover:bg-ink/90 transition-colors"
      >
        Volver al inicio
      </Link>
    </div>
  );
}
