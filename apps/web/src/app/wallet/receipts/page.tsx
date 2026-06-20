'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { walletService, getSupabaseClient } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { WebSkeletonList } from '@/components/WebSkeleton';
import { WebEmptyState } from '@/components/WebEmptyState';

// RECARGA V2 — Receipts history.
//
// Lists every wallet_receipts row for the signed-in user with a
// "Descargar PDF" button per row. The PDF lives in the private
// `receipts/<user_id>/<TG-...>.pdf` storage bucket; we mint a signed
// URL on click (1h TTL) so the download token is short-lived and not
// exposed in the rendered HTML.
//
// RLS on wallet_receipts already restricts SELECT to user_id =
// auth.uid(); the auth check below is for UX (redirect to /login)
// not security.

interface ReceiptRow {
  id: string;
  payment_intent_id: string;
  receipt_no: string;
  pdf_storage_path: string | null;
  pdf_generated_at: string | null;
  usd_charged: string;
  tc_credited: string;
  created_at: string;
}

function formatTcInt(raw: string): string {
  // Stored as numeric(10,2); we want the integer CUP equivalent.
  // 10500.00 → "10.500"
  const n = Math.round(Number(raw));
  return n.toLocaleString('es-CU');
}

function formatUsd(raw: string): string {
  // Stored as numeric(10,2); just trim and prefix.
  const n = Number(raw);
  return `$${n.toFixed(2)} USD`;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat('es-CU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/Havana',
    }).format(d);
  } catch {
    return iso;
  }
}

export default function ReceiptsPage() {
  const { t } = useTranslation('web');
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // ── Auth gate (RLS would block the query anyway; this is for UX) ──
  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!userId) {
      router.replace('/login');
      return;
    }

    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await walletService.getReceipts(userId, 100);
        if (!cancelled) setReceipts(data);
      } catch (err) {
        console.error('Failed to load receipts:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userId, authLoading, router]);

  const handleDownload = useCallback(async (row: ReceiptRow) => {
    if (!row.pdf_storage_path) {
      setDownloadError(t('receipts.error_not_ready', { defaultValue: 'El PDF aún no está disponible. Esperá unos segundos y volvé a intentar.' }));
      return;
    }
    setDownloadingId(row.id);
    setDownloadError(null);
    try {
      const signedUrl = await walletService.getReceiptSignedUrl(row.pdf_storage_path, 3600);
      // Open in a new tab so the user keeps the receipts list in view.
      // The signed URL itself triggers the browser's PDF viewer or
      // download flow depending on the user's settings.
      window.open(signedUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : t('receipts.error_download', { defaultValue: 'No se pudo generar la URL de descarga.' }));
    } finally {
      setDownloadingId(null);
    }
  }, [t]);

  if (authLoading || !userId) {
    return (
      <main className="page-main">
        <div className="page-container">
          <p style={{ color: 'var(--text-tertiary)' }}>{t('receipts.loading', { defaultValue: 'Cargando…' })}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="page-main">
      <div className="page-container">
        <Link
          href="/wallet"
          aria-label={t('receipts.back_credits_aria', { defaultValue: 'Volver a mis créditos' })}
          style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: '0.875rem' }}
        >
          {t('receipts.back_credits', { defaultValue: '← Mis créditos' })}
        </Link>

        <h1
          style={{
            fontSize: 'clamp(1.5rem, 4vw, 2rem)',
            fontWeight: 800,
            marginTop: '1rem',
            marginBottom: '0.25rem',
          }}
        >
          {t('receipts.title', { defaultValue: 'Comprobantes de recarga' })}
        </h1>
        <p
          style={{
            fontSize: '0.875rem',
            color: 'var(--text-secondary)',
            margin: '0 0 1.5rem',
          }}
        >
          {t('receipts.subtitle', { defaultValue: 'Cada recarga genera un PDF con el detalle del cargo y los TriciCoin acreditados. Conservalos para tus registros.' })}
        </p>

        {downloadError && (
          <div
            role="alert"
            style={{
              padding: '0.65rem 0.85rem',
              background: 'rgba(220, 38, 38, 0.08)',
              border: '1px solid rgba(220, 38, 38, 0.25)',
              borderRadius: 'var(--radius-md)',
              color: '#dc2626',
              fontSize: '0.8rem',
              marginBottom: '1rem',
            }}
          >
            {downloadError}
          </div>
        )}

        {loading && <WebSkeletonList count={4} />}

        {!loading && receipts.length === 0 && (
          <WebEmptyState
            icon="📄"
            title={t('receipts.empty_title', { defaultValue: 'Sin comprobantes todavía' })}
            description={t('receipts.empty_description', { defaultValue: 'Cuando hagas una recarga vas a poder descargar el PDF acá.' })}
            action={{ label: t('receipts.go_recharge', { defaultValue: 'Ir a recargar' }), href: '/wallet' }}
          />
        )}

        {!loading && receipts.length > 0 && (
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: '0.65rem',
            }}
          >
            {receipts.map((row) => {
              const ready = !!row.pdf_storage_path;
              const isDownloading = downloadingId === row.id;
              return (
                <li
                  key={row.id}
                  style={{
                    padding: '1rem',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-light)',
                    background: 'var(--bg-card)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.75rem',
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ minWidth: 0, flex: '1 1 240px' }}>
                    <p
                      style={{
                        fontSize: '0.95rem',
                        fontWeight: 700,
                        margin: '0 0 0.2rem',
                        color: 'var(--text-primary)',
                      }}
                    >
                      {row.receipt_no}
                    </p>
                    <p
                      style={{
                        fontSize: '0.75rem',
                        color: 'var(--text-tertiary)',
                        margin: 0,
                      }}
                    >
                      {formatDate(row.created_at)}
                    </p>
                    <p
                      style={{
                        fontSize: '0.8rem',
                        color: 'var(--text-secondary)',
                        margin: '0.35rem 0 0',
                      }}
                    >
                      {t('receipts.charge_summary', { usd: formatUsd(row.usd_charged), tc: formatTcInt(row.tc_credited), defaultValue: 'Cargo {{usd}} · {{tc}} TriciCoin acreditados' })}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDownload(row)}
                    disabled={!ready || isDownloading}
                    aria-label={t('receipts.download_aria', { receipt: row.receipt_no, defaultValue: 'Descargar PDF del comprobante {{receipt}}' })}
                    className="btn-base btn-secondary-outline"
                    style={{
                      cursor: !ready || isDownloading ? 'not-allowed' : 'pointer',
                      opacity: !ready || isDownloading ? 0.6 : 1,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {isDownloading
                      ? t('receipts.downloading', { defaultValue: 'Preparando…' })
                      : ready
                        ? t('receipts.download', { defaultValue: 'Descargar PDF' })
                        : t('receipts.pdf_in_process', { defaultValue: 'PDF en proceso' })}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
