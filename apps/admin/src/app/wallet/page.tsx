export default function WalletPage() {
  const summaryCards = [
    { label: 'TriciCoin en circulación', value: '0 TC' },
    { label: 'Canjes pendientes', value: '0' },
    { label: 'Recargas hoy', value: '0 TC' },
    { label: 'Comisiones hoy', value: '0 TC' },
  ];

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Wallet / Finanzas</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {summaryCards.map((card) => (
          <div
            key={card.label}
            className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100"
          >
            <p className="text-sm text-neutral-500 mb-1">{card.label}</p>
            <p className="text-2xl font-bold">{card.value}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-8 text-center">
        <p className="text-neutral-400">Sin movimientos en el ledger</p>
      </div>
    </div>
  );
}
