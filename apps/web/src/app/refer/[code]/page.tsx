'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';

/**
 * Web landing page for referral deep links.
 * URL: https://tricigo.app/refer/{code}
 *
 * On mobile with app installed: Universal Links opens the app directly.
 * On web/without app: Shows this landing page with download CTA.
 */
export default function ReferralLandingPage() {
  const params = useParams();
  const code = params.code as string;

  const appDeepLink = `tricigo://refer/${code}`;

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center p-6">
      <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-8 text-center">
        {/* Logo */}
        <div className="mb-6">
          <h1 className="text-3xl font-bold">
            Trici<span className="text-orange-500">Go</span>
          </h1>
        </div>

        {/* Gift icon */}
        <div className="w-20 h-20 rounded-full bg-orange-100 flex items-center justify-center mx-auto mb-6">
          <span className="text-4xl">🎁</span>
        </div>

        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          ¡Te han invitado a TriciGo!
        </h2>

        <p className="text-gray-600 mb-2">
          Usa el código de referido y gana un bono en tu primer viaje.
        </p>

        {/* Referral code display */}
        <div className="bg-gray-50 rounded-xl px-6 py-4 mb-6 border-2 border-dashed border-orange-300">
          <p className="text-sm text-gray-500 mb-1">Código de referido</p>
          <p className="text-2xl font-bold tracking-widest text-orange-600">{code}</p>
        </div>

        {/* Open app button */}
        <a
          href={appDeepLink}
          className="block w-full bg-orange-500 hover:bg-orange-600 text-white font-semibold py-4 px-6 rounded-2xl mb-3 transition-colors"
        >
          Abrir en TriciGo
        </a>

        {/* Fallback text */}
        <p className="text-sm text-gray-400 mt-4">
          ¿No tienes la app? Descárgala desde la App Store o Google Play.
        </p>

        {/* Home link */}
        <Link href="/" className="text-sm text-orange-500 hover:underline mt-4 inline-block">
          Visitar tricigo.app
        </Link>
      </div>
    </div>
  );
}
