// Origin->destination landing pages for the José Martí airport (Havana) routes.
// High transactional intent ("taxi del aeropuerto de La Habana al Vedado") +
// the tourist-overcharge pain point. Honest framing: approximate distances,
// orientative prices only (never a fixed fare). Server-rendered + in the sitemap.

export interface RouteFaq {
  q: string;
  a: string;
}

export interface AirportRoute {
  /** URL slug: /transporte/aeropuerto-la-habana/<slug> */
  slug: string;
  /** Destination display name. */
  destino: string;
  /** Short approximate-distance note (factual, kept vague on purpose). */
  distancia: string;
  metaDescription: string;
  intro: string;
  bodyParagraphs: string[];
  faqs: RouteFaq[];
}

export const AIRPORT = {
  name: 'Aeropuerto Internacional José Martí',
  shortName: 'aeropuerto de La Habana',
  hubPath: '/transporte/aeropuerto-la-habana',
};

export const AIRPORT_ROUTES: AirportRoute[] = [
  {
    slug: 'vedado',
    destino: 'El Vedado',
    distancia: 'unos 16-18 km (aprox. 25-40 minutos según el tránsito)',
    metaDescription:
      'Del aeropuerto José Martí a El Vedado en taxi: distancia, qué esperar del precio y cómo reservar con TriciGo viendo la tarifa en CUP antes de subir, sin sobrecobro al llegar.',
    intro:
      'El Vedado es uno de los destinos más pedidos al salir del Aeropuerto Internacional José Martí: hoteles, casas particulares, oficinas y la Rampa quedan por esta zona. Aquí te contamos qué esperar del traslado y cómo evitar que te claven con el precio.',
    bodyParagraphs: [
      'El aeropuerto está al sur de La Habana, en Boyeros, y El Vedado queda hacia el norte, junto al malecón. Son <strong>unos 16-18 km</strong> que, según el tránsito y la hora, se hacen en aproximadamente 25 a 40 minutos. Como cualquier traslado de aeropuerto, cuesta más que un viaje urbano corto, así que conviene saber a qué atenerse antes de subir a un auto.',
      'El gran riesgo en el aeropuerto es la <strong>tarifa de turista</strong>: al recién llegado le sueltan un número inflado, a veces en divisa (MLC o dólares) en lugar de pesos. No hay una tarifa fija oficial; el precio justo es un <strong>rango orientativo</strong> que depende de la distancia, la hora y la disponibilidad. La mejor defensa es pactar el precio antes de arrancar o, mejor aún, verlo en pantalla de antemano.',
      'Con <strong>TriciGo</strong> pides un auto desde el teléfono y <strong>ves el precio en CUP antes de confirmar</strong>: lo que ves es lo que pagas, sin negociar al bajar y sin cobros en divisa. Sigues el viaje en tiempo real, el conductor está verificado y pagas en efectivo o con créditos TriciCoin. Para equipaje, el auto es lo más cómodo.',
    ],
    faqs: [
      {
        q: '¿Cuánto se tarda del aeropuerto de La Habana a El Vedado?',
        a: 'Aproximadamente 25 a 40 minutos según el tránsito y la hora del día. La distancia ronda los 16-18 km entre Boyeros (donde está el aeropuerto) y El Vedado.',
      },
      {
        q: '¿Cuánto cuesta el taxi del aeropuerto a El Vedado?',
        a: 'No hay una tarifa fija: depende de la distancia, la hora y la disponibilidad, y siempre cuesta más que un viaje urbano corto. Lo importante es pactar o ver el precio antes de subir. Con TriciGo ves el estimado en CUP antes de confirmar.',
      },
      {
        q: '¿Puedo pagar en pesos cubanos?',
        a: 'Sí. Con TriciGo pagas en CUP, en efectivo o con créditos TriciCoin. No necesitas tarjeta extranjera ni pagar en divisa.',
      },
    ],
  },
  {
    slug: 'habana-vieja',
    destino: 'La Habana Vieja',
    distancia: 'unos 18-20 km (aprox. 30-45 minutos según el tránsito)',
    metaDescription:
      'Del aeropuerto José Martí a La Habana Vieja en taxi: distancia, precio orientativo y cómo reservar con TriciGo viendo la tarifa en CUP antes de subir, sin que te claven.',
    intro:
      'El Centro Histórico de La Habana Vieja —la Catedral, la Plaza Vieja, el Capitolio— es el corazón turístico de la ciudad y uno de los traslados más comunes desde el Aeropuerto José Martí. Esto es lo que conviene saber del viaje.',
    bodyParagraphs: [
      'Del aeropuerto, al sur en Boyeros, hasta el casco histórico junto a la bahía hay <strong>unos 18-20 km</strong>, que se recorren en aproximadamente 30 a 45 minutos según el tránsito. Al llegar a un destino tan turístico, es justo donde más se intenta el sobrecobro al recién llegado.',
      'Ten presente las trampas clásicas del aeropuerto: el precio inflado "de turista", el cobro en MLC o dólares en vez de <strong>CUP</strong>, y el número que cambia al bajar. No existe una tarifa fija; el precio razonable es un <strong>rango orientativo</strong>. La regla de oro: nunca arranques sin tener el precio claro de antemano.',
      'La forma más simple de no llevarte una sorpresa es reservar con <strong>TriciGo</strong>: ingresas tu destino en La Habana Vieja, <strong>ves el precio en CUP antes de confirmar</strong> y un conductor verificado te recoge. Sigues el recorrido en el mapa, pagas en efectivo o con TriciCoin, y olvidas el regateo en plena acera con las maletas.',
    ],
    faqs: [
      {
        q: '¿Cuánto se tarda del aeropuerto a La Habana Vieja?',
        a: 'Alrededor de 30 a 45 minutos según el tránsito, para unos 18-20 km entre el aeropuerto (Boyeros) y el centro histórico junto a la bahía.',
      },
      {
        q: '¿Es seguro tomar un taxi en el aeropuerto de noche?',
        a: 'Con TriciGo el conductor está verificado, sigues el viaje en tiempo real y cuentas con botón SOS. Además ves el precio en CUP antes de confirmar, así que no hay sorpresas al llegar.',
      },
      {
        q: '¿Conviene auto o algo más económico con maletas?',
        a: 'Con equipaje, el auto es lo más cómodo y práctico desde el aeropuerto. El triciclo y la moto van mejor para trayectos cortos sin maletas dentro de la ciudad.',
      },
    ],
  },
  {
    slug: 'miramar',
    destino: 'Miramar (Playa)',
    distancia: 'unos 20-22 km (aprox. 30-45 minutos según el tránsito)',
    metaDescription:
      'Del aeropuerto José Martí a Miramar (Playa) en taxi: distancia, precio orientativo y cómo reservar con TriciGo viendo la tarifa en CUP antes de subir, sin sobrecobro.',
    intro:
      'Miramar, en el municipio Playa, concentra embajadas, oficinas, hoteles y zonas residenciales del oeste de La Habana. Es un destino frecuente desde el Aeropuerto José Martí y aquí te explicamos cómo hacer el traslado sin pagar de más.',
    bodyParagraphs: [
      'Desde el aeropuerto, al sur de la ciudad, hasta Miramar, al oeste junto al litoral, hay <strong>unos 20-22 km</strong>, aproximadamente 30 a 45 minutos según el tránsito. Por ser una zona de negocios y embajadas, muchos viajeros llegan con prisa y poco margen para regatear: razón de más para tener el precio claro de antemano.',
      'En el aeropuerto cuídate del precio "de turista", del cobro en divisa (MLC/dólares) en lugar de <strong>CUP</strong> y del número que sube al final. No hay tarifa fija; el precio justo es un <strong>rango orientativo</strong> según distancia, hora y disponibilidad. Pactar antes —o ver el precio en pantalla— es lo que evita el clavón.',
      'Con <strong>TriciGo</strong> pides un auto a Miramar y <strong>ves el estimado en CUP antes de confirmar</strong>. Conductor verificado, seguimiento en tiempo real, pago en efectivo o con TriciCoin, sin tarjeta extranjera. Llegas a tu reunión o tu hotel sabiendo exactamente cuánto pagaste.',
    ],
    faqs: [
      {
        q: '¿Cuánto se tarda del aeropuerto a Miramar?',
        a: 'Aproximadamente 30 a 45 minutos según el tránsito, para unos 20-22 km entre el aeropuerto (Boyeros) y Miramar (Playa), al oeste de la ciudad.',
      },
      {
        q: '¿Cuánto cuesta el viaje del aeropuerto a Miramar?',
        a: 'No hay una tarifa única: depende de la distancia, la hora y la disponibilidad. Siempre cuesta más que un trayecto urbano corto. Con TriciGo ves el precio en CUP antes de confirmar, sin sorpresas.',
      },
      {
        q: '¿Puedo reservar antes de llegar?',
        a: 'Sí. Puedes pedir el viaje desde la app al aterrizar y ver el precio en CUP antes de confirmar, así no tienes que negociar con maletas en mano.',
      },
    ],
  },
  {
    slug: 'playas-del-este',
    destino: 'Playas del Este',
    distancia: 'unos 30-35 km (aprox. 45-60 minutos según el tránsito)',
    metaDescription:
      'Del aeropuerto José Martí a Playas del Este (Santa María, Guanabo) en taxi: distancia, precio orientativo y cómo reservar con TriciGo viendo la tarifa en CUP antes de subir.',
    intro:
      'Las Playas del Este —Santa María del Mar, Guanabo, Boca Ciega— son el destino de sol y arena más cercano a La Habana. Si llegas al Aeropuerto José Martí y vas directo a la playa, este es el traslado más largo dentro del área de la capital.',
    bodyParagraphs: [
      'Del aeropuerto, al sur de la ciudad, hasta las Playas del Este, al noreste, hay <strong>unos 30-35 km</strong>, aproximadamente 45 a 60 minutos según el tránsito. Al ser un trayecto más largo, naturalmente cuesta más que un viaje dentro del centro, y es importante tenerlo claro de antemano para no llevarte un susto.',
      'Como en todo traslado de aeropuerto, cuidado con el precio "de turista", el cobro en MLC o dólares en vez de <strong>CUP</strong>, y la cifra que cambia al llegar. No hay tarifa fija; el precio razonable es un <strong>rango orientativo</strong> que depende de la distancia, la hora y la disponibilidad de autos.',
      'Con <strong>TriciGo</strong> reservas un auto hasta Santa María, Guanabo o Boca Ciega y <strong>ves el precio en CUP antes de confirmar</strong>. Para un trayecto largo como este, ver la tarifa de antemano es aún más valioso: nada de negociar bajo el sol con las maletas. Conductor verificado, seguimiento en vivo y pago en efectivo o con TriciCoin.',
    ],
    faqs: [
      {
        q: '¿Cuánto se tarda del aeropuerto a las Playas del Este?',
        a: 'Aproximadamente 45 a 60 minutos según el tránsito, para unos 30-35 km entre el aeropuerto (Boyeros) y las Playas del Este (Santa María, Guanabo).',
      },
      {
        q: '¿Cuánto cuesta el taxi del aeropuerto a Santa María o Guanabo?',
        a: 'Al ser un trayecto largo, cuesta más que un viaje urbano corto, pero no hay una tarifa fija: depende de distancia, hora y disponibilidad. Con TriciGo ves el precio en CUP antes de confirmar.',
      },
      {
        q: '¿Vale la pena reservar por app para ir a la playa?',
        a: 'Sí, sobre todo en un trayecto largo: ves el precio de antemano, evitas el sobrecobro al recién llegado y no tienes que regatear con el equipaje. Pagas en CUP, sin tarjeta extranjera.',
      },
    ],
  },
];

export function getAllRouteSlugs(): string[] {
  return AIRPORT_ROUTES.map((r) => r.slug);
}

export function getRouteBySlug(slug: string): AirportRoute | null {
  return AIRPORT_ROUTES.find((r) => r.slug === slug) ?? null;
}
