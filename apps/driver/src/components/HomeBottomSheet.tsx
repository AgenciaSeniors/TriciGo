/**
 * HomeBottomSheet v2 — Midnight Ember edition.
 *
 * Panel de control principal del driver. Reemplaza la implementación previa
 * que renderizaba simultáneamente:
 *   - Greeting "HOLA, RAÚL" 42pt 900 weight letterSpacing 4 uppercase
 *     ("fitness app smell", anti-Linear)
 *   - "Ignition Portal" CTA: 120pt circle + gradient + 3 anillos animados
 *     concéntricos + 2 halos estáticos (5 capas de motion en una decisión
 *     de toggle on/off)
 *   - Radar sweep gradient pasando 80px → 280px en loop 2s
 *   - Pulse animado en barra de address (orange stripe)
 *   - 3 stat cards simétricos sin storytelling (Hoy / Viajes / Por hora)
 *
 * Decisiones de diseño confirmadas con el usuario:
 *   A. Greeting → sentence-case + storytelling histórico ("Recogiste $X
 *      ayer · N viajes") en vez de slogan motivacional.
 *   B. CTA portal → botón rectangular ancho con shadow.glow. Sin rings
 *      ni halos (motion.glowRing y motion.ignitionPortal en blacklist).
 *   C. Radar sweep + "Buscando…" + wait time pasivo → smart suggestion
 *      card accionable con data del hook `useDemandHotspots` ya existente.
 *   D. 3 stat cards → 1 hero card con storytelling (`+18% vs ayer ·
 *      N viajes · $X/h`).
 *   E. Break + Disconnect → 2 botones discretos en footer (acciones
 *      semánticamente distintas).
 *   F. Eliminadas 6 animation props del componente y del padre
 *      (ring1/2/3Anim, radarSweepAnim, searchPulseAnim, addressPulseAnim).
 *      Solo queda ctaScaleAnim para press feedback.
 *
 * 3 estados visuales bien diferenciados:
 *   - OFFLINE: greeting + banners + CTA primario + recap ayer
 *   - ONLINE IDLE: status pill + hero earnings + search + suggestion +
 *     footer (Pausar / Desconectar)
 *   - ONLINE ON-BREAK: status pill warning + hero atenuado + Reanudar +
 *     link Desconectar completamente
 *
 * Lógica preservada: snap points, desktop sidebar fallback, todos los
 * callbacks, haptics, accessibility.
 */
import React, { useRef } from 'react';
import {
  View,
  Pressable,
  Animated,
  StyleSheet,
  Text as RNText,
} from 'react-native';
import { DraggableSheet } from '@tricigo/ui/DraggableSheet';
import { AddressSearchBar } from '@/components/AddressSearchBar';
import { Ionicons } from '@expo/vector-icons';
import { midnightEmber } from '@tricigo/theme';
import { triggerHaptic } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { useResponsive } from '@tricigo/ui/hooks/useResponsive';

// ─── Props ────────────────────────────────────────────────────────────────────

/**
 * Smart suggestion to pre-position the driver toward a high-demand
 * zone. Computed by the parent via `useSmartSuggestion`, which
 * composes live demand hotspots, surge zones, and historical popular
 * pickup clusters into a single ranked recommendation (Phase 2 N1).
 */
export interface NearestHotspot {
  lat: number;
  lng: number;
  /** Kilometers to the hotspot, rounded to 1 decimal. */
  distance: number;
  /** Live concurrent rides being requested in this hotspot. */
  liveCount: number;
  /**
   * Surge multiplier in effect at this point (1 = no surge).
   * Optional so older callers without N1 wiring keep compiling.
   */
  surgeMultiplier?: number;
  /**
   * Where the suggestion came from. `live` = current request hotspot,
   * `popular` = historical pickup cluster fallback. Used to choose
   * the right copy when surfacing the suggestion.
   */
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

  // ── Data ──
  todayEarnings: { amount: number; trips: number };
  /** Optional — only available when parent has fetched yesterday's totals. */
  yesterdayEarnings: { amount: number; trips: number } | null;
  perHour: number;
  userName?: string;

  // ── Auto-nav (legacy, idle-≥-10min trigger) ──
  navCountdown: number | null;
  nearestHotZone: { lat: number; lng: number; distance: number } | null;

  // ── Smart suggestion (always available when online idle) ──
  nearestHotspot: NearestHotspot | null;

