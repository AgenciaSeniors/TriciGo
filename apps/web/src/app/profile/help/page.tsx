'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getSupabaseClient } from '@tricigo/api';

const faqItems = [
  {
    question: 'Como pido un viaje?',
    answer: 'Abre la app, ingresa tu destino, elige el tipo de vehiculo y confirma. Un conductor sera asignado en minutos.',
  },
  {
    question: 'Cuales son los metodos de pago?',
    answer: 'Aceptamos efectivo (CUP), TriciCoins y transferencias moviles. Puedes configurar tu metodo preferido en tu perfil.',
  },
  {
    question: 'Como cancelo un viaje?',
    answer: 'Puedes cancelar un viaje antes de que el conductor llegue al punto de recogida. Puede aplicar una tarifa de cancelacion si el conductor ya esta en camino.',
  },
  {
    question: 'Que son los TriciCoins?',
    answer: 'TriciCoins es nuestra moneda virtual. Puedes ganarlos con referidos, promociones y quests. Se pueden usar para pagar viajes.',
  },
  {
    question: 'Como contacto a mi conductor?',
    answer: 'Una vez asignado el conductor, puedes llamarlo o enviarle un mensaje directamente desde la app.',
  },
  {
    question: 'Que hago si olvide algo en el vehiculo?',
    answer: 'Ve a tu historial de viajes, selecciona el viaje y usa la opcion "Reporte de objeto perdido". Te conectaremos con el conductor.',
  },
  {
    question: 'Como funciona el boton SOS?',
    answer: 'Durante un viaje, puedes presionar el boton SOS para alertar a tus contactos de confianza y compartir tu ubicacion en tiempo real.',
  },
];

export default function HelpPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });
  }, []);

  if (authLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <p style={{ color: '#999' }}>Cargando...</p>
      </div>
    );
  }

  if (!userId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: '1rem' }}>
        <p style={{ color: '#666' }}>Inicia sesion para acceder a la ayuda</p>
        <Link href="/login" style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>
          Iniciar sesion
        </Link>
      </div>
    );
  }

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '2rem 1rem', background: '#fff', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '2rem' }}>
        <Link href="/profile" style={{ color: '#1a1a1a', textDecoration: 'none', marginRight: '1rem' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>Ayuda</h1>
      </div>

      {/* FAQ Accordion */}
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: '#999', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
          Preguntas frecuentes
        </h2>
        <div style={{
          background: '#fff',
          borderRadius: '1rem',
          border: '1px solid #eee',
          overflow: 'hidden',
        }}>
          {faqItems.map((item, index) => (
            <div key={index} style={{ borderBottom: index < faqItems.length - 1 ? '1px solid #f0f0f0' : 'none' }}>
              <button
                onClick={() => setOpenIndex(openIndex === index ? null : index)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  padding: '1rem 1.25rem',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ fontSize: '0.95rem', fontWeight: 500, color: '#1a1a1a', flex: 1, paddingRight: '0.75rem' }}>
                  {item.question}
                </span>
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#999"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    transform: openIndex === index ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.2s',
                    flexShrink: 0,
                  }}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {openIndex === index && (
                <div style={{ padding: '0 1.25rem 1rem', fontSize: '0.9rem', color: '#666', lineHeight: 1.5 }}>
                  {item.answer}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Contact Section */}
      <div style={{
        background: '#f7f7f7',
        borderRadius: '1rem',
        padding: '1.5rem',
        textAlign: 'center',
      }}>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
          <polyline points="22,6 12,13 2,6" />
        </svg>
        <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: '0.75rem 0 0.5rem', color: '#1a1a1a' }}>
          Necesitas mas ayuda?
        </h3>
        <p style={{ fontSize: '0.9rem', color: '#666', margin: '0 0 0.75rem' }}>
          Nuestro equipo de soporte esta disponible para ayudarte.
        </p>
        <a
          href="mailto:soporte@tricigo.com"
          style={{
            display: 'inline-block',
            padding: '0.75rem 1.5rem',
            background: 'var(--primary)',
            color: '#fff',
            borderRadius: '0.75rem',
            textDecoration: 'none',
            fontSize: '0.9rem',
            fontWeight: 600,
          }}
        >
          soporte@tricigo.com
        </a>
      </div>
    </main>
  );
}
