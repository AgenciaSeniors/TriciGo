import React, { useCallback, useEffect, useState } from 'react';
import { View, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@tricigo/ui/Text';
import { partnerPlaceService } from '@tricigo/api';
import type { PartnerCoupon } from '@tricigo/types';
import { tricigoCategoryEmoji } from '@tricigo/utils';
import { useRefreshOnFocus } from '@/hooks/useRefreshOnFocus';
import type { Tokens } from '@/hooks/useTokens';

/**
 * mm:ss or h:mm:ss remaining, or null once it has expired.
 *
 * Returns null for an unparseable timestamp too: `new Date('x').getTime()` is
 * NaN, and NaN <= 0 is false, so without the isFinite guard a malformed
 * expires_at would render the string "NaN:NaN" as a live countdown.
 *
 * Exported because the ticket screen counts down the same coupon and the two
 * must never disagree about whether it is still alive.
 */
export function remainingLabel(expiresAt: string, now: number): string | null {
  const ms = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

interface Props {
  tokens: Tokens;
  /** Denser variant for the ride-in-progress screen, where space is scarce. */
  compact?: boolean;
}

/**
 * Live-coupon banner. Mounted in BOTH home states — idle and ride-in-progress.
 * The idle-only version breaks exactly where it matters: a passenger who
 * closes the ticket and books another ride gets the home replaced by the
 * tracking view, stranding a live coupon with no way back while its two-hour
 * clock keeps running.
 *
 * `getMyCoupons` returns only unredeemed, unexpired coupons (00533) and
 * swallows its own errors to [], so there is no try/catch here: while the
 * migrations sit unapplied in production this renders nothing at all.
 */
export function PartnerCouponBanner({ tokens, compact = false }: Props) {
  const [coupons, setCoupons] = useState<PartnerCoupon[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setCoupons(await partnerPlaceService.getMyCoupons());
    // Re-anchor the clock to the data. The ticker below only runs while a
    // coupon exists, so a passenger who earns their first one after the app
    // has been open for hours would otherwise get a countdown measured
    // against a mount-time `now` — showing hours that do not exist.
    setNow(Date.now());
  }, []);

  useEffect(() => { void load(); }, [load]);
  // Stale-on-mount: tabs never unmount, so refetch on focus / app foreground.
  // This is also what clears the banner after the counter redeems the coupon
  // or after the passenger taps "Ya lo usé" and navigates back.
  useRefreshOnFocus(load);

  // Drive the countdown. Without this the label freezes at whatever it said
  // on mount — the stale-on-mount class CLAUDE.md tracks permanently.
  //
  // Gated on actually holding a coupon: the overwhelming majority of home
  // screens have none, and an ungated version would run a 1 Hz setState on
  // the always-mounted home tab forever, on phones that cannot spare it.
  const hasCoupons = coupons.length > 0;
  useEffect(() => {
    if (!hasCoupons) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasCoupons]);

  const live = coupons.filter((c) => remainingLabel(c.expires_at, now) !== null);
  if (live.length === 0) return null;

  return (
    <View style={{ gap: 8, marginBottom: compact ? 10 : 14 }}>
      {live.map((c) => {
        const left = remainingLabel(c.expires_at, now);
        return (
          // Layout (`width`) lives in a plain style OBJECT, never inside a
          // Pressable style FUNCTION — RN silently drops layout props from
          // the function form while still applying paint props like opacity,
          // so the bug reads as a flexbox mystery. See CLAUDE.md.
          <Pressable
            key={c.id}
            style={{ width: '100%' }}
            onPress={() => router.push(`/coupon/${c.id}`)}
            android_ripple={{ color: 'rgba(255,255,255,0.18)' }}
            accessibilityRole="button"
            accessibilityLabel={`${c.place_name}: ${c.benefit_title}. ${left}`}
          >
            {({ pressed }) => (
              <View style={{
                width: '100%', opacity: pressed ? 0.92 : 1,
                flexDirection: 'row', alignItems: 'center', gap: 9,
                backgroundColor: tokens.bg.elev1,
                borderColor: 'rgba(255,77,0,0.32)', borderWidth: 1.5,
                borderRadius: compact ? 12 : 14,
                paddingHorizontal: compact ? 10 : 11,
                paddingVertical: compact ? 8 : 10,
              }}>
                <Text style={{ fontSize: compact ? 17 : 20 }}>
                  {tricigoCategoryEmoji(c.category)}
                </Text>
                <View style={{ flexShrink: 1 }}>
                  <Text numberOfLines={1} style={{
                    fontFamily: 'BricolageGrotesque_700Bold',
                    fontSize: compact ? 11.5 : 12, color: tokens.ink.primary,
                  }}>
                    {c.place_name}
                  </Text>
                  <Text numberOfLines={1} style={{
                    fontFamily: 'Inter', fontSize: compact ? 10 : 10.5,
                    fontWeight: '700', color: tokens.accent.orange, marginTop: 1,
                  }}>
                    {c.benefit_title}
                  </Text>
                </View>
                <View style={{
                  marginLeft: 'auto', backgroundColor: tokens.accent.orangeGlow,
                  borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4,
                }}>
                  <Text style={{
                    fontFamily: 'JetBrainsMono_500Medium', fontSize: 9.5,
                    fontWeight: '700', color: tokens.accent.orange,
                  }}>
                    {left}
                  </Text>
                </View>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}