  /**
   * Phase 2 N6 — anti-fatigue level derived from continuous online time.
   * `none` = no warning. `soft` = ~6h+ (suggestion). `firm` = ~10h+
   * (strong recommendation, encourages break). Drives the warning
   * banner in the sheet; pure UX nudge — never blocks driving.
   */
  fatigueLevel: 'none' | 'soft' | 'firm';
  /** Continuous online-session hours, rounded to 1 decimal. Surfaced in the banner copy. */
  sessionHours: number;

  // ── Callbacks ──
  onToggleOnline: () => void;
  onToggleBreak: () => void;
  onSubmitSelfie: () => void;
  onCancelAutoNav: () => void;
  onAddressSelect: (loc: {
    latitude: number;
    longitude: number;
    address: string;
  }) => void;
  /** Open turn-by-turn nav toward the suggested hotspot. */
  onGoToSuggestion: (lat: number, lng: number) => void;

  // ── Animations (only press feedback survives v2) ──
  ctaScaleAnim: Animated.Value;
  onCtaPressIn: () => void;
  onCtaPressOut: () => void;
}

// ─── Snap configuration ───────────────────────────────────────────────────────

const SNAP_POINTS: [string, string, string] = ['18%', '45%', '85%'];
const DEFAULT_SNAP_INDEX = 1;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the Spanish time-of-day greeting used by the offline state.
 * Uses Havana wall-clock when possible (string is locale-dependent so the
 * caller can localize via i18n).
 */
function getTimeOfDayKey(): 'morning' | 'afternoon' | 'evening' {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 19) return 'afternoon';
  return 'evening';
}

/** Returns the comparison label for today vs yesterday earnings. */
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

  const content = <SheetContent {...props} t={t} />;

  // Desktop: fixed right sidebar instead of bottom sheet
  if (isDesktop) {
    return (
      <View style={styles.desktopSidebar}>
        <View style={styles.desktopSidebarInner}>{content}</View>
      </View>
    );
  }

  // Mobile / tablet: draggable bottom sheet
  return (
    <DraggableSheet
      snapPoints={SNAP_POINTS}
      initialIndex={DEFAULT_SNAP_INDEX}
      theme="dark"
      scrollable
    >
      {content}
    </DraggableSheet>
  );
}

// ─── Inner content ─────────────────────────────────────────────────────────────

