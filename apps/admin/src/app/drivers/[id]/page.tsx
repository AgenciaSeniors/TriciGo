'use client';

import { useEffect, useState, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { adminService, reviewService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { useToast } from '@/components/ui/AdminToast';
import { AdjustWalletModal, type WalletAccountType } from '@/components/ui/AdjustWalletModal';
import { formatCUP } from '@tricigo/utils';
import type {
  DriverProfile,
  DriverDocument,
  DriverScoreEvent,
  Vehicle,
  DriverStatus,
  SelfieCheck,
  ReviewTagSummaryItem,
} from '@tricigo/types';
import { useAdminUser } from '@/lib/useAdminUser';
import { formatAdminDate } from '@/lib/formatDate';
import {
  ArrowLeft,
  FileText,
  Car,
  Bike,
  Package,
  Star,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  MoreVertical,
  ExternalLink,
  Shield,
  TrendingUp,
  TrendingDown,
  Phone,
  Mail,
  MapPin,
  Calendar,
} from 'lucide-react';

type DriverDetail = {
  profile: DriverProfile & { users: { full_name: string; phone: string; email: string | null } };
  vehicle: Vehicle | null;
  documents: DriverDocument[];
  scoreEvents: DriverScoreEvent[];
};

// ─── Status visual tokens ─────────────────────────────────────
const STATUS_STYLES: Record<DriverStatus, { dot: string; text: string; bg: string; gradient: string }> = {
  pending_verification: { dot: 'bg-yellow-500', text: 'text-yellow-700', bg: 'bg-yellow-50', gradient: 'from-yellow-400 to-amber-600' },
  under_review:         { dot: 'bg-blue-500',   text: 'text-blue-700',   bg: 'bg-blue-50',   gradient: 'from-blue-400 to-blue-600' },
  approved:             { dot: 'bg-green-500',  text: 'text-green-700',  bg: 'bg-green-50',  gradient: 'from-green-400 to-emerald-600' },
  rejected:             { dot: 'bg-red-500',    text: 'text-red-700',    bg: 'bg-red-50',    gradient: 'from-red-400 to-rose-600' },
  suspended:            { dot: 'bg-orange-500', text: 'text-orange-700', bg: 'bg-orange-50', gradient: 'from-orange-400 to-orange-600' },
};

const STATUS_LABEL_KEY: Record<DriverStatus, string> = {
  pending_verification: 'drivers.status_pending',
  under_review: 'drivers.status_in_review',
  approved: 'drivers.status_approved',
  rejected: 'drivers.status_rejected',
  suspended: 'drivers.status_suspended',
};

const VEHICLE_TYPE_KEY: Record<string, string> = {
  triciclo: 'drivers.type_triciclo',
  moto: 'drivers.type_moto',
  auto: 'drivers.type_auto',
};

const DOC_TYPE_KEY: Record<string, string> = {
  national_id: 'drivers.doc_ci',
  drivers_license: 'drivers.doc_license',
  vehicle_registration: 'drivers.doc_registration',
  selfie: 'drivers.doc_selfie',
  vehicle_photo: 'drivers.doc_vehicle_photo',
};

function getInitials(name?: string | null): string {
  if (!name) return '?';
  return name.split(' ').filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase() ?? '').join('');
}

function vehicleIcon(type?: string) {
  switch (type) {
    case 'auto': return Car;
    case 'moto': case 'triciclo': return Bike;
    default: return Package;
  }
}

export default function DriverDetailPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const { userId: adminUserId } = useAdminUser();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  // ─── State ─────────────────────────────────────────────────
  const [driver, setDriver] = useState<DriverDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [showReasonModal, setShowReasonModal] = useState<'reject' | 'suspend' | null>(null);
  const [reason, setReason] = useState('');
  const [docUrls, setDocUrls] = useState<Record<string, string>>({});
  const [selfieChecks, setSelfieChecks] = useState<SelfieCheck[]>([]);
  const [verifyingDoc, setVerifyingDoc] = useState<string | null>(null);
  const [churnRisk, setChurnRisk] = useState<{ churn_risk_score: number; risk_level: string; days_since_last_ride: number; earnings_this_week: number } | null>(null);
  const [docNotes, setDocNotes] = useState<Record<string, string>>({});
  const [topTags, setTopTags] = useState<ReviewTagSummaryItem[]>([]);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [walletAdjusting, setWalletAdjusting] = useState(false);
  const [graceTripsModalOpen, setGraceTripsModalOpen] = useState(false);
  const [graceTripsCount, setGraceTripsCount] = useState('5');
  const [graceTripsReason, setGraceTripsReason] = useState('');
  const [graceTripsSubmitting, setGraceTripsSubmitting] = useState(false);
  const [showAllEvents, setShowAllEvents] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement>(null);

  // ─── Data loading ──────────────────────────────────────────
  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    (async () => {
      try {
        const [data, checks, reviewSummary] = await Promise.all([
          adminService.getDriverDetail(id),
          adminService.getDriverSelfieChecks(id).catch(() => [] as SelfieCheck[]),
          reviewService.getReviewSummary(id).catch(() => null),
        ]);
        if (!cancelled) {
          setDriver(data);
          setSelfieChecks(checks);
          if (reviewSummary?.top_tags) setTopTags(reviewSummary.top_tags);
          adminService.getDriverChurnRisk(id).then((risk) => {
            if (!cancelled && risk) setChurnRisk(risk);
          }).catch(() => {});
        }
      } catch (err) {
        if (!cancelled) setApiError(err instanceof Error ? err.message : 'Error al cargar datos del conductor');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [id]);

  // Load signed URLs for documents
  useEffect(() => {
    if (!driver?.documents.length) return;
    driver.documents.forEach(async (doc) => {
      try {
        const url = await adminService.getDocumentUrl(doc.storage_path);
        if (!url) {
          setDocUrls((prev) => ({ ...prev, [doc.id]: '__error__' }));
          return;
        }
        setDocUrls((prev) => ({ ...prev, [doc.id]: url }));
      } catch {
        setDocUrls((prev) => ({ ...prev, [doc.id]: '__error__' }));
      }
    });
  }, [driver?.documents]);

  // Close actions menu on outside click
  useEffect(() => {
    if (!actionsMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target as Node)) {
        setActionsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [actionsMenuOpen]);

  // Close modal on ESC
  useEffect(() => {
    if (!showReasonModal) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setShowReasonModal(null); setReason(''); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [showReasonModal]);

  // ─── Handlers ──────────────────────────────────────────────
  const refreshDriver = async () => {
    if (!id) return;
    const [data, checks] = await Promise.all([
      adminService.getDriverDetail(id),
      adminService.getDriverSelfieChecks(id).catch(() => [] as SelfieCheck[]),
    ]);
    setDriver(data);
    setSelfieChecks(checks);
  };

  const handleVerifyDoc = async (documentId: string, isVerified: boolean) => {
    setVerifyingDoc(documentId);
    try {
      await adminService.verifyDocument(documentId, adminUserId, isVerified, docNotes[documentId] || undefined);
      setDocNotes((prev) => ({ ...prev, [documentId]: '' }));
      await refreshDriver();
      showToast('success', isVerified
        ? t('drivers.doc_verified', { defaultValue: 'Documento verificado' })
        : t('drivers.doc_rejected', { defaultValue: 'Documento rechazado' })
      );
    } finally {
      setVerifyingDoc(null);
    }
  };

  const handleAdjustDriverQuota = async (args: { accountType: WalletAccountType; amountCup: number; reason: string }) => {
    if (!profile?.user_id) return;
    setWalletAdjusting(true);
    try {
      const result = await adminService.adjustWallet(profile.user_id, args.accountType, args.amountCup, args.reason);
      showToast('success', t('admin_ops.adjust_success', {
        defaultValue: `Saldo ajustado. Nuevo balance: ${result.new_balance.toLocaleString()} CUP`,
      }));
      setWalletModalOpen(false);
      await refreshDriver();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('admin_ops.adjust_error', { defaultValue: 'No pudimos ajustar el saldo' }));
    } finally {
      setWalletAdjusting(false);
    }
  };

  const handleGrantGraceTrips = async () => {
    if (!profile?.user_id) return;
    const trips = parseInt(graceTripsCount, 10);
    if (isNaN(trips) || trips === 0) {
      showToast('error', t('admin_ops.grace_invalid', { defaultValue: 'Cantidad de viajes inválida' }));
      return;
    }
    if (graceTripsReason.trim().length < 3) {
      showToast('error', t('admin_ops.grace_reason_required', { defaultValue: 'Razón obligatoria (mín. 3 caracteres)' }));
      return;
    }
    setGraceTripsSubmitting(true);
    try {
      const result = await adminService.grantGraceTrips(profile.user_id, trips, graceTripsReason.trim());
      showToast('success', t('admin_ops.grace_success', {
        defaultValue: `+${result.trips_added} viajes de gracia. Total actual: ${result.new_total}`,
      }));
      setGraceTripsModalOpen(false);
      setGraceTripsCount('5');
      setGraceTripsReason('');
      await refreshDriver();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('admin_ops.grace_error', { defaultValue: 'No pudimos otorgar los viajes' }));
    } finally {
      setGraceTripsSubmitting(false);
    }
  };

  const handleApprove = async () => {
    if (!id) return;
    setActionLoading(true);
    setActionsMenuOpen(false);
    try {
      await adminService.approveDriver(id, adminUserId);
      await refreshDriver();
      showToast('success', t('drivers.approved_success', { defaultValue: 'Conductor aprobado' }));
    } finally {
      setActionLoading(false);
    }
  };

  const handleRejectOrSuspend = async () => {
    if (!id || !reason.trim() || !showReasonModal) return;
    setActionLoading(true);
    try {
      if (showReasonModal === 'reject') {
        await adminService.rejectDriver(id, adminUserId, reason);
      } else {
        await adminService.suspendDriver(id, adminUserId, reason);
      }
      await refreshDriver();
      setShowReasonModal(null);
      setReason('');
      showToast('success', showReasonModal === 'reject'
        ? t('drivers.rejected_success', { defaultValue: 'Conductor rechazado' })
        : t('drivers.suspended_success', { defaultValue: 'Conductor suspendido' })
      );
    } finally {
      setActionLoading(false);
    }
  };

  // ─── Loading / error states ────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="flex items-center gap-2 text-ink-subtle">
          <Clock size={16} className="animate-spin" />
          {t('common.loading', { defaultValue: 'Cargando...' })}
        </div>
      </div>
    );
  }

  if (!driver) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3">
        <AlertTriangle size={32} className="text-ink-subtle" />
        <p className="text-sm text-ink-muted">
          {apiError
            ? t('drivers.error_loading', { defaultValue: 'Error al cargar datos del conductor' })
            : t('drivers.driver_not_found', { defaultValue: 'Conductor no encontrado' })}
        </p>
        <button
          onClick={() => router.push('/drivers')}
          className="text-sm text-primary-500 hover:text-primary-600"
        >
          {t('common.back', { defaultValue: 'Volver' })}
        </button>
      </div>
    );
  }

  const { profile, vehicle, documents, scoreEvents } = driver;
  const status = profile.status as DriverStatus;
  const statusStyle = STATUS_STYLES[status];
  const verifiedDocsCount = documents.filter((d) => d.is_verified).length;
  const totalDocsCount = documents.length;
  const allDocsVerified = totalDocsCount >= 5 && verifiedDocsCount === totalDocsCount;
  const VIcon = vehicleIcon(vehicle?.type);

  return (
    <div className="pb-16">
      {/* ─── Top header ──────────────────────────────────── */}
      <header className="mb-6">
        <button
          onClick={() => router.push('/drivers')}
          className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink transition-colors mb-3"
        >
          <ArrowLeft size={14} />
          {t('drivers.back_to_list', { defaultValue: 'Conductores' })}
        </button>

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className={`w-14 h-14 rounded-full bg-gradient-to-br ${statusStyle.gradient} flex items-center justify-center text-white text-lg font-semibold shrink-0`}>
              {getInitials(profile.users.full_name)}
            </div>
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-2xl font-semibold tracking-tight text-ink">
                  {profile.users.full_name || '—'}
                </h1>
                <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${statusStyle.bg} ${statusStyle.text}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${statusStyle.dot}`} />
                  {t(STATUS_LABEL_KEY[status])}
                </div>
              </div>
              <p className="text-sm text-ink-muted mt-1 flex items-center gap-1.5 flex-wrap">
                <Phone size={12} />
                {profile.users.phone}
                {profile.users.email && <>
                  <span className="text-ink-subtle">·</span>
                  <Mail size={12} />
                  {profile.users.email}
                </>}
                <span className="text-ink-subtle">·</span>
                <Calendar size={12} />
                {formatAdminDate(profile.created_at)}
              </p>
            </div>
          </div>

          {/* Actions menu */}
          <div className="relative" ref={actionsMenuRef}>
            <button
              onClick={() => setActionsMenuOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-line bg-surface-elevated text-sm font-medium text-ink hover:bg-surface-sunken transition-colors"
            >
              {t('drivers.actions', { defaultValue: 'Acciones' })}
              <MoreVertical size={14} />
            </button>
            {actionsMenuOpen && (
              <div className="absolute right-0 mt-1 w-56 rounded-lg border border-line bg-surface-elevated shadow-lg overflow-hidden z-20">
                {(status === 'under_review' || status === 'pending_verification' || status === 'rejected' || status === 'suspended') && (
                  <button
                    onClick={handleApprove}
                    disabled={actionLoading || !allDocsVerified}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-green-700 hover:bg-green-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-left"
                    title={!allDocsVerified ? `Debe verificar los documentos (${verifiedDocsCount}/${totalDocsCount})` : ''}
                  >
                    <CheckCircle2 size={14} />
                    {t('drivers.action_approve', { defaultValue: 'Aprobar conductor' })}
                    {!allDocsVerified && <span className="ml-auto text-xs text-ink-subtle">{verifiedDocsCount}/{totalDocsCount}</span>}
                  </button>
                )}
                {(status === 'under_review' || status === 'pending_verification') && (
                  <button
                    onClick={() => { setShowReasonModal('reject'); setActionsMenuOpen(false); }}
                    disabled={actionLoading}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-40 transition-colors text-left"
                  >
                    <XCircle size={14} />
                    {t('drivers.action_reject', { defaultValue: 'Rechazar conductor' })}
                  </button>
                )}
                {status === 'approved' && (
                  <button
                    onClick={() => { setShowReasonModal('suspend'); setActionsMenuOpen(false); }}
                    disabled={actionLoading}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-orange-700 hover:bg-orange-50 disabled:opacity-40 transition-colors text-left"
                  >
                    <AlertTriangle size={14} />
                    {t('drivers.action_suspend', { defaultValue: 'Suspender conductor' })}
                  </button>
                )}

                {/* Wallet ops — always available */}
                <div className="border-t border-line my-1" />
                <button
                  onClick={() => { setWalletModalOpen(true); setActionsMenuOpen(false); }}
                  disabled={actionLoading}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-primary-700 hover:bg-primary-50 disabled:opacity-40 transition-colors text-left"
                >
                  <span className="text-base leading-none">±</span>
                  {t('admin_ops.adjust_wallet_btn', { defaultValue: 'Ajustar saldo TC' })}
                </button>
                <button
                  onClick={() => { setGraceTripsModalOpen(true); setActionsMenuOpen(false); }}
                  disabled={actionLoading}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-sky-700 hover:bg-sky-50 disabled:opacity-40 transition-colors text-left"
                >
                  <span className="text-base leading-none">★</span>
                  {t('admin_ops.grace_trips_btn', { defaultValue: 'Dar viajes de gracia' })}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ─── Main grid ───────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* ─── LEFT COLUMN ──────────────────────────────── */}
        <div className="lg:col-span-3 space-y-6">
          {/* Documents */}
          <section className="bg-surface-elevated rounded-xl border border-line p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs font-medium text-ink-muted uppercase tracking-wider">
                {t('drivers.documents_section', { defaultValue: 'Documentos' })}
              </h2>
              <div className="text-xs text-ink-muted tabular-nums">
                {verifiedDocsCount}/{totalDocsCount || 5} {t('drivers.verified', { defaultValue: 'verificados' })}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(['national_id', 'drivers_license', 'vehicle_registration', 'selfie', 'vehicle_photo'] as const).map((docType) => {
                const doc = documents.find((d) => d.document_type === docType);
                const url = doc ? docUrls[doc.id] : null;
                const docVerified = doc?.is_verified;
                const docRejected = !doc?.is_verified && !!doc?.rejection_reason;

                return (
                  <div
                    key={docType}
                    className={`rounded-lg border p-3 ${
                      docVerified ? 'border-green-200/80 bg-green-50/30' :
                      docRejected ? 'border-red-200/80 bg-red-50/30' :
                      'border-line bg-surface-elevated'
                    }`}
                  >
                    {/* Header */}
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <FileText size={14} className="text-ink-subtle" />
                        <p className="text-sm font-medium text-ink">
                          {DOC_TYPE_KEY[docType] ? t(DOC_TYPE_KEY[docType]) : docType}
                        </p>
                      </div>
                      {doc && (
                        <div className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          docVerified ? 'bg-green-100 text-green-700' :
                          docRejected ? 'bg-red-100 text-red-700' :
                          'bg-yellow-100 text-yellow-700'
                        }`}>
                          {docVerified ? <CheckCircle2 size={10} /> : docRejected ? <XCircle size={10} /> : <Clock size={10} />}
                          {docVerified ? t('verification.doc_status_verified', { defaultValue: 'Verificado' }) :
                           docRejected ? t('verification.doc_status_rejected', { defaultValue: 'Rechazado' }) :
                           t('verification.doc_status_pending', { defaultValue: 'Pendiente' })}
                        </div>
                      )}
                    </div>

                    {doc ? (
                      <div>
                        {/* Preview */}
                        {url && url !== '__error__' && (() => {
                          const isPdf = doc.mime_type === 'application/pdf' || doc.file_name?.endsWith('.pdf');
                          return isPdf ? (
                            <button
                              onClick={() => window.open(url, '_blank')}
                              className="w-full h-28 flex flex-col items-center justify-center bg-surface-sunken border border-line rounded-md mb-2 hover:bg-surface-sunken transition-colors gap-1.5 group"
                            >
                              <FileText size={24} className="text-red-500" />
                              <span className="text-[10px] text-ink-muted font-medium truncate max-w-[90%]">
                                {doc.file_name || 'PDF'}
                              </span>
                              <span className="text-[10px] text-primary-600 group-hover:underline inline-flex items-center gap-1">
                                {t('drivers.view_document', { defaultValue: 'Ver documento' })}
                                <ExternalLink size={10} />
                              </span>
                            </button>
                          ) : (
                            <a href={url} target="_blank" rel="noopener noreferrer" className="block mb-2">
                              <img
                                src={url}
                                alt={docType}
                                className="w-full h-28 object-cover rounded-md cursor-pointer hover:opacity-80 transition-opacity"
                              />
                            </a>
                          );
                        })()}
                        {url === '__error__' && (
                          <div className="w-full h-28 bg-red-50 border border-red-200 rounded-md mb-2 flex items-center justify-center">
                            <span className="text-[10px] text-red-500">{t('verification.doc_load_error', { defaultValue: 'Error cargando' })}</span>
                          </div>
                        )}
                        {!url && (
                          <div className="w-full h-28 bg-surface-sunken rounded-md mb-2 flex items-center justify-center">
                            <Clock size={14} className="text-ink-subtle animate-spin" />
                          </div>
                        )}

                        {/* Meta */}
                        <div className="flex items-center justify-between text-[10px] text-ink-muted mb-2">
                          <span>{formatAdminDate(doc.uploaded_at)}</span>
                          {doc.face_match_score != null && (
                            <span className={`font-medium ${doc.face_match_score >= 0.8 ? 'text-green-600' : 'text-red-600'}`}>
                              {Math.round(doc.face_match_score * 100)}%
                            </span>
                          )}
                        </div>

                        {/* Rejection / Verification notes */}
                        {docRejected && doc.rejection_reason && (
                          <div className="px-2 py-1.5 mb-2 rounded bg-red-50 border border-red-100">
                            <p className="text-[10px] text-red-700">{doc.rejection_reason}</p>
                          </div>
                        )}
                        {docVerified && doc.verification_notes && (
                          <div className="px-2 py-1.5 mb-2 rounded bg-green-50 border border-green-100">
                            <p className="text-[10px] text-green-700 italic">{doc.verification_notes}</p>
                          </div>
                        )}

                        {/* Verify/Reject controls */}
                        {!docVerified && (
                          <div className="mt-2 space-y-1.5">
                            <input
                              type="text"
                              value={docNotes[doc.id] || ''}
                              onChange={(e) => setDocNotes((prev) => ({ ...prev, [doc.id]: e.target.value }))}
                              placeholder={t('verification.verification_notes', { defaultValue: 'Notas (opcional para aprobar, requerida para rechazar)' })}
                              className="w-full border border-line bg-surface text-ink rounded px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
                            />
                            <div className="flex gap-1.5">
                              <button
                                onClick={() => handleVerifyDoc(doc.id, true)}
                                disabled={verifyingDoc === doc.id}
                                className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
                              >
                                <CheckCircle2 size={12} />
                                {t('verification.verify_doc', { defaultValue: 'Verificar' })}
                              </button>
                              <button
                                onClick={() => handleVerifyDoc(doc.id, false)}
                                disabled={verifyingDoc === doc.id || !docNotes[doc.id]?.trim()}
                                className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
                              >
                                <XCircle size={12} />
                                {t('verification.reject_doc', { defaultValue: 'Rechazar' })}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="w-full h-28 bg-surface-sunken border border-dashed border-line rounded-md flex flex-col items-center justify-center">
                        <FileText size={20} className="text-ink-subtle mb-1" />
                        <span className="text-[10px] text-ink-subtle">{t('drivers.not_uploaded', { defaultValue: 'Sin subir' })}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* Selfie Checks */}
          {selfieChecks.length > 0 && (
            <section className="bg-surface-elevated rounded-xl border border-line p-5">
              <h2 className="text-xs font-medium text-ink-muted uppercase tracking-wider mb-3">
                {t('verification.selfie_checks', { defaultValue: 'Verificaciones de selfie' })}
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line">
                      <th className="text-left py-2 text-[10px] font-medium text-ink-muted uppercase tracking-wider">Fecha</th>
                      <th className="text-left py-2 text-[10px] font-medium text-ink-muted uppercase tracking-wider">Estado</th>
                      <th className="text-left py-2 text-[10px] font-medium text-ink-muted uppercase tracking-wider">Match</th>
                      <th className="text-left py-2 text-[10px] font-medium text-ink-muted uppercase tracking-wider">Liveness</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selfieChecks.map((check) => (
                      <tr key={check.id} className="border-b border-line last:border-0 h-11">
                        <td className="text-sm text-ink-muted">{formatAdminDate(check.requested_at)}</td>
                        <td>
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            check.status === 'passed' ? 'bg-green-100 text-green-700' :
                            check.status === 'failed' ? 'bg-red-100 text-red-700' :
                            check.status === 'processing' ? 'bg-blue-100 text-blue-700' :
                            check.status === 'expired' ? 'bg-neutral-100 text-neutral-500' :
                            'bg-yellow-100 text-yellow-700'
                          }`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${
                              check.status === 'passed' ? 'bg-green-500' :
                              check.status === 'failed' ? 'bg-red-500' :
                              check.status === 'processing' ? 'bg-blue-500' :
                              'bg-neutral-400'
                            }`} />
                            {check.status}
                          </span>
                        </td>
                        <td>
                          {check.face_match_score != null ? (
                            <span className={`text-sm font-medium tabular-nums ${check.face_match_score >= 0.8 ? 'text-green-600' : 'text-red-600'}`}>
                              {Math.round(check.face_match_score * 100)}%
                            </span>
                          ) : (
                            <span className="text-sm text-ink-subtle">—</span>
                          )}
                        </td>
                        <td>
                          {check.liveness_passed != null ? (
                            check.liveness_passed
                              ? <CheckCircle2 size={14} className="text-green-600" />
                              : <XCircle size={14} className="text-red-600" />
                          ) : (
                            <span className="text-sm text-ink-subtle">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Score history timeline */}
          {scoreEvents.length > 0 && (
            <section className="bg-surface-elevated rounded-xl border border-line p-5">
              <h2 className="text-xs font-medium text-ink-muted uppercase tracking-wider mb-3">
                {t('drivers.score_history', { defaultValue: 'Historial de puntuación' })}
              </h2>
              <div className="space-y-1">
                {(showAllEvents ? scoreEvents : scoreEvents.slice(0, 10)).map((evt) => (
                  <div key={evt.id} className="flex items-center gap-3 py-1.5 border-b border-line last:border-0">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${
                      evt.delta > 0 ? 'bg-green-500' : evt.delta < 0 ? 'bg-red-500' : 'bg-neutral-300'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-ink-muted truncate capitalize">
                        {evt.event_type.replace(/_/g, ' ')}
                      </p>
                      <p className="text-[10px] text-ink-subtle">{formatAdminDate(evt.created_at)}</p>
                    </div>
                    <span className={`text-sm font-medium tabular-nums shrink-0 ${
                      evt.delta > 0 ? 'text-green-600' : evt.delta < 0 ? 'text-red-600' : 'text-neutral-400'
                    }`}>
                      {evt.delta > 0 ? '+' : ''}{Number(evt.delta).toFixed(1)}
                    </span>
                  </div>
                ))}
              </div>
              {scoreEvents.length > 10 && (
                <button
                  onClick={() => setShowAllEvents((v) => !v)}
                  className="mt-2 text-sm text-primary-500 hover:text-primary-600"
                >
                  {showAllEvents
                    ? t('common.show_less', { defaultValue: 'Ver menos' })
                    : t('common.show_more', { defaultValue: `Ver ${scoreEvents.length - 10} más` })}
                </button>
              )}
            </section>
          )}
        </div>

        {/* ─── RIGHT COLUMN ─────────────────────────────── */}
        <aside className="lg:col-span-2 space-y-6 lg:sticky lg:top-6 self-start">
          {/* Personal info */}
          <section className="bg-surface-elevated rounded-xl border border-line p-5">
            <h2 className="text-xs font-medium text-ink-muted uppercase tracking-wider mb-3">
              {t('drivers.personal_info', { defaultValue: 'Perfil' })}
            </h2>
            <dl className="space-y-2.5">
              <Field icon={Phone} label={t('drivers.label_phone', { defaultValue: 'Teléfono' })} value={profile.users.phone} />
              <Field icon={Mail} label={t('drivers.label_email', { defaultValue: 'Email' })} value={profile.users.email || '—'} />
              {(profile as DriverProfile & { province?: string }).province && (
                <Field icon={MapPin} label={t('drivers.label_province', { defaultValue: 'Provincia' })} value={(profile as DriverProfile & { province?: string }).province!} />
              )}
              {(profile as DriverProfile & { municipality?: string }).municipality && (
                <Field icon={MapPin} label={t('drivers.label_municipality', { defaultValue: 'Municipio' })} value={(profile as DriverProfile & { municipality?: string }).municipality!} />
              )}
              {(profile as DriverProfile & { address?: string }).address && (
                <Field icon={MapPin} label={t('drivers.label_address', { defaultValue: 'Dirección' })} value={(profile as DriverProfile & { address?: string }).address!} />
              )}
              {(profile as DriverProfile & { identity_number?: string }).identity_number && (
                <Field icon={Shield} label={t('drivers.label_ci', { defaultValue: 'Cédula' })} value={(profile as DriverProfile & { identity_number?: string }).identity_number!} />
              )}
            </dl>

            {/* Top review tags */}
            {topTags.length > 0 && (
              <div className="mt-4 pt-4 border-t border-line">
                <p className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">
                  {t('drivers.top_review_tags', { defaultValue: 'Tags más comunes' })}
                </p>
                <div className="flex flex-wrap gap-1">
                  {topTags.slice(0, 5).map((tag) => (
                    <span
                      key={tag.tag_key}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-sunken text-[10px] text-ink-muted"
                    >
                      {t(`drivers.tag_${tag.tag_key}`, { defaultValue: tag.tag_key })}
                      <span className="text-ink-subtle">{tag.count}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Vehicle */}
          {vehicle && (
            <section className="bg-surface-elevated rounded-xl border border-line p-5">
              <h2 className="text-xs font-medium text-ink-muted uppercase tracking-wider mb-3">
                {t('drivers.vehicle_section', { defaultValue: 'Vehículo' })}
              </h2>
              <div className="flex items-center gap-3 mb-3 pb-3 border-b border-line">
                <div className="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center">
                  <VIcon size={20} className="text-primary-600" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-ink capitalize">
                    {(() => {
                      const key = VEHICLE_TYPE_KEY[vehicle.type];
                      return key ? t(key) : vehicle.type;
                    })()}
                  </p>
                  <p className="text-xs text-ink-muted">{vehicle.make} {vehicle.model}</p>
                </div>
              </div>
              <dl className="space-y-2.5">
                <Field label={t('drivers.label_year', { defaultValue: 'Año' })} value={String(vehicle.year)} />
                <Field label={t('drivers.label_color', { defaultValue: 'Color' })} value={vehicle.color} />
                <Field label={t('drivers.label_plate', { defaultValue: 'Placa' })} value={vehicle.plate_number} mono />
                <Field label={t('drivers.label_capacity', { defaultValue: 'Capacidad' })} value={`${vehicle.capacity} ${t('drivers.passengers', { defaultValue: 'pasajeros' })}`} />
              </dl>
              {vehicle.accepts_cargo && (
                <div className="mt-3 inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium bg-green-50 text-green-700 border border-green-200">
                  <Package size={10} />
                  {t('drivers.accepts_cargo', { defaultValue: 'Acepta carga' })} · {vehicle.max_cargo_weight_kg ?? '?'}kg
                </div>
              )}
            </section>
          )}

          {/* Metrics */}
          <section className="bg-surface-elevated rounded-xl border border-line p-5">
            <h2 className="text-xs font-medium text-ink-muted uppercase tracking-wider mb-3">
              {t('drivers.metrics', { defaultValue: 'Métricas' })}
            </h2>
            <div className="grid grid-cols-3 gap-3">
              <Metric
                label={t('drivers.label_rating', { defaultValue: 'Rating' })}
                value={Number(profile.rating_avg).toFixed(1)}
                icon={<Star size={12} className="fill-amber-500 text-amber-500" />}
              />
              <Metric
                label={t('drivers.label_completed_rides', { defaultValue: 'Viajes' })}
                value={String(profile.total_rides_completed)}
              />
              <Metric
                label={t('drivers.acceptance_rate', { defaultValue: 'Aceptación' })}
                value={`${Number(profile.acceptance_rate ?? 100).toFixed(0)}%`}
              />
            </div>
            {/* Match score mini */}
            <div className="mt-3 pt-3 border-t border-line">
              <div className="flex items-center justify-between">
                <span className="text-xs text-neutral-500">{t('drivers.match_score', { defaultValue: 'Match score' })}</span>
                <span className={`text-sm font-semibold tabular-nums ${
                  Number(profile.match_score ?? 50) >= 70 ? 'text-green-600' :
                  Number(profile.match_score ?? 50) >= 40 ? 'text-yellow-600' : 'text-red-600'
                }`}>
                  {Number(profile.match_score ?? 50).toFixed(1)}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-full bg-surface-sunken rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all ${
                    Number(profile.match_score ?? 50) >= 70 ? 'bg-green-500' :
                    Number(profile.match_score ?? 50) >= 40 ? 'bg-yellow-500' : 'bg-red-500'
                  }`}
                  style={{ width: `${Math.min(100, Math.max(0, Number(profile.match_score ?? 50)))}%` }}
                />
              </div>
              <p className="text-[10px] text-neutral-500 mt-1.5">
                {profile.total_rides_offered ?? 0} {t('drivers.rides_offered', { defaultValue: 'viajes ofrecidos' })}
              </p>
            </div>
          </section>

          {/* Churn Risk */}
          {churnRisk && (
            <section className={`rounded-xl border p-4 ${
              churnRisk.risk_level === 'high' ? 'bg-red-50 border-red-200' :
              churnRisk.risk_level === 'medium' ? 'bg-amber-50 border-amber-200' :
              'bg-green-50 border-green-200'
            }`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  {churnRisk.risk_level === 'high' ? <TrendingDown size={14} className="text-red-600" /> : <TrendingUp size={14} className={churnRisk.risk_level === 'medium' ? 'text-amber-600' : 'text-green-600'} />}
                  <h3 className="text-xs font-medium uppercase tracking-wider text-ink-muted">
                    {t('drivers.churn_risk', { defaultValue: 'Riesgo de abandono' })}
                  </h3>
                </div>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                  churnRisk.risk_level === 'high' ? 'bg-red-100 text-red-700' :
                  churnRisk.risk_level === 'medium' ? 'bg-amber-100 text-amber-700' :
                  'bg-green-100 text-green-700'
                }`}>
                  {churnRisk.risk_level === 'high' ? 'ALTO' :
                   churnRisk.risk_level === 'medium' ? 'MEDIO' : 'BAJO'}
                </span>
              </div>
              <div className="flex items-baseline gap-1 mb-1">
                <span className="text-2xl font-bold text-ink tabular-nums">{churnRisk.churn_risk_score}</span>
                <span className="text-xs text-neutral-500">/100</span>
              </div>
              <p className="text-xs text-ink-muted">
                {churnRisk.days_since_last_ride} {t('drivers.days_since_ride_short', { defaultValue: 'días sin viaje' })}
                {churnRisk.earnings_this_week > 0 && <> · {formatCUP(churnRisk.earnings_this_week)} esta semana</>}
              </p>
            </section>
          )}

          {/* Financial */}
          <section className="bg-surface-elevated rounded-xl border border-line p-5">
            <h2 className="text-xs font-medium text-ink-muted uppercase tracking-wider mb-3">
              {t('drivers.financial_eligibility', { defaultValue: 'Estado financiero' })}
            </h2>
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${
                profile.is_financially_eligible !== false
                  ? 'bg-green-50 text-green-700 border border-green-200'
                  : 'bg-red-50 text-red-700 border border-red-200'
              }`}>
                {profile.is_financially_eligible !== false
                  ? <><CheckCircle2 size={11} /> {t('drivers.eligible', { defaultValue: 'Elegible' })}</>
                  : <><XCircle size={11} /> {t('drivers.not_eligible', { defaultValue: 'No elegible' })}</>}
              </span>
            </div>
            {profile.negative_balance_since && (
              <p className="text-[11px] text-neutral-500 mt-2">
                {t('drivers.negative_balance_since', { defaultValue: 'Balance negativo desde' })} {formatAdminDate(profile.negative_balance_since)}
              </p>
            )}
          </section>
        </aside>
      </div>

      {/* ─── Reason modal ──────────────────────────────── */}
      {showReasonModal && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) { setShowReasonModal(null); setReason(''); }
          }}
        >
          <div className="bg-surface-elevated rounded-xl w-full max-w-lg shadow-xl">
            <div className="p-5 border-b border-line">
              <h3 className="text-lg font-semibold text-ink">
                {showReasonModal === 'reject'
                  ? t('drivers.reject_reason_title', { defaultValue: 'Rechazar conductor' })
                  : t('drivers.suspend_reason_title', { defaultValue: 'Suspender conductor' })}
              </h3>
              <p className="text-sm text-neutral-500 mt-1">
                {showReasonModal === 'reject'
                  ? t('drivers.reject_helper', { defaultValue: 'Explica al conductor por qué su solicitud fue rechazada.' })
                  : t('drivers.suspend_helper', { defaultValue: 'Esta acción tiene consecuencias importantes. Revisa antes de continuar.' })}
              </p>
            </div>

            <div className="p-5">
              {showReasonModal === 'suspend' && (
                <div className="mb-4 p-3 bg-orange-50 border border-orange-200 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle size={14} className="text-orange-600" />
                    <p className="text-sm font-semibold text-orange-800">
                      {t('drivers.suspend_warning_title', { defaultValue: 'Al suspender este conductor' })}
                    </p>
                  </div>
                  <ul className="space-y-1 text-xs text-orange-700 ml-5 list-disc">
                    <li>{t('drivers.suspend_warning_active_rides', { defaultValue: 'Sus viajes activos serán cancelados' })}</li>
                    <li>{t('drivers.suspend_warning_no_new', { defaultValue: 'No podrá aceptar nuevos viajes' })}</li>
                    <li>{t('drivers.suspend_warning_wallet', { defaultValue: 'Su billetera quedará restringida' })}</li>
                  </ul>
                </div>
              )}

              <textarea
                autoFocus
                className="w-full border border-line bg-surface text-ink rounded-lg p-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                rows={4}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('drivers.explain_reason_placeholder', { defaultValue: 'Explica el motivo...' })}
                aria-label={t('drivers.explain_reason_placeholder')}
              />
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-line bg-surface-sunken/50 rounded-b-xl">
              <button
                onClick={() => { setShowReasonModal(null); setReason(''); }}
                className="px-4 h-9 rounded-md text-sm font-medium text-ink hover:bg-surface-sunken transition-colors"
              >
                {t('common.cancel', { defaultValue: 'Cancelar' })}
              </button>
              <button
                onClick={handleRejectOrSuspend}
                disabled={!reason.trim() || actionLoading}
                className={`px-4 h-9 rounded-md text-sm font-medium text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  showReasonModal === 'reject'
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-orange-600 hover:bg-orange-700'
                }`}
              >
                {actionLoading
                  ? t('common.processing', { defaultValue: 'Procesando...' })
                  : showReasonModal === 'reject'
                    ? t('drivers.action_reject', { defaultValue: 'Rechazar' })
                    : t('drivers.action_suspend', { defaultValue: 'Suspender' })}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* BUG-276: Adjust Wallet Modal — single-wallet model.
          Default to `tricicoin` (Cuota de trabajo) so admin top-ups land
          where the driver actually needs them: the commission balance
          checked by accept_ride. Crediting driver_cash was useless for
          unblocking drivers from accepting rides. */}
      <AdjustWalletModal
        open={walletModalOpen}
        userName={profile.users.full_name || profile.user_id}
        isDriver={true}
        defaultAccountType="tricicoin"
        loading={walletAdjusting}
        onCancel={() => setWalletModalOpen(false)}
        onConfirm={handleAdjustDriverQuota}
      />

      {/* Grace Trips Modal */}
      {graceTripsModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => !graceTripsSubmitting && setGraceTripsModalOpen(false)}>
          <div className="admin-card w-full max-w-md p-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
              {t('admin_ops.grace_eyebrow', { defaultValue: 'Bonificación' })}
            </p>
            <h3 className="font-display text-[18px] font-semibold text-ink">
              {t('admin_ops.grace_title', { defaultValue: 'Viajes de gracia (sin comisión)' })}
            </h3>
            <p className="mt-0.5 text-[12.5px] text-ink-muted">
              {profile.users.full_name}
            </p>

            <label className="mt-4 flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                {t('admin_ops.grace_count', { defaultValue: 'Cantidad de viajes (+/-)' })}
              </span>
              <input
                type="number"
                value={graceTripsCount}
                onChange={(e) => setGraceTripsCount(e.target.value)}
                disabled={graceTripsSubmitting}
                className="h-10 rounded-lg border border-line bg-surface px-3 text-[14px] text-ink focus:border-primary-500 focus:outline-none"
              />
            </label>
            <label className="mt-3 flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                {t('admin_ops.grace_reason', { defaultValue: 'Razón' })}
              </span>
              <textarea
                value={graceTripsReason}
                onChange={(e) => setGraceTripsReason(e.target.value)}
                rows={3}
                disabled={graceTripsSubmitting}
                className="rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink focus:border-primary-500 focus:outline-none resize-none"
              />
            </label>

            <div className="mt-5 flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setGraceTripsModalOpen(false)}
                disabled={graceTripsSubmitting}
                className="rounded-lg border border-line bg-surface px-4 py-2 text-[13px] font-medium text-ink hover:bg-surface-sunken"
              >
                {t('admin_ops.cancel', { defaultValue: 'Cancelar' })}
              </button>
              <button
                type="button"
                onClick={handleGrantGraceTrips}
                disabled={graceTripsSubmitting}
                className="rounded-lg bg-sky-600 px-4 py-2 text-[13px] font-medium text-white hover:bg-sky-700 disabled:opacity-50"
              >
                {graceTripsSubmitting
                  ? t('admin_ops.applying', { defaultValue: 'Aplicando…' })
                  : t('admin_ops.grace_confirm', { defaultValue: 'Otorgar' })}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Reusable helpers (internal) ───────────────────────────────
function Field({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-xs text-neutral-500 flex items-center gap-1.5 shrink-0 pt-0.5">
        {Icon && <Icon size={11} className="text-neutral-400" />}
        {label}
      </dt>
      <dd className={`text-sm text-ink text-right ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}

function Metric({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="text-center">
      <div className="flex items-center justify-center gap-1 text-lg font-bold text-ink tabular-nums">
        {icon}
        {value}
      </div>
      <div className="text-[10px] text-neutral-500 mt-0.5">{label}</div>
    </div>
  );
}
