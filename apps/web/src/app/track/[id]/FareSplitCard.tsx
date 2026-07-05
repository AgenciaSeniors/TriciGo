'use client';

// Web port of apps/client/src/components/FareSplitSheet.tsx — requester-side
// fare-split management for an active tricicoin ride. Lists participants,
// invites by phone (findUserByPhone → createSplitInvite), and removes invites.

import { useState, useEffect, useCallback } from 'react';
import { rideService, walletService } from '@tricigo/api';
import { formatTRC, getErrorMessage } from '@tricigo/utils';
import type { RideSplit } from '@tricigo/types';

interface Props {
  rideId: string;
  userId: string;
  estimatedFareTrc: number;
}

export function FareSplitCard({ rideId, userId, estimatedFareTrc }: Props) {
  const [splits, setSplits] = useState<RideSplit[]>([]);
  const [phone, setPhone] = useState('');
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSplits = useCallback(() => {
    rideService.getSplitsForRide(rideId).then(setSplits).catch(() => setSplits([]));
  }, [rideId]);

  useEffect(() => { loadSplits(); }, [loadSplits]);

  const totalParticipants = splits.length + 1; // +1 = requester
  const yourShare = estimatedFareTrc > 0 ? Math.round(estimatedFareTrc / totalParticipants) : 0;

  const handleInvite = async () => {
    if (!phone.trim()) return;
    setInviting(true);
    setError(null);
    try {
      const found = await walletService.findUserByPhone(phone.trim());
      if (!found) { setError('Usuario no encontrado'); return; }
      if (found.id === userId) { setError('No puedes invitarte a ti mismo'); return; }
      if (splits.some((s) => s.user_id === found.id)) { setError('Ese usuario ya está invitado'); return; }
      // Equal split across requester + existing + the new invitee.
      const newPct = Math.round(10000 / (splits.length + 2)) / 100;
      await rideService.createSplitInvite(rideId, found.id, userId, newPct);
      setPhone('');
      loadSplits();
    } catch (err) {
      const msg = getErrorMessage(err);
      setError(msg === 'SPLIT_ONLY_TRICICOIN'
        ? 'Dividir tarifa solo está disponible con TriciCoin'
        : msg);
    } finally {
      setInviting(false);
    }
  };

  const handleRemove = async (split: RideSplit) => {
    try {
      await rideService.removeSplitInvite(rideId, split.id);
      loadSplits();
    } catch {
      setError('No se pudo quitar la invitación');
    }
  };

  const inputStyle: React.CSSProperties = {
    flex: 1, padding: '0.6rem 0.75rem', border: '1px solid var(--border-light)',
    borderRadius: '0.5rem', fontSize: '0.9rem', background: 'var(--bg-card)', color: 'var(--text-primary)',
  };

  return (
    <div className="track-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)' }}>Dividir tarifa</span>
        <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
          Tu parte ~{formatTRC(yourShare)}
        </span>
      </div>

      {/* Participants */}
      {splits.map((split) => (
        <div key={split.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.4rem 0', borderTop: '1px solid var(--border-light)' }}>
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--text-primary)' }}>
              {split.user_name || split.user_phone || '…'}
            </p>
            <p style={{ margin: '0.1rem 0 0', fontSize: '0.76rem', color: 'var(--text-tertiary)' }}>
              {split.accepted_at ? 'Aceptado' : 'Pendiente'} — {split.share_pct}%
            </p>
          </div>
          <button
            onClick={() => handleRemove(split)}
            style={{ background: 'none', border: '1px solid var(--border-light)', borderRadius: '0.4rem', padding: '0.3rem 0.6rem', fontSize: '0.78rem', color: 'var(--text-secondary)', cursor: 'pointer' }}
          >
            Quitar
          </button>
        </div>
      ))}

      {/* Invite by phone */}
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.3rem' }}>
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+53 5XXXXXXX o 6XXXXXXX"
          style={inputStyle}
        />
        <button
          onClick={handleInvite}
          disabled={inviting || !phone.trim()}
          style={{
            padding: '0.6rem 1rem', background: 'var(--primary)', color: '#fff', border: 'none',
            borderRadius: '0.5rem', fontSize: '0.85rem', fontWeight: 600,
            cursor: inviting || !phone.trim() ? 'not-allowed' : 'pointer', opacity: inviting || !phone.trim() ? 0.6 : 1, whiteSpace: 'nowrap',
          }}
        >
          {inviting ? 'Invitando…' : 'Invitar'}
        </button>
      </div>
      {error && <p style={{ margin: 0, fontSize: '0.78rem', color: '#dc2626' }}>{error}</p>}
    </div>
  );
}
