'use client';

// ============================================================
// TriciGo Admin — /admin/partners — Partner places (fare discounts)
//
// An admin configures a business with coordinates and a discount percentage;
// any ride ENDING inside its radius costs the passenger that much less, and
// they see the reduced price before confirming.
//
// TriciGo absorbs the discount out of its own commission — the driver is paid
// on the full fare. The percentage is capped at the ride's effective commission
// when applied (00559), so the platform gives up commission but never puts in
// money of its own. That is why the form does not need to police the number
// beyond 1–100: a place set to 80% simply behaves as if it were set to the
// commission.
//
// Before 00558 the business absorbed the perk and handed it over as a coupon at
// the counter. That model, its secret validation link and its redemption
// counters are gone.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Gift, Plus, X } from 'lucide-react';
import { partnerPlaceService, walletService, TRICIGO_CATEGORIES } from '@tricigo/api';
import type { AdminPartnerPlace, AdminPartnerPlaceInput } from '@tricigo/api';
import { getErrorMessage, reverseGeocodeStructured } from '@tricigo/utils';
import AdminAddressSearch from '@/components/AdminAddressSearch';
import PartnerPhotoInput from '@/components/PartnerPhotoInput';
import { useToast } from '@/components/ui/AdminToast';
import { DataTable, type DataColumn } from '@/components/data/DataTable';
import { formatAdminDate } from '@/lib/formatDate';

// Leaflet touches `window`; the admin already loads its maps this way
// (see /live-map). Do not swap in mapbox-gl here.
const PlacePicker = dynamic(() => import('@/components/PartnerPlacePicker'), { ssr: false });

const INPUT_CLS =
  'mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink';

const emptyForm: AdminPartnerPlaceInput = {
  id: null,
  name: '',
  category: 'cafe',
  latitude: 23.1136,     // central Havana
  longitude: -82.3666,
  discount_percent: 10,
  tagline: '',
  photo_url: '',
  address: '',
  municipality: '',
  province: '',
  phone: '',
  hours: '',
  radius_m: 80,
  is_active: true,
  valid_until: null,
};

