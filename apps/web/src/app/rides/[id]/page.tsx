'use client';

import { useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { rideService, getSupabaseClient, notificationService, deliveryService, disputeService, lostItemService, useFeatureFlag } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { formatTRC, formatTRCasUSD, formatCUP, getRelativeDay, formatTime, formatDate, DEFAULT_EXCHANGE_RATE, generateReceiptHTML, riderChargedTotal, riderChargedTotalTrc } from '@tricigo/utils';
import type { RideWithDriver, RideSplit, RidePricingSnapshot, RideDispute, LostItem } from '@tricigo/types';
import { WebSkeletonList } from '@/components/WebSkeleton';
import { TipFlow } from '@/components/TipFlow';

// Static route map for the historical detail — reuse TrackingMap with no driver
// props (parity con el mapa del detalle de viaje móvil). ssr:false (Leaflet/Mapbox).
const TrackingMap = dynamic(() => import('../../track/TrackingMap'), {
  ssr: false,
  loading: () => <div style={{ width: '100%', height: 200, background: 'var(--bg-light)', borderRadius: '0.75rem' }} />,
});

type CargoDetails = {
  recipient_name?: string; recipient_phone?: string; package_description?: string;
  package_category?: string; estimated_weight_kg?: number; special_instructions?: string | null;
  client_accompanies?: boolean; delivery_otp?: string | null;
  pickup_photo_url?: string | null; delivery_photo_url?: string | null;
};

const STATUS_CONFIG: Record<string, { label: string; bg: string; color: string }> = {
  searching: { label: 'Buscando conductor', bg: '#fef3c7', color: '#d97706' },
  accepted: { label: 'Aceptado', bg: '#dbeafe', color: '#2563eb' },
  driver_en_route: { label: 'Conductor en camino', bg: '#dbeafe', color: '#2563eb' },
  arrived_at_pickup: { label: 'Conductor llego', bg: '#dbeafe', color: '#2563eb' },
  in_progress: { label: 'En curso', bg: '#dbeafe', color: '#2563eb' },
  completed: { label: 'Completado', bg: '#dcfce7', color: '#16a34a' },
  canceled: { label: 'Cancelado', bg: '#fee2e2', color: '#dc2626' },
  disputed: { label: 'Disputado', bg: '#fef3c7', color: '#d97706' },
};

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Efectivo',
  tricicoin: 'TriciCoin',
  mixed: 'Mixto',
  tropipay: 'Tarjeta', // deprecated — legacy rides may still have this value
  corporate: 'Corporativo',
};

const SERVICE_LABELS: Record<string, string> = {
  triciclo_basico: 'Triciclo Basico',
  triciclo_premium: 'Triciclo Premium',
  moto_standard: 'Moto Estandar',
  auto_standard: 'Auto Estandar',
  auto_premium: 'Auto Premium',
};

