/**
 * HomeBottomSheet v3 — Cuban Modern edition (post PR #235).
 *
 * Mantiene la estructura v2: 3 estados (OFFLINE / ONLINE IDLE / ON-BREAK)
 * + banners (ineligible, selfie, autoNav, fatigue) + storytelling hero
 * earnings + smart suggestion + footer (Pausar/Desconectar).
 *
 * Cambios visuales:
 *  - Paleta midnightEmber → cubanLight/cubanDark dinámica (useColorScheme)
 *  - CTA "Conectarme" → LinearGradient orange→warm-gold + GLOW_CTA halo +
 *    spring scale + Inter_800ExtraBold 18pt
 *  - Hero earnings card → 3 capas LinearGradient (base + orange-glow radial
 *    + content) con monto Inter_800ExtraBold 36pt tabular-nums
 *  - Status pill → alpha bg semántico + dot pulsing
 *  - Suggestion card → palette.bg.elev1 con accent border warm
 *  - Banners → bg alpha de su estado + Inter typography
 *  - Footer Pausar/Desconectar → pills discretas Cuban
 *  - Greeting → mismo storytelling (sentence-case + nombre + recap ayer)
 *
 * Lógica intacta: todos los snap points, callbacks, haptics, accessibility,
 * desktop sidebar fallback, useEffect del status dot pulse.
 */
import React, { useRef } from 'react';
import {
  View,
  Pressable,
  Animated,
  StyleSheet,
  Text as RNText,
  useColorScheme,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { DraggableSheet } from '@tricigo/ui/DraggableSheet';
import { Ionicons } from '@expo/vector-icons';
import { cubanLight, cubanDark, colors } from '@tricigo/theme';
import { triggerHaptic } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { useResponsive } from '@tricigo/ui/hooks/useResponsive';
import { router } from 'expo-router';

// ─── Constants ────────────────────────────────────────────────────────────────

const TABULAR: { fontVariant: ('tabular-nums')[] } = { fontVariant: ['tabular-nums'] };

// Semantic colors (Cuban-agnostic — same in light + dark)
const STATE_SUCCESS = '#22C55E';
const STATE_WARNING = '#F59E0B';
const STATE_DANGER = '#EF4444';
const STATE_INFO = '#3B82F6';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface NearestHotspot {
  lat: number;
  lng: number;
  distance: number;
  liveCount: number;
  source?: 'live' | 'popular';
}

export interface HomeBottomSheetProps {
  // ── State ──
  isOnline: boolean;
  isOnBreak: boolean;
  isIneligible: boolean;
  toggling: boolean;
  togglingBreak: boolean;
  needsSelfieCheck: boolean;
  isSelfieProcessing: boolean;
  selfieLoading: boolean;
  /** OS notification permission is not granted — no ride offer can arrive. */
  notificationsBlocked: boolean;

  // ── Data ──
  todayEarnings: { amount: number; trips: number };
  yesterdayEarnings: { amount: number; trips: number } | null;
  userName?: string;

  // ── Auto-nav ──
  navCountdown: number | null;
  nearestHotZone: { lat: number; lng: number; distance: number } | null;

  // ── Smart suggestion ──
  nearestHotspot: NearestHotspot | null;

  // ── Fatigue ──
  fatigueLevel: 'none' | 'soft' | 'firm';
  sessionHours: number;

  // ── Callbacks ──
  onToggleOnline: () => void;
  onToggleBreak: () => void;
  onSubmitSelfie: () => void;
  onCancelAutoNav: () => void;
  onGoToSuggestion: (lat: number, lng: number) => void;
  /** Deep-link to system Settings — the only way back after an OS denial. */
  onOpenNotificationSettings: () => void;

  // ── Animations ──
  ctaScaleAnim: Animated.Value;
  onCtaPressIn: () => void;
  onCtaPressOut: () => void;
}

// ─── Snap configuration ───────────────────────────────────────────────────────

// Two ladders, because the lowest snap means opposite things per state.
//
// ONLINE: the driver is working and wants the map. Collapsing to a sliver is
// useful — everything they need (trip card, offers) arrives as an overlay.
//
// OFFLINE: the sheet holds "Conectarme", the ONE control that starts a shift,
// and it sits below the greeting and any banners. At 18% it scrolls out of
// sight and the driver is left staring at a blank white panel with a
// #CBD5E1-on-white grab handle as the only hint that anything is hidden. That
// is a dead end: no offers, no explanation, and the CTA is not reachable from
// anywhere else on the screen. Reported from the field 2026-07-31 with a
// screenshot of exactly that empty panel — the driver had been approved for
// nine hours and had never once been online.
//
// So while offline the ladder starts high enough to always show the CTA. The
// driver can still pull it up for more, just not down past the thing they came
// to tap. `primary-action`: the screen's single primary CTA must be reachable
// in every state the screen can be in.
const SNAP_POINTS_ONLINE: [string, string, string] = ['18%', '45%', '85%'];
const SNAP_POINTS_OFFLINE: [string, string, string] = ['45%', '65%', '85%'];
const DEFAULT_SNAP_INDEX_ONLINE = 1;
// Offline opens at the floor: it already clears the CTA, and starting higher
// would bury the map the driver uses to decide whether it is worth going out.
const DEFAULT_SNAP_INDEX_OFFLINE = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getTimeOfDayKey(): 'morning' | 'afternoon' | 'evening' {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 19) return 'afternoon';
  return 'evening';
}

