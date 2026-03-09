'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { adminService } from '@tricigo/api';
import type { DriverProfile, DriverDocument, Vehicle, DriverStatus } from '@tricigo/types';

type DriverDetail = {
  profile: DriverProfile & { users: { full_name: string; phone: string; email: string | null } };
  vehicle: Vehicle | null;
  documents: DriverDocument[];
};

const statusBadgeClasses: Record<DriverStatus, string> = {
  pending_verification: 'bg-yellow-50 text-yellow-700',
  under_review: 'bg-blue-50 text-blue-700',
  approved: 'bg-green-50 text-green-700',
  rejected: 'bg-red-50 text-red-700',
  suspended: 'bg-orange-50 text-orange-700',
};

const statusLabels: Record<DriverStatus, string> = {
  pending_verification: 'Pendiente',
  under_review: 'En revisión',
  approved: 'Aprobado',
  rejected: 'Rechazado',
  suspended: 'Suspendido',
};

const vehicleTypeLabels: Record<string, string> = {
  triciclo: 'Triciclo',
  moto: 'Moto',
  auto: 'Auto',
};

const docTypeLabels: Record<string, string> = {
  national_id: 'Carné de identidad',
  drivers_license: 'Licencia de conducción',
  vehicle_registration: 'Matrícula del vehículo',
  selfie: 'Selfie de verificación',
  vehicle_photo: 'Foto del vehículo',
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
      await adminService.approveDriver(id, 'admin-placeholder');
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
        await adminService.rejectDriver(id, 'admin-placeholder', reason);
      } else {
        await adminService.suspendDriver(id, 'admin-placeholder', reason);
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
        <p className="text-neutral-400">Cargando...</p>
      </div>
    );
  }

  if (!driver) {
    return (
      <div className="flex items-center justify-center py-24">
        <p className="text-neutral-400">Conductor no encontrado</p>
      </div>
    );
  }

  const { profile, vehicle, documents } = driver;
  const status = profile.status as DriverStatus;

  return (
    <div className="max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <button
          onClick={() => router.push('/drivers')}
          className="text-sm text-neutral-500 hover:text-neutral-700 transition-colors"
        >
          &larr; Volver a la lista
        </button>
      </div>

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">{profile.users.full_name || '—'}</h1>
          <span
            className={`inline-block mt-2 px-3 py-1 rounded-full text-sm font-medium ${statusBadgeClasses[status]}`}
          >
            {statusLabels[status]}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Personal Info */}
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">
          <h2 className="text-lg font-bold mb-4">Información personal</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-sm text-neutral-500">Nombre</dt>
              <dd className="text-sm font-medium">{profile.users.full_name || '—'}</dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">Teléfono</dt>
              <dd className="text-sm font-medium">{profile.users.phone}</dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">Email</dt>
              <dd className="text-sm font-medium">{profile.users.email || '—'}</dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">Rating</dt>
              <dd className="text-sm font-medium">{Number(profile.rating_avg).toFixed(1)} / 5.0</dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">Viajes completados</dt>
              <dd className="text-sm font-medium">{profile.total_rides_completed}</dd>
            </div>
            <div>
              <dt className="text-sm text-neutral-500">Registrado</dt>
              <dd className="text-sm font-medium">{formatDate(profile.created_at)}</dd>
            </div>
          </dl>
        </div>

        {/* Vehicle */}
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">
          <h2 className="text-lg font-bold mb-4">Vehículo</h2>
          {vehicle ? (
            <dl className="space-y-3">
              <div>
                <dt className="text-sm text-neutral-500">Tipo</dt>
                <dd className="text-sm font-medium">{vehicleTypeLabels[vehicle.type] ?? vehicle.type}</dd>
              </div>
              <div>
                <dt className="text-sm text-neutral-500">Marca / Modelo</dt>
                <dd className="text-sm font-medium">{vehicle.make} {vehicle.model}</dd>
              </div>
              <div>
                <dt className="text-sm text-neutral-500">Año</dt>
                <dd className="text-sm font-medium">{vehicle.year}</dd>
              </div>
              <div>
                <dt className="text-sm text-neutral-500">Color</dt>
                <dd className="text-sm font-medium">{vehicle.color}</dd>
              </div>
              <div>
                <dt className="text-sm text-neutral-500">Placa</dt>
                <dd className="text-sm font-medium">{vehicle.plate_number}</dd>
              </div>
              <div>
                <dt className="text-sm text-neutral-500">Capacidad</dt>
                <dd className="text-sm font-medium">{vehicle.capacity} pasajeros</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-neutral-400">Sin vehículo registrado</p>
          )}
        </div>
      </div>

      {/* Documents */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 mb-8">
        <h2 className="text-lg font-bold mb-4">Documentos</h2>
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
                  <p className="text-sm font-medium mb-2">{docTypeLabels[docType]}</p>
                  {doc ? (
                    <div>
                      {url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-[#FF4D00] hover:underline"
                        >
                          Ver documento
                        </a>
                      ) : (
                        <span className="text-sm text-neutral-400">Cargando...</span>
                      )}
                      <p className="text-xs text-neutral-400 mt-1">
                        Subido: {formatDate(doc.uploaded_at)}
                      </p>
                    </div>
                  ) : (
                    <span className="text-sm text-neutral-400">No subido</span>
                  )}
                </div>
              );
            },
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">
        <h2 className="text-lg font-bold mb-4">Acciones</h2>
        <div className="flex flex-wrap gap-3">
          {(status === 'under_review' || status === 'pending_verification' || status === 'rejected' || status === 'suspended') && (
            <button
              onClick={handleApprove}
              disabled={actionLoading}
              className="px-6 py-2.5 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 transition-colors disabled:opacity-50"
            >
              Aprobar
            </button>
          )}
          {(status === 'under_review' || status === 'pending_verification') && (
            <button
              onClick={() => setShowReasonModal('reject')}
              disabled={actionLoading}
              className="px-6 py-2.5 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
            >
              Rechazar
            </button>
          )}
          {status === 'approved' && (
            <button
              onClick={() => setShowReasonModal('suspend')}
              disabled={actionLoading}
              className="px-6 py-2.5 rounded-lg text-sm font-medium bg-orange-500 text-white hover:bg-orange-600 transition-colors disabled:opacity-50"
            >
              Suspender
            </button>
          )}
        </div>
      </div>

      {/* Reason modal */}
      {showReasonModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-bold mb-4">
              {showReasonModal === 'reject' ? 'Motivo de rechazo' : 'Motivo de suspensión'}
            </h3>
            <textarea
              className="w-full border border-neutral-200 rounded-lg p-3 text-sm focus:outline-none focus:border-[#FF4D00]"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explica el motivo..."
            />
            <div className="flex gap-3 mt-4 justify-end">
              <button
                onClick={() => {
                  setShowReasonModal(null);
                  setReason('');
                }}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-neutral-100 text-neutral-700 hover:bg-neutral-200 transition-colors"
              >
                Cancelar
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
                {actionLoading ? 'Procesando...' : 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
