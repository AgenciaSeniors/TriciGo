export default function DriversPage() {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Conductores</h1>
        <div className="flex gap-2">
          {['Todos', 'Pendientes', 'Aprobados', 'Suspendidos'].map((tab) => (
            <button
              key={tab}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-white border border-neutral-200 hover:border-primary-500 hover:text-primary-500 transition-colors"
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-neutral-100">
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">Nombre</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">Teléfono</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">Vehículo</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">Estado</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">Rating</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">Acciones</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={6} className="text-center py-12 text-neutral-400">
                No hay conductores registrados aún
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