interface SheetContentProps extends HomeBottomSheetProps {
  t: (key: string, opts?: Record<string, unknown>) => string;
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
  todayEarnings,
  yesterdayEarnings,
  perHour,
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
  onAddressSelect,
  onGoToSuggestion,
  ctaScaleAnim,
  onCtaPressIn,
  onCtaPressOut,
  t,
}: SheetContentProps) {
  // ── Status dot pulse (única motion sobreviviente del system) ──
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

  // ── Banners (alerts) ──────────────────────────────────────────
  const banners = (
    <>
      {isIneligible && (
        <Banner
          variant="danger"
          icon="warning-outline"
          message={t('home.ineligible_banner')}
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
        />
      )}
      {/* Phase 2 N6 — anti-fatigue prompt. Only renders while genuinely
           online and not already on break (the warning would be tone-deaf
           if the driver is currently resting). Soft level at ~6h, firm
           at ~10h. Action wires straight to the existing break toggle
           so the driver can act in one tap. */}
      {fatigueLevel !== 'none' && isOnline && !isOnBreak && (
        <Banner
          variant={fatigueLevel === 'firm' ? 'danger' : 'warning'}
          icon={fatigueLevel === 'firm' ? 'warning' : 'time-outline'}
          message={
            fatigueLevel === 'firm'
              ? t('home.fatigue_firm_title', {
                  hours: sessionHours.toFixed(1),
                  defaultValue: '{{hours}}h seguidas — pará por seguridad',
                })
              : t('home.fatigue_soft_title', {
                  hours: sessionHours.toFixed(1),
                  defaultValue: 'Llevás {{hours}}h manejando — considerá un descanso',
                })
          }
          subtitle={
            fatigueLevel === 'firm'
              ? t('home.fatigue_firm_subtitle', {
                  defaultValue: 'Manejar fatigado es peligroso para vos y los pasajeros',
                })
              : t('home.fatigue_soft_subtitle', {
                  defaultValue: 'Un descanso de 15 min mejora reflejos y humor con los riders',
                })
          }
          actionLabel={t('home.fatigue_take_break', { defaultValue: 'Tomar descanso' })}
          onActionPress={onToggleBreak}
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
        {/* Greeting (sentence-case, no shouty uppercase) */}
        <RNText style={[styles.greeting, { color: midnightEmber.map.text.primary }]}>
          {greetingFull}
        </RNText>

        {banners}

        {/* Primary CTA — ancho, con glow, sin portal */}
        <Animated.View style={{ transform: [{ scale: ctaScaleAnim }] }}>
          <Pressable
            onPressIn={onCtaPressIn}
            onPressOut={onCtaPressOut}
            onPress={() => { triggerHaptic('heavy'); onToggleOnline(); }}
            disabled={toggling || isIneligible}
            accessibilityRole="switch"
            accessibilityState={{ checked: false, disabled: toggling || isIneligible }}
            accessibilityLabel={t('home.go_online', { defaultValue: 'Conectarme' })}
            style={[
              styles.ctaPrimary,
              {
                backgroundColor: midnightEmber.accent[500],
                borderRadius: midnightEmber.radius.card,
                ...midnightEmber.shadow.glow,
              },
              (toggling || isIneligible) && styles.disabled,
            ]}
          >
            <Ionicons name="power" size={20} color={midnightEmber.map.text.onAccent} />
            <RNText style={[
              midnightEmber.text.buttonLg,
              { color: midnightEmber.map.text.onAccent, marginLeft: 8 },
            ]}>
              {toggling
                ? t('home.connecting', { defaultValue: 'Conectando…' })
                : t('home.go_online', { defaultValue: 'Conectarme' })}
            </RNText>
          </Pressable>
        </Animated.View>

        {/* Yesterday recap — storytelling con data */}
        {yesterdayEarnings && yesterdayEarnings.amount > 0 && (
          <RNText style={[
            styles.yesterdayRecap,
            { color: midnightEmber.map.text.secondary },
          ]}>
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
            ? t('home.break_status', { defaultValue: 'En descanso · No recibís solicitudes' })
            : t('home.idle_status', { defaultValue: 'En línea · Buscando viajes' })
        }
      />

      {/* Hero earnings card */}
      <View
        style={[
          styles.heroCard,
          {
            backgroundColor: midnightEmber.map.bg.elevated,
            borderColor: midnightEmber.map.line.default,
            borderRadius: midnightEmber.radius.card,
          },
          isOnBreak && { opacity: 0.6 },
        ]}
      >
        <RNText style={[
          midnightEmber.text.meta,
          { color: midnightEmber.map.text.tertiary, marginBottom: 4 },
        ]}>
          {t('home.earnings_today_label', { defaultValue: 'HOY' })}
        </RNText>
        <RNText style={[
          midnightEmber.text.heroLg,
          { color: midnightEmber.map.text.primary },
        ]}>
          ${todayEarnings.amount.toLocaleString()}
        </RNText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 8, gap: 6 }}>
          {cmp.symbol && cmp.delta !== null && (
            <RNText style={[
              midnightEmber.text.bodyDense,
              {
                color:
                  cmp.color === 'success' ? midnightEmber.state.success :
                  cmp.color === 'warning' ? midnightEmber.state.warning :
                  midnightEmber.map.text.secondary,
                fontWeight: '600',
              },
            ]}>
              {cmp.symbol} {Math.abs(cmp.delta)}% {t('home.compare_yesterday', { defaultValue: 'vs ayer' })}
            </RNText>
          )}
          {cmp.symbol && (
            <RNText style={[midnightEmber.text.bodyDense, { color: midnightEmber.map.text.tertiary }]}>·</RNText>
          )}
          <RNText style={[midnightEmber.text.bodyDense, { color: midnightEmber.map.text.secondary }]}>
            {t('home.trips_count', { count: todayEarnings.trips, defaultValue: '{{count}} viajes' })}
          </RNText>
          {perHour > 0 && (
            <>
              <RNText style={[midnightEmber.text.bodyDense, { color: midnightEmber.map.text.tertiary }]}>·</RNText>
              <RNText style={[midnightEmber.text.bodyDense, { color: midnightEmber.map.text.secondary }]}>
                ${perHour.toLocaleString()}{t('home.per_hour_short', { defaultValue: '/h' })}
              </RNText>
            </>
          )}
        </View>
      </View>

      {/* On-break: simplified controls (no search, no suggestion, just resume) */}
      {isOnBreak ? (
        <>
          <Animated.View style={{ transform: [{ scale: ctaScaleAnim }], marginTop: 12 }}>
            <Pressable
              onPressIn={onCtaPressIn}
              onPressOut={onCtaPressOut}
              onPress={() => { triggerHaptic('medium'); onToggleBreak(); }}
              disabled={togglingBreak}
              accessibilityRole="button"
              accessibilityLabel={t('home.resume_work', { defaultValue: 'Reanudar trabajo' })}
              style={[
                styles.ctaPrimary,
                {
                  backgroundColor: midnightEmber.accent[500],
                  borderRadius: midnightEmber.radius.card,
                  ...midnightEmber.shadow.glow,
                },
                togglingBreak && styles.disabled,
              ]}
            >
              <Ionicons name="play" size={18} color={midnightEmber.map.text.onAccent} />
              <RNText style={[
                midnightEmber.text.buttonLg,
                { color: midnightEmber.map.text.onAccent, marginLeft: 8 },
              ]}>
                {togglingBreak
                  ? t('home.resuming', { defaultValue: 'Reanudando…' })
                  : t('home.resume_work', { defaultValue: 'Reanudar trabajo' })}
              </RNText>
            </Pressable>
          </Animated.View>

          <Pressable
            onPress={() => { triggerHaptic('light'); onToggleOnline(); }}
            disabled={toggling}
            style={{ marginTop: 14, alignItems: 'center', paddingVertical: 8 }}
            accessibilityRole="button"
            accessibilityLabel={t('home.disconnect_full', { defaultValue: 'Desconectar completamente' })}
          >
            <RNText style={[
              midnightEmber.text.bodyDense,
              {
                color: midnightEmber.map.text.tertiary,
                textDecorationLine: 'underline',
              },
            ]}>
              {t('home.disconnect_full', { defaultValue: 'Desconectar completamente' })}
            </RNText>
          </Pressable>
        </>
      ) : (
        <>
          {/* Search bar — sin pulse animado */}
          <View style={{ marginTop: 12 }}>
            <AddressSearchBar
              onSelect={onAddressSelect}
              placeholder={t('home.search_placeholder', {
                defaultValue: 'Buscar dirección o zona…',
              })}
            />
          </View>

          {/* Smart suggestion card (solo cuando hay hotspot real) */}
          {nearestHotspot && (nearestHotspot.liveCount > 0 || nearestHotspot.source === 'popular') && (
            <Pressable
              onPress={() => {
                triggerHaptic('medium');
                onGoToSuggestion(nearestHotspot.lat, nearestHotspot.lng);
              }}
              style={[
                styles.suggestionCard,
                {
                  backgroundColor: midnightEmber.map.bg.elevated,
                  borderColor: midnightEmber.accent[800],
                  borderRadius: midnightEmber.radius.card,
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('home.suggestion_a11y', {
                distance: nearestHotspot.distance,
                count: nearestHotspot.liveCount,
                defaultValue: 'Ir a zona caliente a {{distance}} km con {{count}} viajes esperando',
              })}
            >
              <RNText style={[
                midnightEmber.text.meta,
                { color: midnightEmber.accent[400], marginBottom: 4 },
              ]}>
                {t('home.suggestion_label', { defaultValue: 'SUGERENCIA' })}
              </RNText>
              <RNText style={[
                midnightEmber.text.body,
                { color: midnightEmber.map.text.primary, fontWeight: '600' },
              ]}>
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
              {/* N1 — surge multiplier badge when this point sits inside
                  an active surge zone. The "+X%" framing is friendlier
                  than "1.5x" for non-power users. */}
              {nearestHotspot.surgeMultiplier !== undefined && nearestHotspot.surgeMultiplier > 1 && (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 4,
                    backgroundColor: midnightEmber.accent[300],
                    paddingHorizontal: 8,
                    paddingVertical: 2,
                    borderRadius: midnightEmber.radius.pill,
                    alignSelf: 'flex-start',
                    marginTop: 6,
                  }}
                >
                  <Ionicons
                    name="flame"
                    size={11}
                    color={midnightEmber.accent[800]}
                  />
                  <RNText
                    style={[
                      midnightEmber.text.caption,
                      { color: midnightEmber.accent[800], fontWeight: '700' },
                    ]}
                  >
                    +{Math.round((nearestHotspot.surgeMultiplier - 1) * 100)}%
                  </RNText>
                </View>
              )}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 }}>
                <Ionicons
                  name="arrow-forward"
                  size={13}
                  color={midnightEmber.accent[500]}
                />
                <RNText style={[
                  midnightEmber.text.caption,
                  { color: midnightEmber.accent[500], fontWeight: '600' },
                ]}>
                  {t('home.suggestion_go', { defaultValue: 'Ir hacia allá' })}
                </RNText>
              </View>
            </Pressable>
          )}

          {/* Footer: Pausar + Desconectar (acciones discretas) */}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
            <Pressable
              onPress={() => { triggerHaptic('light'); onToggleBreak(); }}
              disabled={togglingBreak}
              style={[
                styles.footerActionSecondary,
                {
                  borderColor: midnightEmber.map.line.default,
                  borderRadius: midnightEmber.radius.card,
                },
                togglingBreak && styles.disabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('home.pause', { defaultValue: 'Pausar' })}
            >
              <Ionicons
                name="pause"
                size={16}
                color={midnightEmber.map.text.secondary}
              />
              <RNText style={[
                midnightEmber.text.buttonMd,
                { color: midnightEmber.map.text.secondary, marginLeft: 6 },
              ]}>
                {t('home.pause', { defaultValue: 'Pausar' })}
              </RNText>
            </Pressable>
            <Pressable
              onPress={() => { triggerHaptic('medium'); onToggleOnline(); }}
              disabled={toggling}
              style={[
                styles.footerActionDisconnect,
                {
                  backgroundColor: midnightEmber.map.bg.elevated,
                  borderRadius: midnightEmber.radius.card,
                },
                toggling && styles.disabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('home.disconnect', { defaultValue: 'Desconectar' })}
            >
              <Ionicons
                name="power"
                size={16}
                color={midnightEmber.state.danger}
              />
              <RNText style={[
                midnightEmber.text.buttonMd,
                { color: midnightEmber.state.danger, marginLeft: 6 },
              ]}>
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
}

function Banner({
  variant,
  icon,
  message,
  subtitle,
  actionLabel,
  onActionPress,
  actionDisabled,
}: BannerProps) {
  const accent =
    variant === 'danger' ? midnightEmber.state.danger :
    variant === 'warning' ? midnightEmber.state.warning :
    midnightEmber.state.info;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        backgroundColor: midnightEmber.map.bg.surface,
        borderWidth: 1,
        borderColor: accent + '4D', // 30% alpha
        borderRadius: midnightEmber.radius.input,
        padding: 12,
        marginBottom: 10,
        gap: 8,
      }}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Ionicons name={icon} size={16} color={accent} style={{ marginTop: 1 }} />
      <View style={{ flex: 1 }}>
        <RNText style={[midnightEmber.text.bodyDense, { color: accent }]}>
          {message}
        </RNText>
        {subtitle && (
          <RNText style={[
            midnightEmber.text.caption,
            { color: midnightEmber.map.text.secondary, marginTop: 2 },
          ]}>
            {subtitle}
          </RNText>
        )}
        {actionLabel && onActionPress && (
          <Pressable onPress={onActionPress} disabled={actionDisabled} hitSlop={6}>
            <RNText style={[
              midnightEmber.text.caption,
              {
                color: accent,
                fontWeight: '700',
                textDecorationLine: 'underline',
                marginTop: 4,
                opacity: actionDisabled ? 0.5 : 1,
              },
            ]}>
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
}

function StatusPill({ variant, label, pulseAnim }: StatusPillProps) {
  const dotColor =
    variant === 'online' ? midnightEmber.state.success : midnightEmber.state.warning;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        alignSelf: 'flex-start',
        backgroundColor: midnightEmber.map.bg.elevated,
        borderWidth: 1,
        borderColor: midnightEmber.map.line.default,
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: midnightEmber.radius.pill,
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
      <RNText style={[
        midnightEmber.text.label,
        { color: midnightEmber.map.text.primary },
      ]}>
        {label}
      </RNText>
    </View>
  );
}

// ─── Styles (layout only — no colors/fonts; those come from tokens) ────────────

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
    backgroundColor: midnightEmber.map.bg.surface,
    borderLeftWidth: 1,
    borderLeftColor: midnightEmber.map.line.hairline,
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 24,
  },
  sheetContent: {
    paddingTop: 4,
  },
  greeting: {
    ...midnightEmber.text.h1,
    marginBottom: 16,
  },
  ctaPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 56,
    minHeight: 48,
    paddingHorizontal: 16,
    width: '100%',
  },
  yesterdayRecap: {
    ...midnightEmber.text.bodyDense,
    textAlign: 'center',
    marginTop: 16,
  },
  heroCard: {
    padding: 16,
    borderWidth: 1,
  },
  suggestionCard: {
    padding: 14,
    borderWidth: 1,
    marginTop: 10,
  },
  footerActionSecondary: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    minHeight: 48,
    borderWidth: 1,
    backgroundColor: 'transparent',
  },
  footerActionDisconnect: {
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
