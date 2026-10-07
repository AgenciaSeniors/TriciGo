'use client';

// Support-assisted matching (00628), the web side of the rider app's SearchingView: while the
// ride is searching, the vehicle-type change support proposed (Aceptar / Rechazar), and from
// 45 s the "Pedir ayuda" link, which alerts support and opens WhatsApp with the ride code.
// Without 00628 both stay quiet: getPendingProposal answers null and requestHelp never throws,
// so the WhatsApp link still works.

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { isProposalGone, rideAssistService, type ServiceProposal } from '@tricigo/api';
import { formatCUP, rideShortCode, searchHelpAvailable, SUPPORT_WHATSAPP_PHONE, waMeLink } from '@tricigo/utils';

interface Props {
  rideId: string;
  /** When the search started, in ms: created_at, or scheduled_at for a scheduled ride. */
  startedAtMs: number;
  sharedRide: boolean;
  /** Re-reads the ride, so an accepted change shows without waiting for the 3 s poll. */
  onChanged: () => void;
}

function mmss(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function SupportHelpCard({ rideId, startedAtMs, sharedRide, onChanged }: Props) {
  const { t } = useTranslation('web');
  const [now, setNow] = useState(() => Date.now());
  const [proposal, setProposal] = useState<ServiceProposal | null>(null);
  const [answeredId, setAnsweredId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [helpSent, setHelpSent] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const loadProposal = useCallback(async () => {
    try {
      setProposal(await rideAssistService.getPendingProposal(rideId));
    } catch {
      // Keep what is shown; the next poll retries.
    }
  }, [rideId]);

  useEffect(() => {
    void loadProposal();
    const id = setInterval(loadProposal, 5_000);
    return () => clearInterval(id);
  }, [loadProposal]);

  const typeName = (slug: string) => t(`rides.service_${slug}`, { defaultValue: slug });

  const respond = async (p: ServiceProposal, accept: boolean) => {
    setBusy(true);
    setNotice(null);
    try {
      await rideAssistService.respondProposal(p.id, accept);
      setAnsweredId(p.id);
      if (accept) {
        setNotice(t('track.support_proposal_accepted', { type: typeName(p.to_service_type) }));
        onChanged();
      }
    } catch (err) {
      if (isProposalGone(err)) {
        setAnsweredId(p.id);
        setNotice(t('track.support_proposal_gone'));
      } else {
        setNotice(t('track.support_proposal_failed'));
      }
    } finally {
      setBusy(false);
    }
  };

  const left = proposal ? Math.floor((new Date(proposal.expires_at).getTime() - now) / 1000) : 0;
  const shown = proposal && proposal.id !== answeredId && left > 0 ? proposal : null;
  const showHelp = searchHelpAvailable(Math.floor((now - startedAtMs) / 1000));
  const helpUrl = waMeLink(
    SUPPORT_WHATSAPP_PHONE,
    t('track.support_help_whatsapp_text', { code: rideShortCode(rideId) }),
  );

  if (!shown && !showHelp && !notice) return null;

  return (
    <div className="track-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {shown && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.4rem',
            padding: '0.75rem',
            borderRadius: '0.75rem',
            background: 'rgba(255,77,0,0.08)',
            border: '1px solid var(--primary, #FF4D00)',
          }}
        >
          <span style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            {t('track.support_proposal_title')}
          </span>
          <span style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            {t('track.support_proposal_body', {
              type: typeName(shown.to_service_type),
              price: formatCUP(shown.to_fare_cup),
            })}
          </span>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            {t('track.support_proposal_before', {
              type: typeName(shown.from_service_type),
              price: formatCUP(shown.from_fare_cup),
            })}
          </span>
          {sharedRide && shown.to_service_type !== 'triciclo_basico' && (
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              {t('track.support_proposal_shared_note')}
            </span>
          )}
          <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
            {t('track.support_proposal_expires', { time: mmss(left) })}
          </span>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond(shown, false)}
              style={{
                flex: 1,
                padding: '0.6rem',
                borderRadius: '0.6rem',
                border: '1px solid var(--border)',
                background: 'var(--bg-card)',
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.6 : 1,
                fontSize: '0.82rem',
                fontWeight: 600,
                color: 'var(--text-primary)',
              }}
            >
              {t('track.support_proposal_reject')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond(shown, true)}
              style={{
                flex: 1,
                padding: '0.6rem',
                borderRadius: '0.6rem',
                border: 'none',
                background: 'var(--primary, #FF4D00)',
                color: '#fff',
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.6 : 1,
                fontSize: '0.82rem',
                fontWeight: 700,
              }}
            >
              {t('track.support_proposal_accept')}
            </button>
          </div>
        </div>
      )}

      {showHelp && helpUrl && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {/* A plain link, so the browser opens WhatsApp inside the click (a window.open after
              an await is blocked as a popup). The alert goes out without waiting: the page stays. */}
          <a
            href={helpUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              void rideAssistService.requestHelp(rideId);
              setHelpSent(true);
            }}
            style={{
              display: 'block',
              textAlign: 'center',
              padding: '0.7rem',
              borderRadius: '0.6rem',
              border: '1px solid var(--primary, #FF4D00)',
              background: 'var(--bg-card)',
              color: 'var(--text-primary)',
              fontSize: '0.88rem',
              fontWeight: 700,
              textDecoration: 'none',
            }}
          >
            {helpSent ? t('track.support_help_again') : t('track.support_help_cta')}
          </a>
          {!helpSent && (
            <span style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)', textAlign: 'center' }}>
              {t('track.support_help_hint')}
            </span>
          )}
        </div>
      )}

      {notice && <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{notice}</span>}
    </div>
  );
}
