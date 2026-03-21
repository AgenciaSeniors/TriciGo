'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { adminService, reviewService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { DriverProfile, DriverDocument, DriverScoreEvent, Vehicle, DriverStatus, SelfieCheck, ReviewTagSummaryItem } from '@tricigo/types';
import { useAdminUser } from '@/lib/useAdminUser';

type DriverDetail = {
  profile: DriverProfile & { users: { full_name: string; phone: string; email: string | null } };
  vehicle: Vehicle | null;
  documents: DriverDocument[];
  scoreEvents: DriverScoreEvent[];
};

const statusBadgeClasses: Record<DriverStatus, string> = {
  pending_verification: 'bg-yellow-50 text-yellow-700',
  under_review: 'bg-blue-50 text-blue-700',
  approved: 'bg-green-50 text-green-700',
  rejected: 'bg-red-50 text-red-700',
  suspended: 'bg-orange-50 text-orange-700',
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

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('es-CU', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function DriverDetailPage() {
  const { t } = useTranslation('admin');
  const { userId: adminUserId } = useAdminUser();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [driver, setDriver] = useState<DriverDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [showReasonModal, setShowReasonModal] = useState<'reject' | 'suspend' | null>(null);
  const [reason, setReason] = useState('');
  const [docUrls, setDocUrls] = useState<Record<string, string>>({});
  const [selfieChecks, setSelfieChecks] = useState<SelfieCheck[]>([]);
  const [verifyingDoc, setVerifyingDoc] = useState<string | null>(null);
  const [docNotes, setDocNotes] = useState<Record<string, string>>({});
  const [topTags, setTopTags] = useState<ReviewTagSummaryItem[]>([]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function load() {
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
        }
      } catch (err) {
        console.error('Error loading driver:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [id]);

  // Load document signed URLs
  useEffect(() => {
    if (!driver?.documents.length) return;

    driver.documents.forEach(async (doc) => {
      try {
        const url = await adminService.getDocumentUrl(doc.storage_path);
        setDocUrls((prev) => ({ ...prev, [doc.id]: url }));
      } catch {
        // Storage may not be configured yet
      }
    });
  }, [driver?.documents]);

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
    } catch (err) {
      console.error('Error verifying document:', err);
    } finally {
      setVerifyingDoc(null);
    }
  };

  const handleApprove = async () => {
    if (!id) return;
    setActionLoading(true);
    try {
      await adminService.approveDriver(id, adminUserId);
      await refreshDriver();
    } catch (err) {
      console.error('Error approving driver:', err);
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
    } catch (err) {
      console.error('Error:', err);
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <p className="text-neutral-400">{t('common.loading')}</p>
      </div>
    );
  }

  if (!driver) {
    return (
      <div className="flex items-center justify-center py-24">
        <p className="text-neutral-400">{t('drivers.driver_not_found')}</p>
      </div>
    );
  }

  const { profile, vehicle, documents, scoreEvents } = driver;
  const status = profile.status as DriverStatus;
  const verifiedDocsCount = documents.filter((d) => d.is_verified).length;
  const totalDocsCount = documents.length;
  const allDocsVerified = totalDocsCount >= 5 && verifiedDocsCount === totalDocsCount;

  return (
    <div className="max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <button
          onClick={() => router.push('/drivers')}
          className="text-sm text-neutral-500 hover:text-neutral-700 transition-colors"
        >
          &larr; {t('drivers.back_to_list')}
        </button>
      </div>

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">{profile.users.full_name || '—'}</h1>
          <span
            className={`inline-block mt-2 px-3 py-1 rounded-full text-sm font-medium ${statusBadgeClasses[status]}`}
          >
            {STATUS_LABEL_KEY[status] ? t(STATUS_LABEL_KEY[status]!) : status}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Personal Info */}
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">
          <h2 className="text-lg font-bold mb-4">{t('drivers.personal_info')}</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-sm text-neutral-500">{t('drivers.label_name')}</dt>
              <dd className="text-sm font-medium">{profile.users.full_name || '—'}</dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">{t('drivers.label_phone')}</dt>
              <dd className="text-sm font-medium">{profile.users.phone}</dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">{t('drivers.label_email')}</dt>
              <dd className="text-sm font-medium">{profile.users.email || '—'}</dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">{t('drivers.label_rating')}</dt>
              <dd className="text-sm font-medium">{Number(profile.rating_avg).toFixed(1)} / 5.0</dd>
              {topTags.length > 0 && (
                <div className="mt-2">
                  <dt className="text-xs text-neutral-400 mb-1">{t('drivers.top_review_tags')}</dt>
                  <dd className="flex flex-wrap gap-1">
                    {topTags.slice(0, 5).map((tag) => (
                      <span
                        key={tag.tag_key}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-neutral-100 text-xs text-neutral-600"
                      >
                        {t(`drivers.tag_${tag.tag_key}`, { defaultValue: tag.tag_key })}
                        <span className="text-neutral-400">({tag.count})</span>
                      </span>
                    ))}
                  </dd>
                </div>
              )}
            </div>
            <div>
              <dt className="text-sm text-neutral-500">{t('drivers.label_completed_rides')}</dt>
              <dd className="text-sm font-medium">{profile.total_rides_completed}</dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">{t('drivers.label_registered')}</dt>
              <dd className="text-sm font-medium">{formatDate(profile.created_at)}</dd>
            </div>
          </dl>
        </div>

        {/* Vehicle */}
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">
          <h2 className="text-lg font-bold mb-4">{t('drivers.vehicle_section')}</h2>
          {vehicle ? (
            <dl className="space-y-3">
              <div>
                <dt className="text-sm text-neutral-500">{t('drivers.label_type')}</dt>
                <dd className="text-sm font-medium">{VEHICLE_TYPE_KEY[vehicle.type] ? t(VEHICLE_TYPE_KEY[vehicle.type]!) : vehicle.type}</dd>
              </div>
              <div>
                <dt className="text-sm text-neutral-500">{t('drivers.label_make_model')}</dt>
                <dd className="text-sm font-medium">{vehicle.make} {vehicle.model}</dd>
              </div>
              <div>
                <dt className="text-sm text-neutral-500">{t('drivers.label_year')}</dt>
                <dd className="text-sm font-medium">{vehicle.year}</dd>
              </div>
              <div>
                <dt className="text-sm text-neutral-500">{t('drivers.label_color')}</dt>
                <dd className="text-sm font-medium">{vehicle.color}</dd>
              </div>
              <div>
                <dt className="text-sm text-neutral-500">{t('drivers.label_plate')}</dt>
                <dd className="text-sm font-medium">{vehicle.plate_number}</dd>
              </div>
              <div>
                <dt className="text-sm text-neutral-500">{t('drivers.label_capacity')}</dt>
                <dd className="text-sm font-medium">{vehicle.capacity} {t('drivers.passengers')}</dd>
              </div>
              <div>
                <dt className="text-sm text-neutral-500">{t('drivers.accepts_cargo', { defaultValue: 'Acepta carga' })}</dt>
                <dd className="text-sm font-medium">
                  {vehicle.accepts_cargo ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700">
                      Si — {vehicle.max_cargo_weight_kg ?? '?'} kg max
                    </span>
                  ) : (
                    <span className="text-neutral-400">No</span>
                  )}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-neutral-400">{t('drivers.no_vehicle')}</p>
          )}
        </div>
      </div>

      {/* Documents */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 mb-8">
        <h2 className="text-lg font-bold mb-4">{t('drivers.documents_section')}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {(['national_id', 'drivers_license', 'vehicle_registration', 'selfie', 'vehicle_photo'] as const).map(
            (docType) => {
              const doc = documents.find((d) => d.document_type === docType);
              const url = doc ? docUrls[doc.id] : null;
              const docVerified = doc?.is_verified;
              const docRejected = !doc?.is_verified && !!doc?.rejection_reason;

              return (
                <div
                  key={docType}
                  className={`border rounded-lg p-4 ${
                    docVerified ? 'border-green-200 bg-green-50/30' :
                    docRejected ? 'border-red-200 bg-red-50/30' :
                    'border-neutral-200'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium">{DOC_TYPE_KEY[docType] ? t(DOC_TYPE_KEY[docType]!) : docType}</p>
                    {doc && (
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        docVerified ? 'bg-green-100 text-green-700' :
                        docRejected ? 'bg-red-100 text-red-700' :
                        'bg-yellow-100 text-yellow-700'
                      }`}>
                        {docVerified ? t('verification.doc_status_verified') :
                         docRejected ? t('verification.doc_status_rejected') :
                         t('verification.doc_status_pending')}
                      </span>
                    )}
                  </div>

                  {doc ? (
                    <div>
                      {/* Image preview */}
                      {url && (
                        <a href={url} target="_blank" rel="noopener noreferrer">
                          <img
                            src={url}
                            alt={docType}
                            className="w-full h-32 object-cover rounded-md mb-2 cursor-pointer hover:opacity-80 transition-opacity"
                          />
                        </a>
                      )}
                      {!url && (
                        <div className="w-full h-32 bg-neutral-100 rounded-md mb-2 flex items-center justify-center">
                          <span className="text-xs text-neutral-400">{t('common.loading')}</span>
                        </div>
                      )}

                      <p className="text-xs text-neutral-400 mb-2">
                        {t('drivers.doc_uploaded_at')} {formatDate(doc.uploaded_at)}
                      </p>

                      {/* Face match score */}
                      {doc.face_match_score != null && (
                        <div className="flex items-center gap-1 mb-2">
                          <span className="text-xs text-neutral-500">{t('verification.face_match_score')}:</span>
                          <span className={`text-xs font-medium ${
                            doc.face_match_score >= 0.8 ? 'text-green-600' : 'text-red-600'
                          }`}>
                            {Math.round(doc.face_match_score * 100)}%
                          </span>
                        </div>
                      )}

                      {/* Rejection reason */}
                      {docRejected && doc.rejection_reason && (
                        <p className="text-xs text-red-600 mb-2">
                          {doc.rejection_reason}
                        </p>
                      )}

                      {/* Verification notes */}
                      {doc.verification_notes && (
                        <p className="text-xs text-neutral-500 italic mb-2">{doc.verification_notes}</p>
                      )}

                      {/* Verify/Reject controls */}
                      {!docVerified && (
                        <div className="mt-3 border-t border-neutral-100 pt-3">
                          <input
                            type="text"
                            value={docNotes[doc.id] || ''}
                            onChange={(e) => setDocNotes((prev) => ({ ...prev, [doc.id]: e.target.value }))}
                            placeholder={t('verification.verification_notes')}
                            className="w-full border border-neutral-200 rounded px-2 py-1 text-xs mb-2 focus:outline-none focus:border-primary-500"
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleVerifyDoc(doc.id, true)}
                              disabled={verifyingDoc === doc.id}
                              className="flex-1 px-3 py-1.5 rounded text-xs font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
                            >
                              {t('verification.verify_doc')}
                            </button>
                            <button
                              onClick={() => handleVerifyDoc(doc.id, false)}
                              disabled={verifyingDoc === doc.id || !docNotes[doc.id]?.trim()}
                              className="flex-1 px-3 py-1.5 rounded text-xs font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
                            >
                              {t('verification.reject_doc')}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="text-sm text-neutral-400">{t('drivers.not_uploaded')}</span>
                  )}
                </div>
              );
            },
          )}
        </div>
      </div>

      {/* Selfie Checks */}
      {selfieChecks.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 mb-8">
          <h2 className="text-lg font-bold mb-4">{t('verification.selfie_checks')}</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-100">
                  <th className="text-left py-2 text-neutral-500 font-medium">{t('common.date')}</th>
                  <th className="text-left py-2 text-neutral-500 font-medium">{t('common.status')}</th>
                  <th className="text-left py-2 text-neutral-500 font-medium">{t('verification.face_match_score')}</th>
                  <th className="text-left py-2 text-neutral-500 font-medium">{t('verification.liveness')}</th>
                </tr>
              </thead>
              <tbody>
                {selfieChecks.map((check) => (
                  <tr key={check.id} className="border-b border-neutral-50">
                    <td className="py-2 text-neutral-700">{formatDate(check.requested_at)}</td>
                    <td className="py-2">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        check.status === 'passed' ? 'bg-green-100 text-green-700' :
                        check.status === 'failed' ? 'bg-red-100 text-red-700' :
                        check.status === 'processing' ? 'bg-blue-100 text-blue-700' :
                        check.status === 'expired' ? 'bg-neutral-100 text-neutral-500' :
                        'bg-yellow-100 text-yellow-700'
                      }`}>
                        {check.status}
                      </span>
                    </td>
                    <td className="py-2">
                      {check.face_match_score != null ? (
                        <span className={`font-medium ${check.face_match_score >= 0.8 ? 'text-green-600' : 'text-red-600'}`}>
                          {Math.round(check.face_match_score * 100)}%
                        </span>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                    <td className="py-2">
                      {check.liveness_passed != null ? (
                        <span className={check.liveness_passed ? 'text-green-600' : 'text-red-600'}>
                          {check.liveness_passed ? '✓' : '✗'}
                        </span>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Financial Eligibility */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 mb-8">
        <h2 className="text-lg font-bold mb-4">{t('drivers.financial_eligibility')}</h2>
        <div className="flex items-center gap-3">
          <span
            className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${
              profile.is_financially_eligible !== false
                ? 'bg-green-50 text-green-700'
                : 'bg-red-50 text-red-700'
            }`}
          >
            {profile.is_financially_eligible !== false ? t('drivers.eligible') : t('drivers.not_eligible')}
          </span>
          {profile.negative_balance_since && (
            <span className="text-sm text-neutral-500">
              {t('drivers.negative_balance_since')} {formatDate(profile.negative_balance_since)}
            </span>
          )}
        </div>
        {profile.is_financially_eligible === false && (
          <p className="text-sm text-neutral-500 mt-2">
            {t('drivers.negative_balance_warning')}
          </p>
        )}
      </div>

      {/* Match Score */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 mb-8">
        <h2 className="text-lg font-bold mb-4">{t('drivers.match_score')}</h2>
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="bg-neutral-50 rounded-lg p-4">
            <p className="text-xs text-neutral-500 mb-1">{t('drivers.match_score')}</p>
            <p className={`text-2xl font-bold ${
              Number(profile.match_score ?? 50) >= 70 ? 'text-green-600' :
              Number(profile.match_score ?? 50) >= 40 ? 'text-yellow-600' : 'text-red-600'
            }`}>
              {Number(profile.match_score ?? 50).toFixed(1)}
            </p>
          </div>
          <div className="bg-neutral-50 rounded-lg p-4">
            <p className="text-xs text-neutral-500 mb-1">{t('drivers.acceptance_rate')}</p>
            <p className="text-2xl font-bold text-neutral-700">
              {Number(profile.acceptance_rate ?? 100).toFixed(0)}%
            </p>
          </div>
          <div className="bg-neutral-50 rounded-lg p-4">
            <p className="text-xs text-neutral-500 mb-1">{t('drivers.rides_offered')}</p>
            <p className="text-2xl font-bold text-neutral-700">
              {profile.total_rides_offered ?? 0}
            </p>
          </div>
        </div>

        {/* Score events timeline */}
        {scoreEvents.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-neutral-700 mb-2">{t('drivers.score_history')}</h3>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {scoreEvents.map((evt) => (
                <div key={evt.id} className="flex items-center justify-between py-1.5 border-b border-neutral-50">
                  <div className="flex items-center gap-2">
                    <span className={`inline-block w-2 h-2 rounded-full ${
                      evt.delta > 0 ? 'bg-green-500' : evt.delta < 0 ? 'bg-red-500' : 'bg-neutral-300'
                    }`} />
                    <span className="text-sm text-neutral-600">{evt.event_type.replace(/_/g, ' ')}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`text-sm font-medium ${
                      evt.delta > 0 ? 'text-green-600' : evt.delta < 0 ? 'text-red-600' : 'text-neutral-400'
                    }`}>
                      {evt.delta > 0 ? '+' : ''}{Number(evt.delta).toFixed(1)}
                    </span>
                    <span className="text-xs text-neutral-400">
                      {formatDate(evt.created_at)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">
        <h2 className="text-lg font-bold mb-4">{t('drivers.actions_section')}</h2>
        <div className="flex flex-wrap gap-3">
          {(status === 'under_review' || status === 'pending_verification' || status === 'rejected' || status === 'suspended') && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleApprove}
                disabled={actionLoading || !allDocsVerified}
                className="px-6 py-2.5 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title={!allDocsVerified ? `Debe verificar todos los documentos (${verifiedDocsCount}/${totalDocsCount})` : ''}
              >
                {t('drivers.action_approve')}
              </button>
              {!allDocsVerified && (
                <span className="text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded-full">
                  {verifiedDocsCount}/{totalDocsCount} {t('drivers.docs_verified', { defaultValue: 'docs verificados' })}
                </span>
              )}
            </div>
          )}
          {(status === 'under_review' || status === 'pending_verification') && (
            <button
              onClick={() => setShowReasonModal('reject')}
              disabled={actionLoading}
              className="px-6 py-2.5 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
            >
              {t('drivers.action_reject')}
            </button>
          )}
          {status === 'approved' && (
            <button
              onClick={() => setShowReasonModal('suspend')}
              disabled={actionLoading}
              className="px-6 py-2.5 rounded-lg text-sm font-medium bg-orange-500 text-white hover:bg-orange-600 transition-colors disabled:opacity-50"
            >
              {t('drivers.action_suspend')}
            </button>
          )}
        </div>
      </div>

      {/* Reason modal */}
      {showReasonModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" role="dialog" aria-modal="true" aria-labelledby="reason-modal-title">
          <div className="bg-white rounded-xl p-6 w-full max-w-md mx-4">
            <h3 id="reason-modal-title" className="text-lg font-bold mb-4">
              {showReasonModal === 'reject' ? t('drivers.reject_reason_title') : t('drivers.suspend_reason_title')}
            </h3>
            <textarea
              className="w-full border border-neutral-200 rounded-lg p-3 text-sm focus:outline-none focus:border-primary-500"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('drivers.explain_reason_placeholder')}
            />
            <div className="flex gap-3 mt-4 justify-end">
              <button
                onClick={() => {
                  setShowReasonModal(null);
                  setReason('');
                }}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-neutral-100 text-neutral-700 hover:bg-neutral-200 transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleRejectOrSuspend}
                disabled={!reason.trim() || actionLoading}
                className={`px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors disabled:opacity-50 ${
                  showReasonModal === 'reject'
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-orange-500 hover:bg-orange-600'
                }`}
              >
                {actionLoading ? t('common.processing') : t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