export default function PartnersPage() {
  const { showToast } = useToast();
  const [rows, setRows] = useState<AdminPartnerPlace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<AdminPartnerPlaceInput>({ ...emptyForm });
  const [saving, setSaving] = useState(false);
  // Read, never hardcoded: the cap follows platform_config.commission_rate, so
  // a hardcoded "15%" here would start lying the day that value changes.
  const [commissionPct, setCommissionPct] = useState<number | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [recenterKey, setRecenterKey] = useState(0);

  /**
   * Fill address / municipality / province from wherever the pin landed.
   *
   * Best effort by design: it never blocks and never clears. If the reverse
   * lookup fails the fields stay exactly as they were and remain editable.
   */
  const fillFromPin = useCallback(async (lat: number, lng: number) => {
    try {
      const s = await reverseGeocodeStructured(lat, lng);
      if (!s) return;
      // `street` comes back EMPTY when the pin lands on a known place — the
      // name is in `poiName` then. Using street alone would blank the address
      // in the most common case for a partner business, which IS a POI.
      const line = [s.poiName, s.street].filter(Boolean).join(', ');
      setForm((f) => ({
        ...f,
        address: line || f.address,
        municipality: s.municipality || f.municipality,
        province: s.province || f.province,
      }));
    } catch {
      /* the admin can still type it */
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await partnerPlaceService.adminList());
    } catch (err) {
      setRows([]);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    // Best effort: if it fails we just omit the hint, never block the form.
    walletService.getConfigValue('commission_rate')
      .then((v) => { const n = Number(v); if (Number.isFinite(n) && n > 0 && n < 1) setCommissionPct(n * 100); })
      .catch(() => { /* hint is optional */ });
  }, []);

  const openEdit = (p: AdminPartnerPlace) => {
    setForm({
      id: p.id, name: p.name, category: p.category,
      latitude: p.latitude, longitude: p.longitude,
      discount_percent: p.discount_percent, tagline: p.tagline ?? '',
      photo_url: p.photo_url ?? '', address: p.address ?? '',
      municipality: p.municipality ?? '', province: p.province ?? '',
      phone: p.phone ?? '', hours: p.hours ?? '',
      radius_m: p.radius_m, is_active: p.is_active,
      valid_until: p.valid_until,
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) { showToast('error', 'El nombre es obligatorio.'); return; }
    if (!(form.discount_percent > 0) || form.discount_percent > 100) {
      showToast('error', 'El descuento debe estar entre 1 y 100.');
      return;
    }
    setSaving(true);
    try {
      await partnerPlaceService.adminUpsert(form);
      showToast('success', 'Lugar guardado.');
      setShowForm(false);
      setForm({ ...emptyForm });
      await load();
    } catch (err) {
      showToast('error', getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const columns: DataColumn<AdminPartnerPlace>[] = [
    { id: 'name', header: 'Lugar', primary: true,
      cell: (p) => <span className="font-medium text-ink">{p.name}</span> },
    { id: 'municipality', header: 'Municipio', hideBelow: 'md',
      cell: (p) => p.municipality ?? <span className="text-ink-subtle">—</span> },
    { id: 'discount', header: 'Descuento', width: '120px',
      cell: (p) => (
        <span className="font-medium tabular-nums text-orange-600">
          {Math.round(p.discount_percent)}%
        </span>
      ) },
    // What the deal actually costs. Rides tell you whether it draws anyone;
    // the CUP column tells you what that traffic is being paid for. A place
    // with many rides and little given up is a good deal; the reverse is one
    // to renegotiate.
    { id: 'usage', header: 'Viajes / CUP resignados', width: '200px',
      cell: (p) => (
        <span className="tabular-nums">
          {p.rides_count}
          <span className="ml-2 text-ink-subtle">
            {p.rides_count > 0 ? `${p.discount_given_cup.toLocaleString('es-CU')} CUP` : '—'}
          </span>
        </span>
      ) },
    { id: 'status', header: 'Estado', width: '110px',
      cell: (p) => (
        <span className={p.is_active ? 'text-emerald-700 dark:text-emerald-400' : 'text-ink-subtle'}>
          {p.is_active ? 'Activo' : 'Inactivo'}
        </span>
      ) },
    { id: 'created_at', header: 'Creado', hideBelow: 'lg',
      cell: (p) => <span className="text-xs text-ink-subtle">{formatAdminDate(p.created_at)}</span> },
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="inline-flex items-center gap-2 text-2xl font-bold text-ink">
            <Gift className="h-5 w-5 text-orange-500" /> Lugares aliados
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Terminar un viaje aquí le descuenta la tarifa al pasajero. Lo absorbe
            TriciGo de su comisión{commissionPct !== null ? ` (${commissionPct}%)` : ''}: el
            conductor cobra igual que siempre y la plataforma nunca pone dinero propio.
          </p>
        </div>
        <button
          onClick={() => { setForm({ ...emptyForm }); setShowForm(true); }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600"
        >
          <Plus className="h-4 w-4" /> Nuevo lugar
        </button>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        keyField="id"
        loading={loading}
        error={error}
        onRetry={() => { void load(); }}
        onRowClick={openEdit}
        empty={{
          icon: Gift,
          title: 'Sin lugares aliados',
          body: 'Todavía no hay ninguno. Crea el primero para que los viajes que terminen ahí salgan más baratos.',
        }}
      />

      {showForm && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4">
          <div className="admin-card mx-auto max-w-2xl space-y-4 p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-ink">{form.id ? 'Editar lugar' : 'Nuevo lugar'}</h2>
              <button onClick={() => setShowForm(false)} aria-label="Cerrar" className="rounded p-1 hover:bg-surface-sunken">
                <X className="h-5 w-5" />
              </button>
            </div>

            <AdminAddressSearch
              proximity={{ latitude: form.latitude, longitude: form.longitude }}
              inputClassName={INPUT_CLS}
              onSelect={(r) => {
                setForm((f) => ({
                  ...f,
                  latitude: r.latitude,
                  longitude: r.longitude,
                  address: r.address || f.address,
                }));
                // Only the search recentres the map. A map click must not, or it
                // would fight the admin's panning.
                setRecenterKey((k) => k + 1);
                void fillFromPin(r.latitude, r.longitude);
              }}
            />

            <PlacePicker
              latitude={form.latitude}
              longitude={form.longitude}
              radiusM={form.radius_m}
              recenterKey={recenterKey}
              onChange={(lat, lng) => {
                setForm((f) => ({ ...f, latitude: lat, longitude: lng }));
                void fillFromPin(lat, lng);
              }}
            />
            <p className="text-xs text-ink-subtle">
              Busca el negocio arriba, o toca el mapa para ubicarlo a mano — la dirección
              se completa sola. El círculo es el radio real: un viaje que termine dentro
              se lleva el descuento.
            </p>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="text-sm text-ink">Nombre
                <input className={INPUT_CLS} value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </label>
              <label className="text-sm text-ink">Categoría
                <select className={INPUT_CLS} value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}>
                  {TRICIGO_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="text-sm text-ink">Descuento (%)
                <input type="number" min={1} max={100} className={INPUT_CLS}
                  value={form.discount_percent}
                  onChange={(e) => setForm({ ...form, discount_percent: Number(e.target.value) })} />
                <span className="mt-1 block text-xs text-ink-subtle">
                  {commissionPct !== null
                    ? `Se topea en la comisión del viaje (${commissionPct}%). Poner más no cuesta más: simplemente se aplica el tope.`
                    : 'Se topea en la comisión del viaje. Poner más no cuesta más: simplemente se aplica el tope.'}
                </span>
              </label>
              <label className="text-sm text-ink">Descripción corta (opcional)
                <input className={INPUT_CLS} placeholder="Panadería artesanal"
                  value={form.tagline ?? ''}
                  onChange={(e) => setForm({ ...form, tagline: e.target.value })} />
              </label>
              <div className="sm:col-span-2">
                <PartnerPhotoInput
                  value={form.photo_url ?? ''}
                  placeId={form.id}
                  inputClassName={INPUT_CLS}
                  onChange={(url) => setForm((f) => ({ ...f, photo_url: url }))}
                  onUploadingChange={setUploadingPhoto}
                />
              </div>
              <label className="text-sm text-ink">Dirección
                <input className={INPUT_CLS} value={form.address ?? ''}
                  onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </label>
              <label className="text-sm text-ink">Municipio
                <input className={INPUT_CLS} value={form.municipality ?? ''}
                  onChange={(e) => setForm({ ...form, municipality: e.target.value })} />
              </label>
              <label className="text-sm text-ink">Provincia
                <input className={INPUT_CLS} value={form.province ?? ''}
                  onChange={(e) => setForm({ ...form, province: e.target.value })} />
              </label>
              <label className="text-sm text-ink">Teléfono
                <input className={INPUT_CLS} value={form.phone ?? ''}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </label>
              <label className="text-sm text-ink sm:col-span-2">Horario
                <input className={INPUT_CLS} placeholder="Lun-Sáb 7:00-19:00"
                  value={form.hours ?? ''}
                  onChange={(e) => setForm({ ...form, hours: e.target.value })} />
              </label>
              <label className="text-sm text-ink">Radio (m)
                <input type="number" className={INPUT_CLS} value={form.radius_m}
                  onChange={(e) => setForm({ ...form, radius_m: Number(e.target.value) })} />
              </label>
              <label className="text-sm text-ink">Fin del acuerdo (opcional)
                <input type="date" className={INPUT_CLS}
                  value={form.valid_until ? form.valid_until.slice(0, 10) : ''}
                  onChange={(e) => setForm({ ...form, valid_until: e.target.value ? `${e.target.value}T23:59:59Z` : null })} />
              </label>
              <label className="flex items-center gap-2 text-sm text-ink sm:col-span-2">
                <input type="checkbox" checked={form.is_active}
                  onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
                Activo
              </label>
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={() => setShowForm(false)} className="rounded-lg border border-line px-4 py-2 text-sm text-ink">
                Cancelar
              </button>
              {/* Blocked while the photo uploads: saving first would persist an
                  empty photo_url and the admin would think the photo was lost. */}
              <button onClick={handleSave} disabled={saving || uploadingPhoto}
                className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50">
                {saving ? 'Guardando…' : uploadingPhoto ? 'Subiendo la foto…' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
