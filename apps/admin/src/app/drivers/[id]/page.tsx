'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { adminService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { DriverProfile, DriverDocument, DriverScoreEvent, Vehicle, DriverStatus } from '@tricigo/types';
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

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function load() {
      try {
        const data = await adminService.getDriverDetail(id);
        if (!cancelled) setDriver(data);
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
    const data = await adminService.getDriverDetail(id);
    setDriver(data);
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
            </dl>
          ) : (
            <p className="text-sm text-neutral-400">{t('drivers.no_vehicle')}</p>
          )}
        </div>
      </div>

      {/* Documents */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 mb-8">
        <h2 className="text-lg font-bold mb-4">{t('drivers.documents_section')}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {(['national_id', 'drivers_license', 'vehicle_registration', 'selfie', 'vehicle_photo'] as const).map(
            (docType) => {
              const doc = documents.find((d) => d.document_type === docType);
              const url = doc ? docUrls[doc.id] : null;
              return (
                <div
                  key={docType}
                  className="border border-neutral-200 rounded-lg p-4"
                >
                  <p className="text-sm font-medium mb-2">{DOC_TYPE_KEY[docType] ? t(DOC_TYPE_KEY[docType]!) : docType}</p>
                  {doc ? (
                    <div>
                      {url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-[#FF4D00] hover:underline"
                        >
                          {t('drivers.view_document')}
                        </a>
                      ) : (
                        <span className="text-sm text-neutral-400">{t('common.loading')}</span>
                      )}
                      <p className="text-xs text-neutral-400 mt-1">
                        {t('drivers.doc_uploaded_at')} {formatDate(doc.uploaded_at)}
                      </p>
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
            <button
              onClick={handleApprove}
              disabled={actionLoading}
              className="px-6 py-2.5 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 transition-colors disabled:opacity-50"
            >
              {t('drivers.action_approve')}
            </button>
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-bold mb-4">
              {showReasonModal === 'reject' ? t('drivers.reject_reason_title') : t('drivers.suspend_reason_title')}
            </h3>
            <textarea
              className="w-full border border-neutral-200 rounded-lg p-3 text-sm focus:outline-none focus:border-[#FF4D00]"
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