function compareEarnings(today: number, yesterday: number | null): {
  delta: number | null;
  symbol: '↑' | '↓' | '→' | null;
  color: 'success' | 'warning' | 'neutral' | null;
} {
  if (yesterday == null || yesterday <= 0) return { delta: null, symbol: null, color: null };
  const ratio = today / yesterday;
  const pct = Math.round((ratio - 1) * 100);
  if (Math.abs(pct) < 3) return { delta: 0, symbol: '→', color: 'neutral' };
  if (pct > 0) return { delta: pct, symbol: '↑', color: 'success' };
  return { delta: pct, symbol: '↓', color: 'warning' };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function HomeBottomSheet(props: HomeBottomSheetProps) {
  const { t } = useTranslation('driver');
  const { isDesktop } = useResponsive();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;

  const content = <SheetContent {...props} t={t} palette={palette} isDark={isDark} />;

  if (isDesktop) {
    return (
      <View
        style={[
          styles.desktopSidebar,
          {
            backgroundColor: palette.bg.elev1,
            borderLeftColor: palette.line,
            borderLeftWidth: 1,
          },
        ]}
      >
        <View style={styles.desktopSidebarInner}>{content}</View>
      </View>
    );
  }

  return (
    <DraggableSheet
      // Remount on the online⇄offline flip so the sheet re-snaps to the new
      // ladder's initial index. Without the key it keeps whatever index the
      // driver last dragged to, which is how the CTA got buried in the first
      // place: drag down while online, go offline, and index 0 now means 18%.
      key={props.isOnline ? 'sheet-online' : 'sheet-offline'}
      snapPoints={props.isOnline ? SNAP_POINTS_ONLINE : SNAP_POINTS_OFFLINE}
      initialIndex={props.isOnline ? DEFAULT_SNAP_INDEX_ONLINE : DEFAULT_SNAP_INDEX_OFFLINE}
      theme={isDark ? 'dark' : 'light'}
      scrollable
    >
      <View style={{ backgroundColor: palette.bg.paper, flex: 1, paddingHorizontal: 16, paddingTop: 4 }}>
        {content}
      </View>
    </DraggableSheet>
  );
}

// ─── Inner content ─────────────────────────────────────────────────────────────

// Structural type so cubanLight and cubanDark both fit (their literal hex
// types differ — using `typeof cubanLight` would fail for cubanDark).
type Palette = {
  bg: { paper: string; elev1: string; elev2: string };
  ink: { primary: string; secondary: string; subtle: string };
  accent: { orange: string; orangeGlow: string; warm: string; dusk: string };
  line: string;
  shadow: { card: string; hero: string };
};

interface SheetContentProps extends HomeBottomSheetProps {
  t: (key: string, opts?: Record<string, unknown>) => string;
  palette: Palette;
  isDark: boolean;
}

function SheetContent({
  isOnline,
  isOnBreak,
  isIneligible,
  toggling,
  togglingBreak,
  needsSelfieCheck,
  isSelfieProcessing,
  selfieLoading,
  notificationsBlocked,
  todayEarnings,
  yesterdayEarnings,
  userName,
  navCountdown,
  nearestHotZone,
  nearestHotspot,
  fatigueLevel,
  sessionHours,
  onToggleOnline,
  onToggleBreak,
  onSubmitSelfie,
  onCancelAutoNav,
  onGoToSuggestion,
  onOpenNotificationSettings,
  ctaScaleAnim,
  onCtaPressIn,
  onCtaPressOut,
  t,
  palette,
  isDark,
}: SheetContentProps) {
  // Shadows
  const GLOW_CTA = {
    shadowColor: '#FF4D00',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 10,
  };
  const HERO_SHADOW = {
    shadowColor: '#FF4D00',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: isDark ? 0.22 : 0.12,
    shadowRadius: 18,
    elevation: 8,
  };
  const CARD_SHADOW = {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: isDark ? 0.3 : 0.04,
    shadowRadius: 6,
    elevation: 2,
  };

  // ── Status dot pulse ──
  const statusDotPulse = useRef(new Animated.Value(0.6)).current;
  React.useEffect(() => {
    if (isOnline && !isOnBreak) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(statusDotPulse, { toValue: 1, duration: 800, useNativeDriver: true }),
          Animated.timing(statusDotPulse, { toValue: 0.6, duration: 800, useNativeDriver: true }),
        ]),
      ).start();
    } else {
      statusDotPulse.stopAnimation();
      statusDotPulse.setValue(1);
    }
  }, [isOnline, isOnBreak, statusDotPulse]);

  // ── Banners ──────────────────────────────────────────────────
  const banners = (
    <>
      {/* First on purpose: with notifications off, no ride offer can reach
          this driver at all, so every other banner is secondary. Shown while
          offline too — it is the thing to fix BEFORE starting a shift. */}
      {notificationsBlocked && (
        <Banner
          variant="danger"
          icon="notifications-off-outline"
          message={t('home.notifications_blocked_title', {
            defaultValue: 'No vas a recibir avisos de viaje',
          })}
          subtitle={t('home.notifications_blocked_subtitle', {
            defaultValue: 'Las notificaciones de TriciGo están desactivadas en tu teléfono.',
          })}
          actionLabel={t('home.notifications_blocked_action', {
            defaultValue: 'Abrir Ajustes',
          })}
          onActionPress={onOpenNotificationSettings}
          palette={palette}
        />
      )}
      {isIneligible && (
        <Banner
          variant="danger"
          icon="warning-outline"
          message={t('home.ineligible_banner')}
          // The message tells the driver to recharge; until now it gave them
          // no way to get there, on the one screen where they are blocked
          // from working. The eligibility check refetches on focus, so
          // returning from the Wallet clears the banner on its own.
          //
          // `home.ineligible_recharge` already existed — written and
          // translated into es/en/pt, and referenced by nothing. The label
          // for this button was authored; the button was never built.
          actionLabel={t('home.ineligible_recharge')}
          onActionPress={() => router.push('/(tabs)/wallet')}
          palette={palette}
        />
      )}
      {(needsSelfieCheck || isSelfieProcessing) && (
        <Banner
          variant="warning"
          icon="camera-outline"
          message={t('verification.selfie_required')}
          actionLabel={
            !isSelfieProcessing
              ? t('verification.take_selfie')
              : t('verification.processing')
          }
          onActionPress={!isSelfieProcessing ? onSubmitSelfie : undefined}
          actionDisabled={selfieLoading || isSelfieProcessing}
          palette={palette}
        />
      )}
      {navCountdown !== null && nearestHotZone && (
        <Banner
          variant="info"
          icon="navigate"
          message={t('home.high_demand_zone', {
            seconds: navCountdown,
            defaultValue: 'Navegando a zona en {{seconds}}s',
          })}
          subtitle={t('home.active_zone_nearby', {
            distance: nearestHotZone.distance,
          })}
          actionLabel={t('home.stay_here', { defaultValue: 'Quedar' })}
          onActionPress={onCancelAutoNav}
          palette={palette}
        />
      )}
      {fatigueLevel !== 'none' && isOnline && !isOnBreak && (
        <Banner
          variant={fatigueLevel === 'firm' ? 'danger' : 'warning'}
          icon={fatigueLevel === 'firm' ? 'warning' : 'time-outline'}
          message={
            fatigueLevel === 'firm'
              ? t('home.fatigue_firm_title', {
                  hours: sessionHours.toFixed(1),
                  defaultValue: '{{hours}}h seguidas — para por seguridad',
                })
              : t('home.fatigue_soft_title', {
                  hours: sessionHours.toFixed(1),
                  defaultValue: 'Llevas {{hours}}h manejando — considera un descanso',
                })
          }
          subtitle={
            fatigueLevel === 'firm'
              ? t('home.fatigue_firm_subtitle', {
                  defaultValue: 'Manejar fatigado es peligroso para ti y los pasajeros',
                })
              : t('home.fatigue_soft_subtitle', {
                  defaultValue: 'Un descanso de 15 min mejora reflejos y humor con los riders',
                })
          }
          actionLabel={t('home.fatigue_take_break', { defaultValue: 'Tomar descanso' })}
          onActionPress={onToggleBreak}
          palette={palette}
        />
      )}
    </>
  );

  // ── State 1: OFFLINE ──────────────────────────────────────────
  if (!isOnline) {
    const tod = getTimeOfDayKey();
    const greetingKey = `home.greeting_${tod}`;
    const greetingDefault =
      tod === 'morning' ? 'Buen día' :
      tod === 'afternoon' ? 'Buenas tardes' :
      'Buenas noches';
    const firstName = userName ? (userName.split(' ')[0] ?? userName) : null;
    const greetingFull = firstName
      ? `${t(greetingKey, { defaultValue: greetingDefault })}, ${firstName}`
      : t(greetingKey, { defaultValue: greetingDefault });

    return (
      <View style={styles.sheetContent}>
        {/* Greeting */}
        <RNText
          style={{
            fontFamily: 'Inter_700Bold',
            fontSize: 22,
            letterSpacing: -0.3,
            color: palette.ink.primary,
            marginBottom: 16,
          }}
        >
          {greetingFull}
        </RNText>

        {banners}

        {/* Primary CTA — Cuban gradient + glow */}
        <Animated.View style={{ transform: [{ scale: ctaScaleAnim }], ...GLOW_CTA }}>
          <Pressable
            onPressIn={onCtaPressIn}
            onPressOut={onCtaPressOut}
            onPress={() => { triggerHaptic('heavy'); onToggleOnline(); }}
            disabled={toggling || isIneligible}
            accessibilityRole="switch"
            accessibilityState={{ checked: false, disabled: toggling || isIneligible }}
            accessibilityLabel={t('home.go_online', { defaultValue: 'Conectarme' })}
            style={[
              { borderRadius: 20, overflow: 'hidden' },
              (toggling || isIneligible) && styles.disabled,
            ]}
          >
            <LinearGradient
              colors={[colors.brand.orange, palette.accent.warm]}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                paddingVertical: 18,
                paddingHorizontal: 16,
                minHeight: 60,
              }}
            >
              <Ionicons name="power" size={22} color="#FFFFFF" />
              <RNText
                style={{
                  color: '#FFFFFF',
                  fontFamily: 'Inter_800ExtraBold',
                  fontSize: 17,
                  marginLeft: 10,
                  letterSpacing: 0.3,
                }}
              >
                {toggling
                  ? t('home.connecting', { defaultValue: 'Conectando…' })
                  : t('home.go_online', { defaultValue: 'Conectarme' })}
              </RNText>
            </LinearGradient>
          </Pressable>
        </Animated.View>

        {/* Yesterday recap */}
        {yesterdayEarnings && yesterdayEarnings.amount > 0 && (
          <RNText
            style={{
              fontSize: 13,
              color: palette.ink.secondary,
              textAlign: 'center',
              marginTop: 16,
              ...TABULAR,
            }}
          >
            {t('home.yesterday_recap', {
              amount: yesterdayEarnings.amount.toLocaleString(),
              trips: yesterdayEarnings.trips,
              defaultValue: 'Ayer ganaste ${{amount}} · {{trips}} viajes',
            })}
          </RNText>
        )}
      </View>
    );
  }

  // ── State 2 & 3: ONLINE (IDLE or ON-BREAK) ─────────────────────
  const cmp = compareEarnings(todayEarnings.amount, yesterdayEarnings?.amount ?? null);

  return (
    <View style={styles.sheetContent}>
      {banners}

      {/* Status pill */}
      <StatusPill
        variant={isOnBreak ? 'break' : 'online'}
        pulseAnim={!isOnBreak ? statusDotPulse : undefined}
        label={
          isOnBreak
            ? t('home.break_status', { defaultValue: 'En descanso · No recibes solicitudes' })
            : t('home.idle_status', { defaultValue: 'En línea · Buscando viajes' })
        }
        palette={palette}
      />

      {/* Hero earnings card — Cuban gradient + orange glow corner */}
      <View
        style={[
          { borderRadius: 20, overflow: 'hidden', marginTop: 4, ...HERO_SHADOW },
          isOnBreak && { opacity: 0.6 },
        ]}
      >
        <LinearGradient
          colors={isDark ? ['#11172A', '#18203A'] : ['#FFFFFF', '#FFFBF5']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFillObject}
        />
        <LinearGradient
          colors={[palette.accent.orangeGlow, 'transparent']}
          start={{ x: 1, y: 0 }}
          end={{ x: 0.3, y: 0.7 }}
          style={{ position: 'absolute', top: 0, right: 0, width: 160, height: 160 }}
          pointerEvents="none"
        />
        <View style={{ padding: 18 }}>
          <RNText
            style={{
              fontSize: 11,
              fontWeight: '700',
              letterSpacing: 1.6,
              color: palette.ink.secondary,
              textTransform: 'uppercase',
              marginBottom: 6,
            }}
          >
            {t('home.earnings_today_label', { defaultValue: 'Hoy' })}
          </RNText>
          <RNText
            style={{
              fontFamily: 'Inter_800ExtraBold',
              fontSize: 36,
              letterSpacing: -1,
              lineHeight: 40,
              color: palette.ink.primary,
              ...TABULAR,
            }}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            ${todayEarnings.amount.toLocaleString()}
          </RNText>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 8, gap: 6 }}>
            {cmp.symbol && cmp.delta !== null && (
              <RNText
                style={{
                  fontSize: 13,
                  fontWeight: '700',
                  color:
                    cmp.color === 'success' ? STATE_SUCCESS :
                    cmp.color === 'warning' ? STATE_WARNING :
                    palette.ink.secondary,
                  ...TABULAR,
                }}
              >
                {cmp.symbol} {Math.abs(cmp.delta)}% {t('home.compare_yesterday', { defaultValue: 'vs ayer' })}
              </RNText>
            )}
            {cmp.symbol && (
              <RNText style={{ fontSize: 13, color: palette.ink.subtle }}>·</RNText>
            )}
            <RNText style={{ fontSize: 13, color: palette.ink.secondary, ...TABULAR }}>
              {t('home.trips_count', { count: todayEarnings.trips, defaultValue: '{{count}} viajes' })}
            </RNText>
          </View>
        </View>
      </View>

      {/* On-break: simplified controls */}
      {isOnBreak ? (
        <>
          <Animated.View style={{ transform: [{ scale: ctaScaleAnim }], marginTop: 12, ...GLOW_CTA }}>
            <Pressable
              onPressIn={onCtaPressIn}
              onPressOut={onCtaPressOut}
              onPress={() => { triggerHaptic('medium'); onToggleBreak(); }}
              disabled={togglingBreak}
              accessibilityRole="button"
              accessibilityLabel={t('home.resume_work', { defaultValue: 'Reanudar trabajo' })}
              style={[
                { borderRadius: 20, overflow: 'hidden' },
                togglingBreak && styles.disabled,
              ]}
            >
              <LinearGradient
                colors={[colors.brand.orange, palette.accent.warm]}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  paddingVertical: 16,
                  paddingHorizontal: 16,
                  minHeight: 56,
                }}
              >
                <Ionicons name="play" size={18} color="#FFFFFF" />
                <RNText
                  style={{
                    color: '#FFFFFF',
                    fontFamily: 'Inter_800ExtraBold',
                    fontSize: 16,
                    marginLeft: 8,
                    letterSpacing: 0.3,
                  }}
                >
                  {togglingBreak
                    ? t('home.resuming', { defaultValue: 'Reanudando…' })
                    : t('home.resume_work', { defaultValue: 'Reanudar trabajo' })}
                </RNText>
              </LinearGradient>
            </Pressable>
          </Animated.View>

          <Pressable
            onPress={() => { triggerHaptic('light'); onToggleOnline(); }}
            disabled={toggling}
            style={{
              marginTop: 14,
              alignItems: 'center',
              justifyContent: 'center',
              paddingVertical: 14,
              minHeight: 44,
            }}
            accessibilityRole="button"
            accessibilityLabel={t('home.disconnect_full', { defaultValue: 'Desconectar completamente' })}
          >
            <RNText
              style={{
                fontSize: 13,
                color: palette.ink.subtle,
                textDecorationLine: 'underline',
              }}
            >
              {t('home.disconnect_full', { defaultValue: 'Desconectar completamente' })}
            </RNText>
          </Pressable>
        </>
      ) : (
        <>
          {/* Smart suggestion card */}
          {nearestHotspot && (nearestHotspot.liveCount > 0 || nearestHotspot.source === 'popular') && (
            <Pressable
              onPress={() => {
                triggerHaptic('medium');
                onGoToSuggestion(nearestHotspot.lat, nearestHotspot.lng);
              }}
              style={({ pressed }) => [
                {
                  padding: 14,
                  marginTop: 10,
                  borderRadius: 16,
                  borderWidth: 1,
                  borderColor: palette.accent.warm,
                  backgroundColor: palette.bg.elev1,
                  ...CARD_SHADOW,
                },
                pressed && { opacity: 0.85, transform: [{ scale: 0.99 }] },
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('home.suggestion_a11y', {
                distance: nearestHotspot.distance,
                count: nearestHotspot.liveCount,
                defaultValue: 'Ir a zona caliente a {{distance}} km con {{count}} viajes esperando',
              })}
            >
              <RNText
                style={{
                  fontSize: 11,
                  fontWeight: '700',
                  letterSpacing: 1.4,
                  color: palette.accent.warm,
                  textTransform: 'uppercase',
                  marginBottom: 4,
                }}
              >
                {t('home.suggestion_label', { defaultValue: 'Sugerencia' })}
              </RNText>
              <RNText
                style={{
                  fontSize: 15,
                  fontWeight: '600',
                  color: palette.ink.primary,
                }}
              >
                {nearestHotspot.source === 'popular' && nearestHotspot.liveCount === 0
                  ? t('home.suggestion_body_popular', {
                      distance: nearestHotspot.distance,
                      defaultValue: 'Zona popular a {{distance}} km',
                    })
                  : t('home.suggestion_body', {
                      distance: nearestHotspot.distance,
                      count: nearestHotspot.liveCount,
                      defaultValue: 'Hotspot a {{distance}} km · {{count}} viajes activos',
                    })}
              </RNText>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8 }}>
                <Ionicons name="arrow-forward" size={13} color={colors.brand.orange} />
                <RNText
                  style={{
                    fontSize: 12,
                    color: colors.brand.orange,
                    fontWeight: '700',
                  }}
                >
                  {t('home.suggestion_go', { defaultValue: 'Ir hacia allá' })}
                </RNText>
              </View>
            </Pressable>
          )}

          {/* Footer: Pausar + Desconectar */}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
            <Pressable
              onPress={() => { triggerHaptic('light'); onToggleBreak(); }}
              disabled={togglingBreak}
              style={[
                styles.footerAction,
                {
                  borderWidth: 1,
                  borderColor: palette.line,
                  backgroundColor: 'transparent',
                  borderRadius: 16,
                },
                togglingBreak && styles.disabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('home.pause', { defaultValue: 'Pausar' })}
            >
              <Ionicons name="pause" size={16} color={palette.ink.secondary} />
              <RNText
                style={{
                  fontSize: 14,
                  fontWeight: '600',
                  color: palette.ink.secondary,
                  marginLeft: 6,
                }}
              >
                {t('home.pause', { defaultValue: 'Pausar' })}
              </RNText>
            </Pressable>
            <Pressable
              onPress={() => { triggerHaptic('medium'); onToggleOnline(); }}
              disabled={toggling}
              style={[
                styles.footerAction,
                {
                  backgroundColor: palette.bg.elev2,
                  borderRadius: 16,
                },
                toggling && styles.disabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('home.disconnect', { defaultValue: 'Desconectar' })}
            >
              <Ionicons name="power" size={16} color={STATE_DANGER} />
              <RNText
                style={{
                  fontSize: 14,
                  fontWeight: '600',
                  color: STATE_DANGER,
                  marginLeft: 6,
                }}
              >
                {toggling
                  ? t('home.disconnecting', { defaultValue: 'Desconectando…' })
                  : t('home.disconnect', { defaultValue: 'Desconectar' })}
              </RNText>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

// ─── Subcomponents ─────────────────────────────────────────────────────────────

interface BannerProps {
  variant: 'danger' | 'warning' | 'info';
  icon: keyof typeof Ionicons.glyphMap;
  message: string;
  subtitle?: string;
  actionLabel?: string;
  onActionPress?: () => void;
  actionDisabled?: boolean;
  palette: Palette;
}

function Banner({
  variant,
  icon,
  message,
  subtitle,
  actionLabel,
  onActionPress,
  actionDisabled,
  palette,
}: BannerProps) {
  const accent =
    variant === 'danger' ? STATE_DANGER :
    variant === 'warning' ? STATE_WARNING :
    STATE_INFO;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        backgroundColor: `${accent}1A`,
        borderWidth: 1,
        borderColor: `${accent}4D`,
        borderRadius: 12,
        padding: 12,
        marginBottom: 10,
        gap: 8,
      }}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Ionicons name={icon} size={16} color={accent} style={{ marginTop: 1 }} />
      <View style={{ flex: 1 }}>
        <RNText style={{ fontSize: 13, fontWeight: '600', color: accent }}>
          {message}
        </RNText>
        {subtitle && (
          <RNText style={{ fontSize: 11, color: palette.ink.secondary, marginTop: 2 }}>
            {subtitle}
          </RNText>
        )}
        {actionLabel && onActionPress && (
          <Pressable
            onPress={onActionPress}
            disabled={actionDisabled}
            hitSlop={14}
            accessibilityRole="button"
          >
            <RNText
              style={{
                fontSize: 12,
                color: accent,
                fontWeight: '700',
                textDecorationLine: 'underline',
                marginTop: 4,
                opacity: actionDisabled ? 0.5 : 1,
              }}
            >
              {actionLabel}
            </RNText>
          </Pressable>
        )}
      </View>
    </View>
  );
}

interface StatusPillProps {
  variant: 'online' | 'break';
  label: string;
  pulseAnim?: Animated.Value;
  palette: Palette;
}

function StatusPill({ variant, label, pulseAnim, palette }: StatusPillProps) {
  const dotColor = variant === 'online' ? STATE_SUCCESS : STATE_WARNING;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        alignSelf: 'flex-start',
        backgroundColor: `${dotColor}22`,
        paddingVertical: 5,
        paddingHorizontal: 12,
        borderRadius: 9999,
        marginBottom: 12,
      }}
      accessibilityRole="text"
      accessibilityLabel={label}
    >
      <Animated.View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: dotColor,
          opacity: pulseAnim ?? 1,
        }}
      />
      <RNText
        style={{
          fontSize: 12,
          fontWeight: '700',
          color: dotColor,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        {label}
      </RNText>
    </View>
  );
}

// ─── Styles (layout only) ──────────────────────────────────────────────────────

const styles = StyleSheet.create({
  desktopSidebar: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: 400,
    zIndex: 20,
  },
  desktopSidebarInner: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 24,
  },
  sheetContent: {
    paddingTop: 4,
  },
  footerAction: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    minHeight: 48,
  },
  disabled: {
    opacity: 0.5,
  },
});
