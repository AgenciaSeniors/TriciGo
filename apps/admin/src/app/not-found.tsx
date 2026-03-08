import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen">
      <h1 className="text-6xl font-extrabold text-neutral-900">404</h1>
      <p className="mt-4 text-lg text-neutral-600">Pagina no encontrada</p>
      <Link
        href="/"
        className="mt-8 px-6 py-3 bg-neutral-900 text-white rounded-lg hover:bg-neutral-800 transition-colors"
      >
        Volver al inicio
      </Link>
    </div>
  );
}
