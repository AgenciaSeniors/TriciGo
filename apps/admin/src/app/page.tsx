export default function DashboardPage() {
  const stats = [
    { label: 'Viajes activos', value: '0', color: 'text-primary-500' },
    { label: 'Viajes hoy', value: '0', color: 'text-neutral-900' },
    { label: 'Conductores en línea', value: '0', color: 'text-success' },
    { label: 'Ingresos hoy', value: '0 TC', color: 'text-primary-500' },
    { label: 'Verificaciones pendientes', value: '0', color: 'text-warning' },
    { label: 'Incidentes abiertos', value: '0', color: 'text-error' },
  ];

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100"
          >
            <p className="text-sm text-neutral-500 mb-1">{stat.label}</p>
            <p className={`text-3xl font-bold ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100">
          <h2 className="text-lg font-bold mb-4">Viajes recientes</h2>
          <p className="text-neutral-400">Sin viajes recientes</p>
        </div>
        <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100">
          <h2 className="text-lg font-bold mb-4">Conductores pendientes</h2>
          <p className="text-neutral-400">Sin verificaciones pendientes</p>
        </div>
      </div>
    </div>
  );
}
