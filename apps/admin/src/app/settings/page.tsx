import Link from 'next/link';

const sections = [
  {
    href: '/settings/service-types',
    title: 'Tipos de servicio',
    description: 'Administrar los tipos de vehículo disponibles y sus configuraciones.',
    icon: '🛺',
  },
  {
    href: '/settings/pricing',
    title: 'Reglas de precio',
    description: 'Configurar tarifas base, por km, por minuto y multiplicadores de surge.',
    icon: '💰',
  },
  {
    href: '/settings/zones',
    title: 'Zonas operativas',
    description: 'Definir y editar las zonas de operación en La Habana.',
    icon: '🗺️',
  },
  {
    href: '/settings/promotions',
    title: 'Promociones',
    description: 'Crear y gestionar códigos promocionales y bonos.',
    icon: '🎁',
  },
  {
    href: '/settings/feature-flags',
    title: 'Feature Flags',
    description: 'Activar o desactivar funcionalidades por entorno.',
    icon: '🚩',
  },
];

export default function SettingsPage() {
  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Configuración</h1>

      <div className="space-y-4">
        {sections.map((section) => (
          <Link
            key={section.href}
            href={section.href}
            className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100 flex items-center justify-between hover:border-[#FF4D00]/30 transition-colors block"
          >
            <div className="flex items-center gap-4">
              <span className="text-2xl">{section.icon}</span>
              <div>
                <h3 className="font-bold text-lg">{section.title}</h3>
                <p className="text-sm text-neutral-500 mt-1">{section.description}</p>
              </div>
            </div>
            <svg className="w-5 h-5 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        ))}
      </div>
    </div>
  );
}
