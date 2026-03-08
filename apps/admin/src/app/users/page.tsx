export default function UsersPage() {
  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Usuarios</h1>

      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-neutral-100">
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">Nombre</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">Teléfono</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">Rol</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">Estado</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">Registro</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">Acciones</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={6} className="text-center py-12 text-neutral-400">
                No hay usuarios registrados aún
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
