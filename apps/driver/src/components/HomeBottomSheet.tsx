import React from 'react';
import {
  View,
  Pressable,
  Animated,
  StyleSheet,
  Platform,
  Text as RNText,
} from 'react-native';
import { DraggableSheet } from '@tricigo/ui/DraggableSheet';
import { AddressSearchBar } from '@/components/AddressSearchBar';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '@tricigo/theme';
import { useTranslation } from '@tricigo/i18n';
import { useResponsive } from '@tricigo/ui/hooks/useResponsive';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface HomeBottomSheetProps {
  // State
  isOnline: boolean;
  isOnBreak: boolean;
  isIneligible: boolean;
  toggling: boolean;
  togglingBreak: boolean;
  needsSelfieCheck: boolean;
  isSelfieProcessing: boolean;
  selfieLoading: boolean;

  // Data
  todayEarnings: { amount: number; trips: number };
  perHour: number;
  userName?: string;
  estimatedWaitMinutes: number | null;

  // Auto-nav
  navCountdown: number | null;
  nearestHotZone: { lat: number; lng: number; distance: number } | null;

  // Callbacks
  onToggleOnline: () => void;
  onToggleBreak: () => void;
  onSubmitSelfie: () => void;
  onCancelAutoNav: () => void;
  onAddressSelect: (loc: {
    latitude: number;
    longitude: number;
    address: string;
  }) => void;

  // Animations (pass the Animated.Values)
  ring1Anim: any;
  ring2Anim: any;
  ring3Anim: any;
  radarSweepAnim: any;
  ctaScaleAnim: any;
  onCtaPressIn: () => void;
  onCtaPressOut: () => void;
  searchPulseAnim: any;
}

// ─── Snap configuration ───────────────────────────────────────────────────────

const SNAP_POINTS: [string, string, string] = ['18%', '45%', '85%'];
const DEFAULT_SNAP_INDEX = 1;

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

// ─── Inner content (shared between sheet and sidebar) ─────────────────────────