export default function RideDetailPage() {
  const router = useRouter();
  const params = useParams();
  const rideId = params?.id as string | undefined;
  // Shared `rider` namespace — same keys the mobile ride detail uses for the
  // dispute / lost-item cards (PASS2 PR-J parity section below).
  const { t } = useTranslation('rider');

  // ── Dispute / lost-item flags (parity con apps/client/app/ride/[id].tsx) ──
  const disputesEnabled = useFeatureFlag('formal_disputes_enabled');
  const lostFoundEnabled = useFeatureFlag('lost_and_found_enabled');

  // ── Auth state ──
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // ── Data state ──
  const [ride, setRide] = useState<RideWithDriver | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Receipt state (parity con RideCompleteView) ──
  const [downloadingReceipt, setDownloadingReceipt] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [receiptEmailed, setReceiptEmailed] = useState(false);

  // ── Cargo/delivery details (only for ride_mode='cargo') ──
  const [cargo, setCargo] = useState<CargoDetails | null>(null);

  // ── Fare-split participants (read-only status, only when is_split) ──
  const [splits, setSplits] = useState<RideSplit[]>([]);

  // ── Pricing snapshot (base/per-km/per-min) for the CUP fare breakdown,
  //    parity con el desglose del detalle móvil (rideService.getPricingSnapshot). ──
  const [pricing, setPricing] = useState<RidePricingSnapshot | null>(null);

  // ── Dispute + lost-item status for completed/disputed rides ──
  const [dispute, setDispute] = useState<RideDispute | null>(null);
  const [lostItem, setLostItem] = useState<LostItem | null>(null);

  // ── Auth effect ──
  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  // ── Load ride (extracted as a memoized fn so the TipFlow can call
  // it after a tip is submitted to refresh the receipt with the new
  // tip_amount). ──
  const loadRide = useCallback(async () => {
    if (!userId || !rideId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await rideService.getRideWithDriver(rideId);
      if (!data) {
        setError('Viaje no encontrado');
      } else {
        setRide(data);
      }
    } catch (err) {
      console.error('Failed to load ride:', err);
      setError('Error al cargar el viaje');
    } finally {
      setLoading(false);
    }
  }, [userId, rideId]);

  useEffect(() => {
    loadRide();
  }, [loadRide]);

  // Fetch delivery details for cargo rides (parity con el bloque cargo del detalle móvil).
  useEffect(() => {
    if (!ride || ride.ride_mode !== 'cargo') { setCargo(null); return; }
    deliveryService.getDeliveryDetails(ride.id)
      .then((d) => { if (d) setCargo(d as CargoDetails); })
      .catch(() => { /* non-critical */ });
  }, [ride?.ride_mode, ride?.id]);

  // Fetch fare-split participants for split rides (read-only status).
  useEffect(() => {
    if (!ride || !ride.is_split) { setSplits([]); return; }
    rideService.getSplitsForRide(ride.id)
      .then(setSplits)
      .catch(() => { /* non-critical */ });
  }, [ride?.is_split, ride?.id]);

  // Fetch the pricing snapshot for the per-km/per-min CUP breakdown.
  useEffect(() => {
    if (!ride) { setPricing(null); return; }
    rideService.getPricingSnapshot(ride.id)
      .then(setPricing)
      .catch(() => { /* non-critical — falls back to unit-only rows */ });
  }, [ride?.id]);

  // Fetch dispute + lost-item status (parity con el detalle móvil, que los
  // carga para viajes completed/disputed y completed respectivamente).
  useEffect(() => {
    if (!ride || (ride.status !== 'completed' && ride.status !== 'disputed')) {
      setDispute(null);
      setLostItem(null);
      return;
    }
    disputeService.getDisputeByRide(ride.id)
      .then(setDispute)
      .catch(() => { /* non-critical — no dispute card */ });
    if (ride.status === 'completed') {
      lostItemService.getLostItemByRide(ride.id)
        .then(setLostItem)
        .catch(() => { /* non-critical — no lost-item card */ });
    }
  }, [ride?.status, ride?.id]);

  // ── Receipt: descargar (HTML imprimible → PDF) o enviar por email ──
  const handleDownloadReceipt = async () => {
    if (!rideId || downloadingReceipt) return;
    setDownloadingReceipt(true);
    const win = typeof window !== 'undefined' ? window.open('', '_blank') : null;
    try {
      const data = await rideService.getReceiptData(rideId, 'passenger');
      const html = generateReceiptHTML(data);
      if (win) {
        win.document.open();
        win.document.write(html);
        win.document.close();
        win.focus();
        setTimeout(() => { try { win.print(); } catch { /* user can print manually */ } }, 500);
      } else {
        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `recibo-tricigo-${rideId.slice(0, 8)}.html`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
    } catch {
      if (win) win.close();
      alert('No se pudo generar el recibo. Probá de nuevo en un momento.');
    } finally {
      setDownloadingReceipt(false);
    }
  };

  const handleEmailReceipt = async () => {
    if (!userId || !rideId || sendingEmail) return;
    setSendingEmail(true);
    try {
      await notificationService.sendRideReceipt(rideId, userId);
      setReceiptEmailed(true);
    } catch {
      alert('No se pudo enviar el recibo');
    } finally {
      setSendingEmail(false);
    }
  };

  // ── Auth gate (after all hooks) ──
  if (authLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem' }}>
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </div>
          <p style={{ fontSize: '0.875rem' }}>Cargando...</p>
        </div>
      </div>
    );
  }
  if (!userId) {
    router.replace('/login');
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem' }}>
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </div>
          <p style={{ fontSize: '0.875rem' }}>Cargando...</p>
        </div>
      </div>
    );
  }

  return (
    <main style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '1rem' }}>
      <div style={{ maxWidth: 500, width: '100%' }}>
        <Link href="/rides" aria-label="Volver al historial de viajes" style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: '0.875rem' }}>
          &larr; Historial de viajes
        </Link>

        <h1 style={{ fontSize: 'clamp(1.25rem, 4vw, 1.75rem)', fontWeight: 800, marginTop: '1rem', marginBottom: '1.5rem' }}>
          Detalle del viaje
        </h1>

        {/* Loading */}
        {loading && <WebSkeletonList count={3} />}

        {/* Error */}
        {!loading && error && (
          <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-tertiary)' }}>
            <p style={{ fontSize: '1rem', fontWeight: 600, color: '#dc2626' }}>{error}</p>
            <Link
              href="/rides"
              style={{
                display: 'inline-block', marginTop: '1rem', padding: '0.75rem 1.5rem',
                background: 'var(--primary)', color: 'white', borderRadius: '0.75rem',
                textDecoration: 'none', fontWeight: 600, fontSize: '0.875rem',
              }}
            >
              Volver al historial
            </Link>
          </div>
        )}

        {/* Ride detail */}
        {!loading && ride && (() => {
          const statusInfo = STATUS_CONFIG[ride.status] ?? { label: ride.status, bg: 'var(--bg-hover)', color: 'var(--text-secondary)' };

          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {/* Status badge */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{
                  fontSize: '0.8rem', fontWeight: 600, padding: '0.3rem 0.75rem',
                  borderRadius: '1rem', background: statusInfo.bg, color: statusInfo.color,
                }}>
                  {statusInfo.label}
                </span>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                  {SERVICE_LABELS[ride.service_type] ?? ride.service_type}
                </span>
              </div>

              {/* Addresses */}
              <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid var(--border-light)', background: 'var(--bg-card)' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--success)', flexShrink: 0, marginTop: 4 }} />
                    <div>
                      <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: 0 }}>Recogida</p>
                      <p style={{ fontSize: '0.875rem', color: 'var(--text-primary)', margin: 0 }}>{ride.pickup_address}</p>
                    </div>
                  </div>
                  <div style={{ borderLeft: '2px dashed var(--border)', marginLeft: 4, height: 16 }} />
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--error)', flexShrink: 0, marginTop: 4 }} />
                    <div>
                      <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: 0 }}>Destino</p>
                      <p style={{ fontSize: '0.875rem', color: 'var(--text-primary)', margin: 0 }}>{ride.dropoff_address}</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Route map (static, sin driver) — parity con el mapa del detalle de viaje móvil */}
              {(() => {
                const pLat = typeof ride.pickup_location === 'object' ? ride.pickup_location.latitude : 0;
                const pLng = typeof ride.pickup_location === 'object' ? ride.pickup_location.longitude : 0;
                const dLat = typeof ride.dropoff_location === 'object' ? ride.dropoff_location.latitude : 0;
                const dLng = typeof ride.dropoff_location === 'object' ? ride.dropoff_location.longitude : 0;
                if (!pLat || !dLat) return null;
                return (
                  <div style={{ borderRadius: '0.75rem', overflow: 'hidden', border: '1px solid var(--border-light)', height: 200 }}>
                    <TrackingMap
                      pickupLat={pLat}
                      pickupLng={pLng}
                      dropoffLat={dLat}
                      dropoffLng={dLng}
                      vehicleType={ride.vehicle_type ?? undefined}
                      rideStatus={ride.status}
                      style={{ width: '100%', height: '100%', borderRadius: 0 }}
                    />
                  </div>
                );
              })()}

              {/* Driver info */}
              {ride.driver_name && (
                <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid var(--border-light)', background: 'var(--bg-card)' }}>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0 0 0.5rem' }}>Conductor</p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div style={{
                      width: 44, height: 44, borderRadius: '50%', background: 'var(--bg-hover)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '1.25rem', fontWeight: 700, color: 'var(--primary)', flexShrink: 0,
                      overflow: 'hidden',
                    }}>
                      {ride.driver_avatar_url
                        ? <img src={ride.driver_avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : ride.driver_name.charAt(0).toUpperCase()
                      }
                    </div>
                    <div>
                      <p style={{ fontSize: '0.95rem', fontWeight: 600, margin: 0 }}>{ride.driver_name}</p>
                      {ride.driver_rating != null && (
                        <p style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', margin: 0 }}>
                          ★ {ride.driver_rating.toFixed(1)}
                          {ride.driver_total_rides != null && ` · ${ride.driver_total_rides} viajes`}
                        </p>
                      )}
                    </div>
                  </div>
                  {(ride.vehicle_make || ride.vehicle_plate) && (
                    <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      {[
                        ride.vehicle_color,
                        [ride.vehicle_make, ride.vehicle_model].filter(Boolean).join(' '),
                        ride.vehicle_year,
                      ].filter(Boolean).join(' · ')}
                      {ride.vehicle_plate && (
                        <span style={{
                          marginLeft: '0.5rem', padding: '0.15rem 0.4rem', background: 'var(--bg-hover)',
                          borderRadius: '0.25rem', fontWeight: 600, fontSize: '0.75rem',
                        }}>
                          {ride.vehicle_plate}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Cargo/delivery details (parity con el bloque cargo del detalle móvil) */}
              {ride.ride_mode === 'cargo' && cargo && (
                <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid var(--border-light)', background: 'var(--bg-card)' }}>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0 0 0.5rem', textTransform: 'uppercase', fontWeight: 600 }}>Envío</p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                    {cargo.recipient_name && <div><span style={{ color: 'var(--text-tertiary)' }}>Destinatario: </span><strong>{cargo.recipient_name}</strong></div>}
                    {cargo.recipient_phone && <div><span style={{ color: 'var(--text-tertiary)' }}>Teléfono: </span>{cargo.recipient_phone}</div>}
                    {cargo.package_description && <div><span style={{ color: 'var(--text-tertiary)' }}>Paquete: </span>{cargo.package_description}</div>}
                    {cargo.delivery_otp && <div><span style={{ color: 'var(--text-tertiary)' }}>Código de entrega: </span><strong style={{ letterSpacing: '0.1em' }}>{cargo.delivery_otp}</strong></div>}
                    {cargo.special_instructions && <div><span style={{ color: 'var(--text-tertiary)' }}>Instrucciones: </span>{cargo.special_instructions}</div>}
                  </div>
                  {(cargo.pickup_photo_url || cargo.delivery_photo_url) && (
                    <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
                      {cargo.pickup_photo_url && (
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginBottom: 4 }}>Recogida</div>
                          <img src={cargo.pickup_photo_url} alt="Recogida" style={{ width: '100%', height: 90, objectFit: 'cover', borderRadius: 8 }} />
                        </div>
                      )}
                      {cargo.delivery_photo_url && (
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginBottom: 4 }}>Entrega</div>
                          <img src={cargo.delivery_photo_url} alt="Entrega" style={{ width: '100%', height: 90, objectFit: 'cover', borderRadius: 8 }} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Fare-split participants (read-only, parity con el estado de
                  división de tarifa). Sólo cuando el viaje es compartido. */}
              {ride.is_split && splits.length > 0 && (
                <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid var(--border-light)', background: 'var(--bg-card)' }}>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0 0 0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>Tarifa dividida</p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {splits.map((s) => {
                      const fareTrc = ride.final_fare_trc ?? ride.estimated_fare_trc ?? 0;
                      const shareTrc = fareTrc > 0 ? Math.round(fareTrc * s.share_pct / 100) : null;
                      return (
                        <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <div style={{ minWidth: 0 }}>
                            <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-primary)' }}>{s.user_name || s.user_phone || '…'}</p>
                            <p style={{ margin: '0.1rem 0 0', fontSize: '0.74rem', color: 'var(--text-tertiary)' }}>
                              {s.paid_at ? 'Pagado' : s.accepted_at ? 'Aceptado' : 'Pendiente'} — {s.share_pct}%
                            </p>
                          </div>
                          {shareTrc != null && (
                            <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>{formatTRC(shareTrc)}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Status timestamps (W4.5) */}
              {(() => {
                const timestamps: { label: string; time: string | null; icon: string }[] = [
                  { label: 'Solicitado', time: ride.created_at, icon: '📝' },
                  { label: 'Aceptado', time: ride.accepted_at, icon: '✅' },
                  { label: 'Conductor llego', time: ride.driver_arrived_at, icon: '📍' },
                  { label: 'Recogida', time: ride.pickup_at, icon: '🚗' },
                  { label: 'Completado', time: ride.completed_at, icon: '🏁' },
                  { label: 'Cancelado', time: ride.canceled_at, icon: '❌' },
                ].filter((ts) => ts.time != null);

                if (timestamps.length === 0) return null;

                return (
                  <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid var(--border-light)', background: 'var(--bg-card)' }}>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0 0 0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>Cronologia del viaje</p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                      {timestamps.map((ts, idx) => (
                        <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                            <span style={{ fontSize: '1rem' }} aria-hidden="true">{ts.icon}</span>
                            {idx < timestamps.length - 1 && (
                              <div style={{ width: 1, height: 20, background: 'var(--border)', marginTop: 2 }} />
                            )}
                          </div>
                          <div style={{ paddingBottom: idx < timestamps.length - 1 ? '0.5rem' : 0 }}>
                            <p style={{ margin: 0, fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>{ts.label}</p>
                            <p style={{ margin: '0.1rem 0 0', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                              {formatDate(ts.time!)} · {formatTime(ts.time!)}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                    {ride.canceled_at && ride.cancellation_reason && (
                      <p style={{ margin: '0.75rem 0 0', fontSize: '0.8rem', color: 'var(--error)', fontStyle: 'italic' }}>
                        Motivo: {ride.cancellation_reason}
                      </p>
                    )}
                  </div>
                );
              })()}

              {/* Fare breakdown (W4.6) */}
              <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid var(--border-light)', background: 'var(--bg-card)' }}>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0 0 0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>Desglose de tarifa</p>

                {/* A2 (2026-06-04): tarifa del viaje (subtotal pre-descuento) en
                    vez del itemizado base/per_km/per_min, que NO suma el total
                    (la tarifa usa una duración neutra oculta — BUG-221 — y los
                    completados usan paridad estricta). Distancia/tiempo van como
                    info, no como cargo. Subtotal − descuento + espera + propina
                    = total, que sí reconcilia. */}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Tarifa del viaje</span>
                  <span style={{ fontSize: '0.85rem', fontWeight: 500 }}>{formatCUP(pricing?.subtotal ?? ride.estimated_fare_cup)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>Distancia · Tiempo</span>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    {((ride.actual_distance_m ?? ride.estimated_distance_m) / 1000).toFixed(1)} km · {Math.round((ride.actual_duration_s ?? ride.estimated_duration_s) / 60)} min
                  </span>
                </div>

                {/* Surge multiplier */}
                {ride.surge_multiplier > 1 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                    <span style={{ fontSize: '0.8rem', color: '#d97706', fontWeight: 600 }}>Mal tiempo</span>
                    <span style={{ fontSize: '0.8rem', color: '#d97706', fontWeight: 600 }}>
                      {ride.surge_multiplier.toFixed(1)}x
                    </span>
                  </div>
                )}

                {/* Discount */}
                {ride.discount_amount_cup > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--success)', fontWeight: 600 }}>Descuento</span>
                    <span style={{ fontSize: '0.8rem', color: 'var(--success)', fontWeight: 600 }}>
                      -{formatCUP(ride.discount_amount_cup)}
                    </span>
                  </div>
                )}

                {/* Wait time charge */}
                {ride.wait_time_charge_cup > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>Cargo por espera ({ride.wait_time_minutes} min)</span>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      {formatCUP(ride.wait_time_charge_cup)}
                    </span>
                  </div>
                )}

                {/* Tip */}
                {ride.tip_amount > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>Propina</span>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      {formatTRC(ride.tip_amount)}
                    </span>
                  </div>
                )}

                {/* Cancellation fee */}
                {ride.cancellation_fee_cup > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--error)', fontWeight: 600 }}>Tarifa de cancelacion</span>
                    <span style={{ fontSize: '0.8rem', color: 'var(--error)', fontWeight: 600 }}>
                      {formatCUP(ride.cancellation_fee_cup)}
                    </span>
                  </div>
                )}

                {/* Divider + Final fare. riderChargedTotal sums the tip back
                    in (add_tip only increments rides.tip_amount, never
                    final_fare_*) so the total reconciles with the breakdown
                    above AND with what the wallet was actually debited. CUP is
                    the primary currency; TRC only accompanies wallet-paid
                    rides (showing TRC as primary on a cash ride was wrong). */}
                {ride.final_fare_cup != null && (() => {
                  const totalCup = riderChargedTotal(ride);
                  const totalTrc = ['tricicoin', 'mixed'].includes(ride.payment_method) ? riderChargedTotalTrc(ride) : null;
                  return (
                  <>
                    <div style={{ borderTop: '1px solid var(--border-light)', margin: '0.75rem 0' }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>Total final</span>
                      <div style={{ textAlign: 'right' }}>
                        <span style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--primary)' }}>
                          {formatCUP(totalCup)}
                        </span>
                        <p style={{ margin: '0.15rem 0 0', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                          {totalTrc != null ? <>{formatTRC(totalTrc)} · </> : null}~{formatTRCasUSD(totalCup, ride.exchange_rate_usd_cup ?? DEFAULT_EXCHANGE_RATE)}
                        </p>
                      </div>
                    </div>
                  </>
                  );
                })()}

                {/* Exchange rate */}
                {ride.exchange_rate_usd_cup && (
                  <p style={{ margin: '0.5rem 0 0', fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>
                    Tasa al momento: 1 USD = {ride.exchange_rate_usd_cup} CUP
                  </p>
                )}
              </div>

              {/* Details */}
              <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid var(--border-light)', background: 'var(--bg-card)' }}>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0 0 0.75rem' }}>Detalles</p>

                {[
                  { label: 'Metodo de pago', value: PAYMENT_LABELS[ride.payment_method] ?? ride.payment_method },
                  { label: 'Fecha', value: `${formatDate(ride.created_at)} · ${formatTime(ride.created_at)}` },
                  { label: 'Tipo de servicio', value: SERVICE_LABELS[ride.service_type] ?? ride.service_type },
                  ride.actual_distance_m != null
                    ? { label: 'Distancia', value: `${(ride.actual_distance_m / 1000).toFixed(1)} km` }
                    : { label: 'Distancia estimada', value: `${(ride.estimated_distance_m / 1000).toFixed(1)} km` },
                  ride.actual_duration_s != null
                    ? { label: 'Duracion', value: `${Math.round(ride.actual_duration_s / 60)} min` }
                    : { label: 'Duracion estimada', value: `${Math.round(ride.estimated_duration_s / 60)} min` },
                ].map((item, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>{item.label}</span>
                    <span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--text-primary)' }}>{item.value}</span>
                  </div>
                ))}
              </div>
              {/* Tip flow — only for non-cash rides that don't already have
                  a tip_amount. Cash tips happen offline so we don't surface
                  the UI; if the user already tipped, hide the prompt to
                  avoid duplicate charges. Mirrors the visibility predicate
                  in apps/client/src/components/RideCompleteView.tsx:582. */}
              {ride.status === 'completed' &&
                ride.payment_method !== 'cash' &&
                userId &&
                (!ride.tip_amount || ride.tip_amount === 0) && (
                <TipFlow
                  rideId={ride.id}
                  userId={userId}
                  fareCup={ride.final_fare_cup ?? ride.estimated_fare_cup ?? 0}
                  onTipSubmitted={loadRide}
                />
              )}

              {/* Recibo — descargar (HTML imprimible → PDF) o enviar por email.
                  Solo en viajes completados (parity con RideCompleteView). */}
              {ride.status === 'completed' && (
                <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid var(--border-light)', background: 'var(--bg-card)' }}>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0 0 0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>Recibo</p>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      type="button"
                      onClick={handleDownloadReceipt}
                      disabled={downloadingReceipt}
                      style={{ flex: 1, padding: '0.65rem', borderRadius: '0.6rem', border: '1px solid var(--border)', background: 'var(--bg-card)', cursor: downloadingReceipt ? 'not-allowed' : 'pointer', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', opacity: downloadingReceipt ? 0.6 : 1 }}
                    >
                      {downloadingReceipt ? 'Generando...' : 'Descargar recibo'}
                    </button>
                    <button
                      type="button"
                      onClick={handleEmailReceipt}
                      disabled={sendingEmail || receiptEmailed}
                      style={{ flex: 1, padding: '0.65rem', borderRadius: '0.6rem', border: '1px solid var(--border)', background: receiptEmailed ? 'rgba(0,200,83,0.1)' : 'var(--bg-card)', cursor: (sendingEmail || receiptEmailed) ? 'default' : 'pointer', fontSize: '0.82rem', fontWeight: 600, color: receiptEmailed ? '#00C853' : 'var(--text-primary)', opacity: sendingEmail ? 0.6 : 1 }}
                    >
                      {receiptEmailed ? '✓ Enviado' : sendingEmail ? 'Enviando...' : 'Enviar por email'}
                    </button>
                  </div>
                </div>
              )}

              {/* Dispute status card (parity con la card del detalle móvil) */}
              {dispute && (() => {
                const palette = dispute.status === 'resolved_rider'
                  ? { bg: '#dcfce7', color: '#16a34a' }
                  : dispute.status === 'resolved_driver'
                    ? { bg: '#fee2e2', color: '#dc2626' }
                    : { bg: '#fef3c7', color: '#d97706' };
                const statusLabels: Record<string, string> = {
                  open: t('dispute.status_open', { defaultValue: 'Abierta' }),
                  under_review: t('dispute.status_under_review', { defaultValue: 'En revisión' }),
                  escalated: t('dispute.status_escalated', { defaultValue: 'Escalada' }),
                  resolved_rider: t('dispute.status_resolved_rider', { defaultValue: 'Resuelta a tu favor' }),
                  resolved_driver: t('dispute.status_resolved_driver', { defaultValue: 'Resuelta a favor del conductor' }),
                  closed: t('dispute.status_closed', { defaultValue: 'Cerrada' }),
                };
                return (
                  <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid #fed7aa', background: 'rgba(255,237,213,0.45)' }}>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0 0 0.5rem', textTransform: 'uppercase', fontWeight: 600 }}>
                      {t('dispute.your_dispute', { defaultValue: 'Tu disputa' })}
                    </p>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        {t(`dispute.reason_${dispute.reason}`, { defaultValue: dispute.reason })}
                      </span>
                      <span style={{ fontSize: '0.75rem', fontWeight: 600, padding: '0.25rem 0.6rem', borderRadius: '1rem', background: palette.bg, color: palette.color, whiteSpace: 'nowrap' }}>
                        {statusLabels[dispute.status] ?? dispute.status}
                      </span>
                    </div>
                    {dispute.resolution_notes && (
                      <div style={{ marginTop: '0.6rem', paddingTop: '0.6rem', borderTop: '1px solid #fed7aa' }}>
                        <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0 0 0.2rem' }}>
                          {t('dispute.resolution_notes', { defaultValue: 'Notas de resolución' })}
                        </p>
                        <p style={{ fontSize: '0.85rem', color: 'var(--text-primary)', margin: 0 }}>{dispute.resolution_notes}</p>
                      </div>
                    )}
                    {dispute.refund_amount_trc != null && dispute.refund_amount_trc > 0 && (
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '0.4rem 0 0' }}>
                        {t('dispute.refund_amount', { defaultValue: 'Monto de reembolso' })}: {formatTRC(dispute.refund_amount_trc)}
                      </p>
                    )}
                  </div>
                );
              })()}

              {/* Lost item status card (parity con la card del detalle móvil) */}
              {lostItem && (() => {
                const palette = lostItem.status === 'returned'
                  ? { bg: '#dcfce7', color: '#16a34a' }
                  : lostItem.status === 'closed' || lostItem.status === 'not_found'
                    ? { bg: '#fee2e2', color: '#dc2626' }
                    : { bg: '#fef3c7', color: '#d97706' };
                const statusLabels: Record<string, string> = {
                  reported: t('lost_found.status_reported', { defaultValue: 'Reportado' }),
                  driver_notified: t('lost_found.status_driver_notified', { defaultValue: 'Conductor notificado' }),
                  found: t('lost_found.status_found', { defaultValue: 'Encontrado' }),
                  not_found: t('lost_found.status_not_found', { defaultValue: 'No encontrado' }),
                  return_arranged: t('lost_found.status_return_arranged', { defaultValue: 'Devolución coordinada' }),
                  returned: t('lost_found.status_returned', { defaultValue: 'Devuelto' }),
                  closed: t('lost_found.status_closed', { defaultValue: 'Cerrado' }),
                };
                return (
                  <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid #fde68a', background: 'rgba(254,243,199,0.45)' }}>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0 0 0.5rem', textTransform: 'uppercase', fontWeight: 600 }}>
                      {t('lost_found.title', { defaultValue: 'Objetos perdidos' })}
                    </p>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        {t(`lost_found.category_${lostItem.category}`, { defaultValue: lostItem.category })}
                      </span>
                      <span style={{ fontSize: '0.75rem', fontWeight: 600, padding: '0.25rem 0.6rem', borderRadius: '1rem', background: palette.bg, color: palette.color, whiteSpace: 'nowrap' }}>
                        {statusLabels[lostItem.status] ?? lostItem.status}
                      </span>
                    </div>
                    {lostItem.driver_found === true && lostItem.return_location && (
                      <div style={{ marginTop: '0.6rem', paddingTop: '0.6rem', borderTop: '1px solid #fde68a' }}>
                        <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0 0 0.2rem' }}>
                          {t('lost_found.return_location', { defaultValue: 'Lugar de devolución' })}
                        </p>
                        <p style={{ fontSize: '0.85rem', color: 'var(--text-primary)', margin: 0 }}>{lostItem.return_location}</p>
                      </div>
                    )}
                    {lostItem.return_fee_cup != null && lostItem.return_fee_cup > 0 && (
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '0.4rem 0 0' }}>
                        {t('lost_found.return_fee', { defaultValue: 'Tarifa de devolución' })}: {formatCUP(lostItem.return_fee_cup)}
                      </p>
                    )}
                  </div>
                );
              })()}

              {/* Post-ride actions: dispute + lost item (PASS2 PR-J — same
                  gating as the mobile CTAs: completed ride, feature flag on,
                  no existing dispute/report; lost item also needs a driver). */}
              {ride.status === 'completed' && (disputesEnabled || lostFoundEnabled) && (!dispute || !lostItem) && (
                <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid var(--border-light)', background: 'var(--bg-card)' }}>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0 0 0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>
                    {t('ride.post_ride_help', { defaultValue: '¿Algún problema con este viaje?' })}
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {disputesEnabled && !dispute && (
                      <Link
                        href={`/rides/${ride.id}/dispute`}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.8rem 1rem',
                          borderRadius: '0.75rem', border: '1px solid #fed7aa', textDecoration: 'none',
                          color: 'var(--text-primary)', fontSize: '0.9rem', background: 'var(--bg-card)',
                        }}
                      >
                        <span aria-hidden="true">⚠️</span>
                        <span style={{ flex: 1, fontWeight: 600 }}>{t('dispute.open_dispute', { defaultValue: 'Disputar viaje' })}</span>
                        <span aria-hidden="true" style={{ color: 'var(--text-tertiary)' }}>›</span>
                      </Link>
                    )}
                    {lostFoundEnabled && !lostItem && ride.driver_user_id && (
                      <Link
                        href={`/rides/${ride.id}/lost-item`}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.8rem 1rem',
                          borderRadius: '0.75rem', border: '1px solid #fde68a', textDecoration: 'none',
                          color: 'var(--text-primary)', fontSize: '0.9rem', background: 'var(--bg-card)',
                        }}
                      >
                        <span aria-hidden="true">🔍</span>
                        <span style={{ flex: 1, fontWeight: 600 }}>{t('lost_found.report_item', { defaultValue: 'Reportar objeto perdido' })}</span>
                        <span aria-hidden="true" style={{ color: 'var(--text-tertiary)' }}>›</span>
                      </Link>
                    )}
                  </div>
                </div>
              )}

            </div>
          );
        })()}
      </div>
    </main>
  );
}
