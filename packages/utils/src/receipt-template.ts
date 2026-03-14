export interface ReceiptData {
  rideId: string;
  date: string;
  pickupAddress: string;
  dropoffAddress: string;
  driverName: string | null;
  vehiclePlate: string | null;
  serviceType: string;
  paymentMethod: string;
  fareCup: number;
  fareTrc: number | null;
  distanceM: number;
  durationS: number;
  surgeMultiplier: number;
  discountCup: number;
}

export function generateReceiptHTML(data: ReceiptData, locale: 'en' | 'es' = 'es'): string {
  const labels = locale === 'en' ? {
    title: 'Ride Receipt',
    date: 'Date',
    pickup: 'Pickup',
    dropoff: 'Dropoff',
    driver: 'Driver',
    vehicle: 'Vehicle',
    service: 'Service',
    payment: 'Payment',
    distance: 'Distance',
    duration: 'Duration',
    fare: 'Total Fare',
    discount: 'Discount',
    surge: 'Surge',
    footer: 'Thank you for riding with TriciGo!',
  } : {
    title: 'Recibo de Viaje',
    date: 'Fecha',
    pickup: 'Recogida',
    dropoff: 'Destino',
    driver: 'Conductor',
    vehicle: 'Vehículo',
    service: 'Servicio',
    payment: 'Método de pago',
    distance: 'Distancia',
    duration: 'Duración',
    fare: 'Tarifa Total',
    discount: 'Descuento',
    surge: 'Tarifa dinámica',
    footer: '¡Gracias por viajar con TriciGo!',
  };

  const distKm = (data.distanceM / 1000).toFixed(1);
  const durMin = Math.round(data.durationS / 60);
  const dateStr = new Date(data.date).toLocaleDateString(locale === 'en' ? 'en-US' : 'es-CU', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const fareCupFormatted = Math.round(data.fareCup / 100);

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px;color:#333;">
  <div style="text-align:center;margin-bottom:24px;">
    <h1 style="color:#F97316;margin:0;font-size:28px;">TriciGo</h1>
    <h2 style="margin:8px 0;font-size:18px;font-weight:600;">${labels.title}</h2>
    <p style="color:#888;font-size:13px;">${labels.date}: ${dateStr}</p>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <tr style="border-bottom:1px solid #eee;"><td style="padding:10px 0;color:#888;">${labels.pickup}</td><td style="padding:10px 0;text-align:right;max-width:250px;">${data.pickupAddress}</td></tr>
    <tr style="border-bottom:1px solid #eee;"><td style="padding:10px 0;color:#888;">${labels.dropoff}</td><td style="padding:10px 0;text-align:right;max-width:250px;">${data.dropoffAddress}</td></tr>
    ${data.driverName ? `<tr style="border-bottom:1px solid #eee;"><td style="padding:10px 0;color:#888;">${labels.driver}</td><td style="padding:10px 0;text-align:right;">${data.driverName}</td></tr>` : ''}
    ${data.vehiclePlate ? `<tr style="border-bottom:1px solid #eee;"><td style="padding:10px 0;color:#888;">${labels.vehicle}</td><td style="padding:10px 0;text-align:right;">${data.vehiclePlate}</td></tr>` : ''}
    <tr style="border-bottom:1px solid #eee;"><td style="padding:10px 0;color:#888;">${labels.service}</td><td style="padding:10px 0;text-align:right;">${data.serviceType}</td></tr>
    <tr style="border-bottom:1px solid #eee;"><td style="padding:10px 0;color:#888;">${labels.distance}</td><td style="padding:10px 0;text-align:right;">${distKm} km</td></tr>
    <tr style="border-bottom:1px solid #eee;"><td style="padding:10px 0;color:#888;">${labels.duration}</td><td style="padding:10px 0;text-align:right;">${durMin} min</td></tr>
    <tr style="border-bottom:1px solid #eee;"><td style="padding:10px 0;color:#888;">${labels.payment}</td><td style="padding:10px 0;text-align:right;">${data.paymentMethod}</td></tr>
    ${data.surgeMultiplier > 1 ? `<tr style="border-bottom:1px solid #eee;"><td style="padding:10px 0;color:#888;">${labels.surge}</td><td style="padding:10px 0;text-align:right;">${data.surgeMultiplier}x</td></tr>` : ''}
    ${data.discountCup > 0 ? `<tr style="border-bottom:1px solid #eee;"><td style="padding:10px 0;color:#22c55e;">${labels.discount}</td><td style="padding:10px 0;text-align:right;color:#22c55e;">-${Math.round(data.discountCup / 100)} CUP</td></tr>` : ''}
  </table>
  <div style="border-top:2px solid #F97316;margin-top:16px;padding-top:16px;text-align:center;">
    <p style="font-size:28px;font-weight:700;color:#F97316;margin:0;">${fareCupFormatted} CUP</p>
  </div>
  <p style="text-align:center;color:#888;font-size:12px;margin-top:24px;">${labels.footer}</p>
  <p style="text-align:center;color:#ccc;font-size:10px;">ID: ${data.rideId.substring(0, 8)}</p>
</body></html>`;
}
