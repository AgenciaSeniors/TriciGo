// Single source of truth for the home FAQ. Used by BOTH the FAQPage JSON-LD
// (app/page.tsx) and the visible FAQ accordion (HomeClient) so the structured
// data and the on-page text can never drift apart. Spanish (canonical locale).
// Answers describe only real, shipped features.

export interface HomeFaq {
  q: string;
  a: string;
}

export const HOME_FAQS: HomeFaq[] = [
  {
    q: '¿Cómo funciona TriciGo?',
    a: 'Descarga la app, ingresa tu destino, elige entre triciclo, moto o auto, y confirma tu viaje. Un conductor cercano te recoge y sigues el recorrido en el mapa en vivo.',
  },
  {
    q: '¿En qué ciudades opera TriciGo?',
    a: 'TriciGo se despliega ciudad por ciudad. Abre la app o mira la página de cobertura para ver las zonas con servicio disponible en cada momento.',
  },
  {
    q: '¿Cuánto cuesta un viaje?',
    a: 'Siempre ves el precio estimado antes de confirmar, así sabes cuánto vas a pagar y nadie te clava. El monto depende de la distancia, el tipo de vehículo y la demanda.',
  },
  {
    q: '¿Necesito tarjeta de crédito para viajar?',
    a: 'No. Puedes pagar tus viajes en efectivo, sin tarjeta. Si prefieres pagar sin efectivo, cargas saldo TriciCoin desde la app (esa recarga sí se hace con tarjeta) y el viaje se descuenta solo.',
  },
  {
    q: '¿Cómo pago mi viaje?',
    a: 'En efectivo, con saldo TriciCoin o de forma mixta. Un TriciCoin equivale a un peso, así que lo que cargas es lo que vale.',
  },
  {
    q: '¿Es seguro viajar con TriciGo?',
    a: 'Sí. La app incluye botón SOS, seguimiento en tiempo real, contactos de confianza que pueden ver tu recorrido y verificación de los conductores antes de manejar.',
  },
  {
    q: '¿Puedo programar un viaje para más tarde?',
    a: 'Sí. Puedes reservar un viaje para una hora posterior y hasta dejar programados tus viajes de siempre (por ejemplo, al trabajo o a la escuela) para que se repitan.',
  },
  {
    q: '¿Puedo enviar paquetes con TriciGo?',
    a: 'Sí. Con el servicio de mensajería envías paquetes, documentos o encargos de un punto a otro de la ciudad, con foto de entrega y un código de confirmación para quien recibe.',
  },
];