interface SheetContentProps extends HomeBottomSheetProps {
  t: (key: string, opts?: any) => string;
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
  perHour,
  userName,
  estimatedWaitMinutes,
  navCountdown,
  nearestHotZone,
  onToggleOnline,
  onToggleBreak,
  onSubmitSelfie,
  onCancelAutoNav,
  onAddressSelect,
  ring1Anim,
  ring2Anim,
  ring3Anim,
  radarSweepAnim,
  ctaScaleAnim,
  onCtaPressIn,
  onCtaPressOut,
  searchPulseAnim,
  t,
}: SheetContentProps) {
  // ── 1. Alert banners ──────────────────────────────────────────────────────

  const alertBanners = (
    <>
      {isIneligible && (
        <View
          style={styles.alertBanner}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          <Ionicons
            name="warning-outline"
            size={16}
            color="#fca5a5"
            style={{ marginRight: 8 }}
          />
          <View style={{ flex: 1 }}>
            <RNText style={styles.alertText}>
              {t('home.ineligible_banner')}
            </RNText>
          </View>
        </View>
      )}

      {(needsSelfieCheck || isSelfieProcessing) && (
        <View
          style={[
            styles.alertBanner,
            { borderColor: '#f59e0b40', backgroundColor: '#1a1300' },
          ]}
          accessibilityRole="alert"
        >
          <Ionicons
            name="camera-outline"
            size={16}
            color="#f59e0b"
            style={{ marginRight: 8 }}
          />
          <View style={{ flex: 1 }}>
            <RNText style={[styles.alertText, { color: '#fcd34d' }]}>
              {t('verification.selfie_required')}
            </RNText>
            {!isSelfieProcessing && (
              <Pressable onPress={onSubmitSelfie} disabled={selfieLoading}>
                <RNText style={[styles.alertLink, { color: '#f59e0b' }]}>
                  {t('verification.take_selfie')}
                </RNText>
              </Pressable>
            )}
            {isSelfieProcessing && (
              <RNText style={[styles.alertText, { opacity: 0.7 }]}>
                {t('verification.processing')}
              </RNText>
            )}
          </View>
        </View>
      )}

      {navCountdown !== null && nearestHotZone && (
        <View style={styles.omegaBanner}>
          <Ionicons name="navigate" size={16} color="#f59e0b" />
          <View style={{ flex: 1, marginLeft: 8 }}>
            <RNText style={styles.omegaBannerTitle}>
              {t('home.high_demand_zone', {
                seconds: navCountdown,
                defaultValue: 'Navegando a zona en {{seconds}}s',
              })}
            </RNText>
            <RNText style={styles.omegaBannerSub}>
              {t('home.active_zone_nearby', {
                distance: nearestHotZone.distance,
              })}
            </RNText>
          </View>
          <Pressable style={styles.omegaCancelBtn} onPress={onCancelAutoNav}>
            <RNText style={styles.omegaCancelText}>
              {t('home.stay_here', { defaultValue: 'Quedar' })}
            </RNText>
          </Pressable>
        </View>
      )}
    </>
  );

  // ── 2. Offline greeting ─────────────────────────────────────────────────

  const offlineGreeting = !isOnline ? (
    <View style={styles.offlineGreeting}>
      {userName ? (
        <>
          <RNText style={styles.greetingPrefix}>HOLA,</RNText>
          <RNText style={styles.greetingName}>
            {(userName.split(' ')[0] ?? userName).toUpperCase()}
          </RNText>
        </>
      ) : (
        <RNText style={styles.greetingName}>
          {t('home.greeting_generic', { defaultValue: '¡BIENVENIDO!' })}
        </RNText>
      )}
      <RNText style={styles.greetingMotivation}>
        {t('home.connect_to_earn', {
          defaultValue: 'Conectate para empezar a ganar',
        })}
      </RNText>
    </View>
  ) : null;

  // ── 3. Radar sweep searching indicator ──────────────────────────────────

  const radarIndicator = isOnline ? (
    <Animated.View style={{ opacity: searchPulseAnim }}>
      <View style={styles.radarContainer}>
        <View style={styles.radarTrack}>
          <Animated.View
            style={[
              styles.radarSweep,
              {
                transform: [
                  {
                    translateX: radarSweepAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-80, 280],
                    }),
                  },
                ],
              },
            ]}
          >
            <LinearGradient
              colors={['transparent', '#22c55e', 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.radarSweepGradient}
            />
          </Animated.View>
        </View>
        <RNText style={styles.searchingText}>
          {t('home.searching_rides', {
            defaultValue: 'Buscando viajes cerca de ti...',
          })}
          {estimatedWaitMinutes ? `  · ~${estimatedWaitMinutes} min` : ''}
        </RNText>
      </View>
    </Animated.View>
  ) : null;

  // ── 4. Address search bar ───────────────────────────────────────────────

  const addressSearchBar = isOnline ? (
    <View style={styles.searchBarWrapper}>
      <AddressSearchBar
        onSelect={onAddressSelect}
        placeholder={t('home.search_placeholder', {
          defaultValue: 'Buscar dirección o zona...',
        })}
      />
    </View>
  ) : null;

  // ── 5. Earnings stat cards ──────────────────────────────────────────────

  const earningsCards = isOnline ? (
    <View style={styles.earningsCards}>
      <View style={styles.statCard}>
        <Ionicons name="trending-up" size={16} color="#FF8A5C" />
        <RNText style={styles.statCardLabel}>
          {t('home.today', { defaultValue: 'Hoy' })}
        </RNText>
        <RNText style={styles.statCardValue}>
          ₧{todayEarnings.amount.toLocaleString()}
        </RNText>
      </View>
      <View style={styles.statCard}>
        <Ionicons name="car-outline" size={16} color="#FF8A5C" />
        <RNText style={styles.statCardLabel}>
          {t('home.trips_label', { defaultValue: 'Viajes' })}
        </RNText>
        <RNText style={styles.statCardValue}>{todayEarnings.trips}</RNText>
      </View>
      {perHour > 0 && (
        <View style={[styles.statCard, styles.statCardAccent]}>
          <Ionicons name="time-outline" size={16} color={colors.brand.orange} />
          <RNText style={styles.statCardLabel}>
            {t('home.per_hour_label', { defaultValue: 'Por hora' })}
          </RNText>
          <RNText style={[styles.statCardValue, { color: colors.brand.orange }]}>
            ₧{perHour.toLocaleString()}
          </RNText>
        </View>
      )}
    </View>
  ) : null;

  // ── 6. Break banner ─────────────────────────────────────────────────────

  const breakBanner =
    isOnline && isOnBreak ? (
      <View style={styles.breakBanner}>
        <Ionicons name="cafe-outline" size={14} color="#f59e0b" />
        <RNText style={styles.breakBannerText}>
          {t('home.on_break_label', {
            defaultValue: 'En descanso — no recibes solicitudes',
          })}
        </RNText>
      </View>
    ) : null;

  // ── 7. CTA "Ignition Portal" ───────────────────────────────────────────

  const ctaPortal = (
    <View style={styles.ctaCircleContainer}>
      {/* 3 concentric pulse rings (offline only) */}
      {!isOnline && (
        <>
          {[ring1Anim, ring2Anim, ring3Anim].map((anim, i) => (
            <Animated.View
              key={i}
              style={[
                styles.ctaRing,
                {
                  opacity: anim.interpolate({
                    inputRange: [0, 0.2, 1],
                    outputRange: [0, 0.5 - i * 0.12, 0],
                  }),
                  transform: [
                    {
                      scale: anim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [1, 1.8 - i * 0.25],
                      }),
                    },
                  ],
                },
              ]}
            />
          ))}
        </>
      )}

      <Animated.View style={{ transform: [{ scale: ctaScaleAnim }] }}>
        <Pressable
          onPressIn={onCtaPressIn}
          onPressOut={onCtaPressOut}
          onPress={onToggleOnline}
          disabled={toggling}
          accessibilityRole="switch"
          accessibilityState={{ checked: isOnline, disabled: toggling }}
          accessibilityLabel={
            isOnline ? t('home.go_offline') : t('home.go_online')
          }
          style={toggling ? styles.toggleBtnDisabled : undefined}
        >
          {!isOnline ? (
            <LinearGradient
              colors={['#FF6B2C', '#FF4D00', '#CC3D00']}
              style={styles.ctaCircle}
            >
              <Ionicons name="power" size={38} color="#fff" />
            </LinearGradient>
          ) : (
            <View style={styles.ctaCircleOnline}>
              <Ionicons name="power" size={24} color="#ef4444" />
            </View>
          )}
        </Pressable>
      </Animated.View>

      <RNText style={[styles.ctaLabel, isOnline && styles.ctaLabelOnline]}>
        {toggling
          ? isOnline
            ? t('home.disconnecting', { defaultValue: 'DESCONECTANDO...' })
            : t('home.connecting', { defaultValue: 'CONECTANDO...' })
          : isOnline
            ? t('home.go_offline').toUpperCase()
            : t('home.go_online').toUpperCase()}
      </RNText>
    </View>
  );

  // ── 8. Break toggle button ──────────────────────────────────────────────

  const breakToggle = isOnline ? (
    <Pressable
      style={({ pressed }) => [
        styles.breakBtn,
        isOnBreak ? styles.breakBtnActive : styles.breakBtnInactive,
        togglingBreak && styles.toggleBtnDisabled,
        pressed && { opacity: 0.85 },
      ]}
      onPress={onToggleBreak}
      disabled={togglingBreak}
    >
      <Ionicons
        name={isOnBreak ? 'arrow-forward-outline' : 'cafe-outline'}
        size={16}
        color={isOnBreak ? '#fff' : '#9ca3af'}
        style={{ marginRight: 6 }}
      />
      <RNText style={[styles.breakBtnText, isOnBreak && { color: '#fff' }]}>
        {isOnBreak
          ? t('home.end_break', { defaultValue: 'Terminar descanso' })
          : t('home.start_break', { defaultValue: 'Tomar descanso' })}
      </RNText>
    </Pressable>
  ) : null;

  // ── Render all sections ─────────────────────────────────────────────────

  return (
    <View style={styles.sheetContent}>
      {alertBanners}
      {offlineGreeting}
      {radarIndicator}
      {addressSearchBar}
      {earningsCards}
      {breakBanner}
      {ctaPortal}
      {breakToggle}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // ── Desktop sidebar ──
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
    backgroundColor: '#141418',
    borderLeftWidth: 1,
    borderLeftColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 24,
  },

  // ── Sheet content wrapper ──
  sheetContent: {
    paddingTop: 4,
  },

  // ── Banners ──
  alertBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(26,5,5,0.9)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.25)',
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
  },
  alertText: {
    color: '#fca5a5',
    fontSize: 13,
    fontFamily: 'Inter',
    lineHeight: 18,
  },
  alertLink: {
    color: '#ef4444',
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter',
    marginTop: 4,
  },
  omegaBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(26,17,0,0.9)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.25)',
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
  },
  omegaBannerTitle: {
    color: '#fcd34d',
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter',
  },
  omegaBannerSub: {
    color: '#9ca3af',
    fontSize: 11,
    fontFamily: 'Inter',
    marginTop: 2,
  },
  omegaCancelBtn: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  omegaCancelText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter',
  },

  // ── Offline greeting (dramatic typography) ──
  offlineGreeting: {
    alignItems: 'center',
    marginBottom: 10,
    paddingTop: 8,
  },
  greetingPrefix: {
    fontSize: 14,
    fontWeight: '500',
    color: '#FF8A5C',
    fontFamily: 'Inter',
    letterSpacing: 6,
    textTransform: 'uppercase',
  },
  greetingName: {
    fontSize: 42,
    fontWeight: '900',
    color: '#ffffff',
    fontFamily: 'Inter',
    letterSpacing: 4,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  greetingMotivation: {
    fontSize: 13,
    fontWeight: '400',
    color: 'rgba(255,255,255,0.4)',
    fontFamily: 'Inter',
    letterSpacing: 1,
  },

  // ── Radar sweep searching indicator ──
  radarContainer: {
    alignItems: 'center',
    marginBottom: 14,
  },
  radarTrack: {
    width: '80%',
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 1,
    overflow: 'hidden',
    marginBottom: 10,
  },
  radarSweep: {
    position: 'absolute',
    width: 80,
    height: 2,
  },
  radarSweepGradient: {
    flex: 1,
    borderRadius: 1,
  },
  searchingText: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 13,
    fontFamily: 'Inter',
  },

  // ── Search bar wrapper (orange accent) ──
  searchBarWrapper: {
    marginBottom: 12,
    borderLeftWidth: 2,
    borderLeftColor: '#FF4D00',
    borderRadius: 12,
    overflow: 'hidden',
  },

  // ── Stat cards (earnings) ──
  earningsCards: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  statCard: {
    flex: 1,
    backgroundColor: '#1c1c24',
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  statCardAccent: {
    borderColor: 'rgba(255,77,0,0.25)',
  },
  statCardLabel: {
    fontSize: 11,
    color: '#6b7280',
    fontFamily: 'Inter',
    fontWeight: '500',
    marginTop: 6,
    marginBottom: 3,
  },
  statCardValue: {
    fontSize: 20,
    color: '#fff',
    fontFamily: 'Inter',
    fontWeight: '700',
  },

  // ── Break banner ──
  breakBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(245,158,11,0.1)',
    borderRadius: 12,
    paddingVertical: 7,
    paddingHorizontal: 12,
    marginBottom: 10,
  },
  breakBannerText: {
    color: '#fbbf24',
    fontSize: 12,
    fontFamily: 'Inter',
    fontWeight: '500',
  },

  // ── CTA "The Ignition Portal" ──
  ctaCircleContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
    marginBottom: 6,
    paddingVertical: 10,
  },
  ctaRing: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 1.5,
    borderColor: '#FF4D00',
  },
  ctaCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: {
        boxShadow:
          '0 0 40px rgba(255,77,0,0.5), 0 0 80px rgba(255,77,0,0.2), inset 0 0 30px rgba(255,140,92,0.15)',
      } as any,
      default: {
        shadowColor: '#FF4D00',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.6,
        shadowRadius: 30,
        elevation: 15,
      },
    }),
  },
  ctaCircleOnline: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(15,15,25,0.95)',
    borderWidth: 2,
    borderColor: 'rgba(239,68,68,0.5)',
  },
  ctaLabel: {
    color: '#FF8A5C',
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter',
    letterSpacing: 3,
    textTransform: 'uppercase',
    marginTop: 20,
  },
  ctaLabelOnline: {
    color: '#ef4444',
    letterSpacing: 2,
    fontSize: 11,
    marginTop: 12,
  },
  toggleBtnDisabled: {
    opacity: 0.5,
  },

  // ── Break button ──
  breakBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    paddingVertical: 11,
    marginBottom: 4,
  },
  breakBtnActive: {
    backgroundColor: colors.brand.orange,
  },
  breakBtnInactive: {
    backgroundColor: 'rgba(20,20,30,0.6)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  breakBtnText: {
    fontSize: 14,
    fontWeight: '600',
    fontFamily: 'Inter',
    color: '#9ca3af',
  },
});
