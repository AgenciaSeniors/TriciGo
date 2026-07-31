'use client';

// ============================================================
// TriciGo Admin — /admin/partners — Partner places (arrival coupons)
//
// An admin configures a business with coordinates and a negotiated perk; any
// ride ending inside its radius issues the passenger a single-use coupon.
// The business absorbs the perk, so nothing here touches wallets or the
// ledger. See docs/superpowers/specs/2026-07-31-partner-places-discounts-design.md
//
// Reads go through admin_list_partner_places (00533) rather than the table:
// 00529 revoked SELECT on partner_places.validation_token from `authenticated`
// so a logged-in passenger cannot harvest every business's secret link. The
// SECURITY DEFINER RPC resolves privileges against its owner, which is how the
// admin still sees the token.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Gift, Plus, X } from 'lucide-react';
import { partnerPlaceService, TRICIGO_CATEGORIES } from '@tricigo/api';
import type { AdminPartnerPlace, AdminPartnerPlaceInput } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
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
  benefit_title: '',
  benefit_description: '',
  terms: '',
  photo_url: '',
  address: '',
  municipality: '',
  province: '',
  phone: '',
  hours: '',
  radius_m: 80,
  coupon_ttl_minutes: 120,
  cooldown_days: 0,      // 0 = unlimited, the shipped default
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

  const openEdit = (p: AdminPartnerPlace) => {
    setForm({
      id: p.id, name: p.name, category: p.category,
      latitude: p.latitude, longitude: p.longitude,
      benefit_title: p.benefit_title, benefit_description: p.benefit_description,
      terms: p.terms ?? '', photo_url: p.photo_url ?? '', address: p.address ?? '',
      municipality: p.municipality ?? '', province: p.province ?? '',
      phone: p.phone ?? '', hours: p.hours ?? '',
      radius_m: p.radius_m, coupon_ttl_minutes: p.coupon_ttl_minutes,
      cooldown_days: p.cooldown_days, is_active: p.is_active,
      valid_until: p.valid_until,
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name.trim())                { showToast('error', 'El nombre es obligatorio.'); return; }
    if (!form.benefit_title.trim())       { showToast('error', 'El título del beneficio es obligatorio.'); return; }
    if (!form.benefit_description.trim()) { showToast('error', 'La descripción del beneficio es obligatoria.'); return; }
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

  // Click-to-copy, never a plain <a>. Opening the link from here would spend a
  // validation attempt against that business's own rate-limit budget (00531).
  const copyLink = async (token: string) => {
    const url = `https://tricigo.com/v/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('success', 'Enlace copiado.');
    } catch {
      // Clipboard access can be refused outright (insecure context, denied
      // permission). Say so — a silent no-op reads as a copy that worked.
      showToast('error', `No pudimos copiar el enlace. Cópialo a mano: ${url}`);
    }
  };

  const columns: DataColumn<AdminPartnerPlace>[] = [
    { id: 'name', header: 'Lugar', primary: true,
      cell: (p) => <span className="font-medium text-ink">{p.name}</span> },
    { id: 'municipality', header: 'Municipio', hideBelow: 'md',
      cell: (p) => p.municipality ?? <span className="text-ink-subtle">—</span> },
    { id: 'benefit', header: 'Beneficio',
      cell: (p) => <span className="font-medium text-orange-600">{p.benefit_title}</span> },
    // The health of the agreement. 200 issued against 12 redeemed means the
    // perk interests nobody and the deal needs renegotiating — surface it.
    { id: 'usage', header: 'Emitidos / canjeados', width: '190px',
      cell: (p) => {
        const pct = p.issued_count > 0
          ? Math.round((p.redeemed_count / p.issued_count) * 100) : 0;
        return (
          <span className="tabular-nums">
            {p.issued_count} / {p.redeemed_count}
            <span className="ml-2 text-ink-subtle">{p.issued_count > 0 ? `${pct}%` : '—'}</span>
            {p.redeemed_count > p.redeemed_by_business_count && (
              <span className="ml-2 text-[10px] text-ink-subtle">
                ({p.redeemed_by_business_count} verif.)
              </span>
            )}
          </span>
        );
      } },
    { id: 'status', header: 'Estado', width: '110px',
      cell: (p) => (
        <span className={p.is_active ? 'text-emerald-700 dark:text-emerald-400' : 'text-ink-subtle'}>
          {p.is_active ? 'Activo' : 'Inactivo'}
        </span>
      ) },
    // The secret link you hand the business when the deal is signed. It is the
    // identity the rate limiter counts against and the reason a bakery's coupon
    // cannot be redeemed at a café — so it has to be easy to copy and hard to
    // mistype.
    { id: 'link', header: 'Enlace del negocio', width: '230px',
      cell: (p) => (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); void copyLink(p.validation_token); }}
          className="font-mono text-xs text-ink-subtle hover:text-ink"
          title="Copiar el enlace"
        >
          /v/{p.validation_token}
        </button>
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
            El negocio absorbe el beneficio. Nada de esto toca billeteras ni saldo.
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
          body: 'Todavía no hay ninguno. Crea el primero para empezar a emitir cupones al llegar.',
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

            <PlacePicker
              latitude={form.latitude}
              longitude={form.longitude}
              radiusM={form.radius_m}
              onChange={(lat, lng) => setForm((f) => ({ ...f, latitude: lat, longitude: lng }))}
            />
            <p className="text-xs text-ink-subtle">
              Toca el mapa para ubicar el negocio. El círculo es el radio real que dispara el cupón.
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
              <label className="text-sm text-ink sm:col-span-2">Título del beneficio (corto — va en la píldora naranja)
                <input className={INPUT_CLS} placeholder="Café gratis"
                  value={form.benefit_title}
                  onChange={(e) => setForm({ ...form, benefit_title: e.target.value })} />
              </label>
              <label className="text-sm text-ink sm:col-span-2">Descripción del beneficio
                <input className={INPUT_CLS}
                  placeholder="Un café con tu compra, solo por llegar en TriciGo"
                  value={form.benefit_description}
                  onChange={(e) => setForm({ ...form, benefit_description: e.target.value })} />
              </label>
              <label className="text-sm text-ink sm:col-span-2">Letra chica (opcional)
                <input className={INPUT_CLS}
                  placeholder="No acumulable, hasta agotar existencias"
                  value={form.terms ?? ''}
                  onChange={(e) => setForm({ ...form, terms: e.target.value })} />
              </label>
              <label className="text-sm text-ink sm:col-span-2">URL de la foto
                <input className={INPUT_CLS} value={form.photo_url ?? ''}
                  onChange={(e) => setForm({ ...form, photo_url: e.target.value })} />
              </label>
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
              <label className="text-sm text-ink">Duración del cupón (min)
                <input type="number" className={INPUT_CLS} value={form.coupon_ttl_minutes}
                  onChange={(e) => setForm({ ...form, coupon_ttl_minutes: Number(e.target.value) })} />
              </label>
              <label className="text-sm text-ink">Espera entre cupones (días — 0 = sin límite)
                <input type="number" className={INPUT_CLS} value={form.cooldown_days}
                  onChange={(e) => setForm({ ...form, cooldown_days: Number(e.target.value) })} />
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
              <button onClick={handleSave} disabled={saving}
                className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50">
                {saving ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
