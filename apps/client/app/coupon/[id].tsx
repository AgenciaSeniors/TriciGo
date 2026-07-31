import React, { useCallback, useEffect, useState } from 'react';
import { View, Pressable, ActivityIndicator, Linking } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import Toast from 'react-native-toast-message';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { partnerPlaceService } from '@tricigo/api';
import type { PartnerCoupon } from '@tricigo/types';
import { useTranslation } from '@tricigo/i18n';
import { tricigoCategoryEmoji, logger } from '@tricigo/utils';
import { useTokens } from '@/hooks/useTokens';
import { useRefreshOnFocus } from '@/hooks/useRefreshOnFocus';
import { remainingLabel } from '@/components/PartnerCouponBanner';

/**
 * The coupon ticket. This is the thing the passenger holds up at the counter,
 * so the code is the largest element on screen and everything else defers to
 * it. The employee validates it at tricigo.com/v/<their own token>; the
 * passenger's app deliberately cannot know that token (00529 revokes the
 * column from `authenticated`), which is why the hint names the page without
 * linking to it.
 *
 * There is no dedicated fetch-one RPC: get_my_partner_coupons already returns
 * only this passenger's live coupons, and picking one out of that list keeps
 * the data-isolation boundary in exactly one place.
 */
export default function CouponScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { t } = useTranslation('rider');
  const tokens = useTokens();

  const [coupon, setCoupon] = useState<PartnerCoupon | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [redeeming, setRedeeming] = useState(false);

  const load = useCallback(async () => {
    const all = await partnerPlaceService.getMyCoupons();
    setCoupon(all.find((c) => c.id === id) ?? null);
    setNow(Date.now());
    setLoading(false);
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  // The shop can redeem this coupon at the counter while the ticket sits open
  // on screen. Coming back from the background re-checks rather than leaving a
  // spent code looking live.
  useRefreshOnFocus(load);

  // Drive the countdown. Keyed on whether a coupon exists rather than on the
  // coupon object, whose identity changes on every refetch — that would tear
  // the interval down and rebuild it each time focus returns.
  const hasCoupon = coupon !== null;
  useEffect(() => {
    if (!hasCoupon) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasCoupon]);

  /**
   * "Ya lo usé" — the fallback for a shop that cannot open the validation
   * page. redeem_own_partner_coupon answers with exactly three statuses and
   * only one of them is a failure, so they are handled apart. Collapsing them
   * into one red toast would tell a passenger whose coupon was already
   * redeemed at the counter that something broke, and send them back to argue
   * about a coffee they already got.
   */
  const handleUsed = async () => {
    if (!coupon || redeeming) return;
    setRedeeming(true);
    try {
      const verdict = await partnerPlaceService.redeemOwn(coupon.id);

      if (verdict.status === 'redeemed') {
        Toast.show({
          type: 'success',
          text1: t('coupon.marked_used', { defaultValue: 'Cupón marcado como usado' }),
        });
        router.back();
        return;
      }

      if (verdict.status === 'unavailable') {
        // Ordinary, not an error: a double tap, the shop redeeming it first,
        // or the two hours running out while the ticket was open. The coupon
        // is gone either way, so say that and repaint into the gone state.
        Toast.show({
          type: 'info',
          text1: t('coupon.already_gone', { defaultValue: 'Este cupón ya no está disponible' }),
          text2: t('coupon.already_gone_hint', { defaultValue: 'Puede que ya se haya usado o vencido.' }),
        });
        await load();
        return;
      }

      if (verdict.status === 'unauthenticated') {
        // Nothing was burned server-side, so stay put: the code on screen is
        // still good at the counter.
        Toast.show({
          type: 'error',
          text1: t('coupon.session_expired', { defaultValue: 'Tu sesión expiró' }),
          text2: t('coupon.session_expired_hint', { defaultValue: 'Inicia sesión de nuevo para marcarlo.' }),
        });
        return;
      }

      // A status the RPC grows later. Do not claim success we did not get.
      logger.warn('[coupon] unexpected redeemOwn status', { status: verdict.status, couponId: coupon.id });
      Toast.show({
        type: 'error',
        text1: t('coupon.mark_failed', { defaultValue: 'No se pudo marcar el cupón' }),
      });
    } catch (err) {
      // Network or missing RPC. The coupon was NOT consumed — keep the ticket
      // on screen so it can still be shown at the counter.
      logger.error('[coupon] redeemOwn failed', { error: String(err), couponId: coupon.id });
      Toast.show({
        type: 'error',
        text1: t('coupon.mark_failed', { defaultValue: 'No se pudo marcar el cupón' }),
        text2: t('coupon.mark_failed_hint', { defaultValue: 'Tu cupón sigue activo. Muéstralo en el local.' }),
      });
    } finally {
      setRedeeming(false);
    }
  };

  if (loading) {
    return (
      <Screen bg="cuban" padded>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={tokens.accent.orange} />
        </View>
      </Screen>
    );
  }

  const left = coupon ? remainingLabel(coupon.expires_at, now) : null;

  // Gone or expired. Say so honestly — and say the useful part: because there
  // is no frequency cap, the next ride there issues a fresh one. Nothing was
  // permanently lost.
  if (!coupon || left === null) {
    return (
      <Screen bg="cuban" padded scroll>
        <ScreenHeader title={t('coupon.title', { defaultValue: 'Tu cupón' })} onBack={() => router.back()} />
        <View style={{ alignItems: 'center', marginTop: 48, gap: 10 }}>
          <Text style={{ fontSize: 42 }}>⌛</Text>
          <Text style={{ fontFamily: 'BricolageGrotesque_700Bold', fontSize: 18, color: tokens.ink.primary, textAlign: 'center' }}>
            {t('coupon.expired_title', { defaultValue: 'Este cupón ya no está disponible' })}
          </Text>
          <Text style={{ fontFamily: 'Inter', fontSize: 13, color: tokens.ink.subtle, textAlign: 'center', lineHeight: 19 }}>
            {t('coupon.expired_body', { defaultValue: 'Tu próximo viaje a ese lugar te da uno nuevo.' })}
          </Text>
        </View>
      </Screen>
    );
  }

  // Half-circle bites at the fold, clipped by the card's overflow: hidden.
  // Painted in the page background so they read as holes, not as dots.
  const notch = {
    position: 'absolute' as const, top: -9, width: 18, height: 18, borderRadius: 999,
    backgroundColor: tokens.bg.paper, borderWidth: 1, borderColor: tokens.line,
  };

  return (
    <Screen bg="cuban" padded scroll>
      <ScreenHeader title={t('coupon.title', { defaultValue: 'Tu cupón' })} onBack={() => router.back()} />

      <View style={{
        backgroundColor: tokens.bg.elev1, borderColor: tokens.line, borderWidth: 1,
        borderRadius: 18, overflow: 'hidden', marginTop: 8,
      }}>
        <View style={{ padding: 18, alignItems: 'center' }}>
          <Text style={{ fontSize: 34 }}>{tricigoCategoryEmoji(coupon.category)}</Text>
          <Text style={{
            fontFamily: 'BricolageGrotesque_700Bold', fontSize: 18,
            color: tokens.ink.primary, marginTop: 7, textAlign: 'center',
          }}>
            {coupon.place_name}
          </Text>
          <Text style={{
            fontFamily: 'Inter', fontSize: 14, fontWeight: '700',
            color: tokens.accent.orange, marginTop: 6, textAlign: 'center', lineHeight: 19,
          }}>
            {coupon.benefit_description}
          </Text>
        </View>

        <View style={{ height: 1, marginHorizontal: 14, borderTopWidth: 2, borderStyle: 'dashed', borderColor: tokens.line }}>
          <View style={[notch, { left: -24 }]} />
          <View style={[notch, { right: -24 }]} />
        </View>

        <View style={{ padding: 18, alignItems: 'center' }}>
          <Text style={{
            fontFamily: 'JetBrainsMono_600SemiBold', fontSize: 9,
            letterSpacing: 2, color: tokens.ink.subtle, marginBottom: 8,
          }}>
            {t('coupon.show_code', { defaultValue: 'MUESTRA ESTE CÓDIGO' })}
          </Text>
          {/* The single most important pixel on the screen: read aloud across a
              counter, or typed in by an employee on a cheap phone. */}
          <Text style={{
            fontFamily: 'JetBrainsMono_600SemiBold', fontSize: 30,
            letterSpacing: 3, color: tokens.ink.primary,
          }}>
            TG-{coupon.code}
          </Text>
          <View style={{
            marginTop: 13, backgroundColor: tokens.accent.orangeGlow,
            borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6,
          }}>
            <Text style={{
              fontFamily: 'JetBrainsMono_500Medium', fontSize: 12,
              fontWeight: '700', color: tokens.accent.orange,
            }}>
              ⏱ {left}
            </Text>
          </View>
          <Text style={{
            fontFamily: 'Inter', fontSize: 11, color: tokens.ink.subtle,
            marginTop: 12, textAlign: 'center', lineHeight: 16,
          }}>
            {t('coupon.validate_hint', { defaultValue: 'El negocio puede validarlo en tricigo.com/v' })}
          </Text>
        </View>
      </View>

      {coupon.terms ? (
        <Text style={{ fontFamily: 'Inter', fontSize: 11, color: tokens.ink.subtle, marginTop: 12, lineHeight: 16 }}>
          {coupon.terms}
        </Text>
      ) : null}

      {coupon.address ? (
        <Text style={{ fontFamily: 'Inter', fontSize: 12, color: tokens.ink.secondary, marginTop: 12 }}>
          {coupon.address}{coupon.hours ? ` · ${coupon.hours}` : ''}
        </Text>
      ) : null}

      {coupon.phone ? (
        <Pressable
          onPress={() => Linking.openURL(`tel:${coupon.phone}`)}
          style={{ marginTop: 6 }}
          accessibilityRole="button"
          accessibilityLabel={`${t('coupon.call', { defaultValue: 'Llamar' })} ${coupon.place_name}`}
        >
          <Text style={{ fontFamily: 'Inter', fontSize: 12, color: tokens.accent.orange }}>{coupon.phone}</Text>
        </Pressable>
      ) : null}

      <Pressable
        onPress={handleUsed}
        disabled={redeeming}
        style={{
          marginTop: 22, borderWidth: 1, borderColor: tokens.line,
          borderRadius: 13, paddingVertical: 13, alignItems: 'center',
          opacity: redeeming ? 0.6 : 1,
        }}
        accessibilityRole="button"
        accessibilityState={{ disabled: redeeming, busy: redeeming }}
      >
        <Text style={{ fontFamily: 'Inter', fontSize: 13, fontWeight: '600', color: tokens.ink.secondary }}>
          {t('coupon.mark_used', { defaultValue: 'Ya lo usé' })}
        </Text>
      </Pressable>
      <View style={{ height: 32 }} />
    </Screen>
  );
}
