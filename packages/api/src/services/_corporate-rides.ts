// ============================================================
// TriciGo — why a company would not pay a ride, in words the rider reads
// ============================================================

import { AppError } from '../errors';

// The reasons corporateService.validateCorporateRide returns before the ride is
// asked. They say the same as the server's own messages (00625).
const PRE_CHECK_MESSAGES: Record<string, string> = {
  ACCOUNT_NOT_APPROVED: 'La cuenta de la empresa no está habilitada para pagar viajes.',
  NOT_AN_EMPLOYEE: 'No eres empleado activo de esta empresa.',
  EXCEEDS_RIDE_CAP: 'El viaje supera el tope por viaje que fijó la empresa.',
  EXCEEDS_MONTHLY_BUDGET: 'El viaje supera lo que le queda al presupuesto mensual de la empresa.',
  SERVICE_TYPE_NOT_ALLOWED: 'La empresa no paga viajes en este tipo de vehículo.',
  OUTSIDE_ALLOWED_HOURS: 'La empresa no paga viajes a esta hora.',
};

/** The error for a ride the client-side pre-check turned down, by its reason code. */
export function corporatePreCheckRejection(reason: string | undefined): AppError {
  const code = reason ?? 'CORPORATE_RIDE_REJECTED';
  return new AppError(PRE_CHECK_MESSAGES[code] ?? 'La empresa no puede pagar este viaje.', code, 400);
}

/**
 * The error for a ride tg_rides_validate_corporate turned down (00625): its
 * message is already a Spanish sentence and its DETAIL, which PostgREST returns
 * as `details`, is a code starting with corporate_. Null for any other error.
 */
export function corporateServerRejection(error: {
  message?: string | null;
  details?: string | null;
}): AppError | null {
  const details = error.details;
  if (typeof details !== 'string' || !details.startsWith('corporate_') || !error.message) return null;
  return new AppError(error.message, details.toUpperCase(), 400);
}
