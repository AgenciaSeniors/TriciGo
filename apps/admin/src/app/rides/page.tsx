export default function RidesPage() {
  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Viajes</h1>

      <div className="flex gap-2 mb-6">
        {['Activos', 'Completados', 'Cancelados', 'En disputa'].map((tab) => (
          <button
            key={tab}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-white border border-neutral-200 hover:border-primary-500 hover:text-primary-500 transition-colors"
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-8 text-center">
        <p className="text-neutral-400">No hay viajes registrados aún</p>
      </div>
    </div>
  );
}
