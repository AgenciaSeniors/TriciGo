'use client';

// Web port of apps/client/src/components/SplitInviteCard.tsx.
// Polls the current user's pending fare-split invites and lets them
// accept / decline. Mount it where a rider lands (e.g. /book) so incoming
// invites surface, mirroring the native home screen.

import { useEffect, useState, useCallback } from 'react';
import { rideService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { formatTRC, splitAmountTrc } from '@tricigo/utils';
import type { SplitInvite } from '@tricigo/types';

const POLL_MS = 20_000;
const NOTICE_MS = 8_000;

export function SplitInviteBanner({ userId }: { userId: string | null | undefined }) {
  const { t } = useTranslation('web');
  const [invites, setInvites] = useState<SplitInvite[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  // Which action did not go through, per invite (the invite is still there).
  const [failed, setFailed] = useState<Record<string, 'accept' | 'decline' | undefined>>({});
  // An accepted invite that no longer existed: the ride ended or it was withdrawn.
  const [goneNotice, setGoneNotice] = useState(false);

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      setInvites(await rideService.getMySplitInvites(userId));
    } catch {
      /* silent — no pending invites */
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [userId, load]);

  useEffect(() => {
    if (!goneNotice) return;
    const id = setTimeout(() => setGoneNotice(false), NOTICE_MS);
    return () => clearTimeout(id);
  }, [goneNotice]);

  const handleAccept = async (invite: SplitInvite) => {
    if (!userId) return;
    setBusy((p) => ({ ...p, [invite.id]: true }));
    setFailed((p) => ({ ...p, [invite.id]: undefined }));
    try {
      await rideService.acceptSplitInvite(invite.id, userId);
      setInvites((prev) => prev.filter((i) => i.id !== invite.id));
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'SPLIT_INVITE_GONE') {
        // Nothing left to accept: drop the card and say why.
        setInvites((prev) => prev.filter((i) => i.id !== invite.id));
        setGoneNotice(true);
      } else {
        // The invite is still there: keep it and say the accept did not go through.
        setFailed((p) => ({ ...p, [invite.id]: 'accept' }));
      }
    } finally {
      setBusy((p) => ({ ...p, [invite.id]: false }));
    }
  };

  const handleDecline = async (invite: SplitInvite) => {
    if (!userId) return;
    setBusy((p) => ({ ...p, [invite.id]: true }));
    setFailed((p) => ({ ...p, [invite.id]: undefined }));
    try {
      await rideService.declineSplitInvite(invite.id, userId);
      setInvites((prev) => prev.filter((i) => i.id !== invite.id));
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'SPLIT_ALREADY_ACCEPTED') {
        // Accepted from another device: it is no longer a pending invite.
        setInvites((prev) => prev.filter((i) => i.id !== invite.id));
      } else {
        // The invite is still there: keep it and say the decline did not go through.
        setFailed((p) => ({ ...p, [invite.id]: 'decline' }));
      }
    } finally {
      setBusy((p) => ({ ...p, [invite.id]: false }));
    }
  };

  if (invites.length === 0 && !goneNotice) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1rem' }}>
      {goneNotice && (
        <p role="status" style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
          {t('split.invite_gone', {
            defaultValue: 'Esa invitación ya no está disponible: el viaje terminó o quien te invitó la retiró.',
          })}
        </p>
      )}
      {invites.map((invite) => {
        const isBusy = busy[invite.id] ?? false;
        const fareTrc = invite.rides?.estimated_fare_trc ?? null;
        const estimatedShare = fareTrc != null ? splitAmountTrc(fareTrc, invite.share_pct) : null;
        return (
          <div
            key={invite.id}
            style={{
              background: 'rgba(255,77,0,0.06)', border: '1px solid rgba(255,77,0,0.3)',
              borderRadius: '0.85rem', padding: '1rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.5rem' }}>
              <span style={{
                width: 32, height: 32, borderRadius: '50%', background: 'var(--primary)',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </span>
              <span style={{ fontSize: '0.92rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                {t('split.title', { defaultValue: 'Te invitaron a dividir una tarifa' })}
              </span>
            </div>

            {invite.rides?.pickup_address && (
              <p style={{ margin: '0 0 0.4rem', fontSize: '0.8rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                📍 {invite.rides.pickup_address}
              </p>
            )}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                {t('split.your_share', { pct: invite.share_pct, defaultValue: `Tu parte: ${invite.share_pct}%` })}
              </span>
              {estimatedShare != null && (
                <span style={{ fontSize: '0.92rem', fontWeight: 700, color: 'var(--primary)' }}>~{formatTRC(estimatedShare)}</span>
              )}
            </div>

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={() => handleDecline(invite)}
                disabled={isBusy}
                style={{
                  flex: 1, padding: '0.55rem', background: 'transparent', color: 'var(--text-secondary)',
                  border: '1px solid var(--border-light)', borderRadius: '0.5rem', fontSize: '0.85rem',
                  fontWeight: 600, cursor: isBusy ? 'not-allowed' : 'pointer', opacity: isBusy ? 0.6 : 1,
                }}
              >
                {t('split.decline', { defaultValue: 'Rechazar' })}
              </button>
              <button
                onClick={() => handleAccept(invite)}
                disabled={isBusy}
                style={{
                  flex: 1, padding: '0.55rem', background: 'var(--primary)', color: '#fff',
                  border: 'none', borderRadius: '0.5rem', fontSize: '0.85rem',
                  fontWeight: 600, cursor: isBusy ? 'not-allowed' : 'pointer', opacity: isBusy ? 0.6 : 1,
                }}
              >
                {t('split.accept', { defaultValue: 'Aceptar' })}
              </button>
            </div>
            {failed[invite.id] && (
              <p role="alert" style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', color: 'var(--error, #dc2626)' }}>
                {failed[invite.id] === 'accept'
                  ? t('split.accept_failed', { defaultValue: 'No se pudo aceptar la invitación. Inténtalo de nuevo.' })
                  : t('split.decline_failed', { defaultValue: 'No se pudo rechazar la invitación. Inténtalo de nuevo.' })}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
