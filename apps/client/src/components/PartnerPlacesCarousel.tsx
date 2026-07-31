import React, { useCallback, useEffect, useState } from 'react';
import { View, Pressable, Image, ScrollView, useWindowDimensions } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Ionicons } from '@expo/vector-icons';
import { partnerPlaceService } from '@tricigo/api';
import type { PartnerPlace } from '@tricigo/types';
import { useTranslation } from '@tricigo/i18n';
import { tricigoCategoryEmoji } from '@tricigo/utils';
import { useRefreshOnFocus } from '@/hooks/useRefreshOnFocus';
import type { Tokens } from '@/hooks/useTokens';

interface Props {
  latitude: number | null;
  longitude: number | null;
  tokens: Tokens;
  onSelect: (place: PartnerPlace) => void;
}

/**
 * Hero carousel of nearby partner places. Renders nothing when there is no
 * location fix or no place in range — showing a bakery that might be in
 * another province is worse than showing nothing, and the coupon is issued
 * on arrival either way, so nothing is lost by staying quiet.
 *
 * `getNearby` swallows its own errors and returns [] (including while the
 * migrations are still unapplied in production), so there is no try/catch
 * here on purpose — adding one would only hide a bug it cannot reach.
 */
export function PartnerPlacesCarousel({ latitude, longitude, tokens, onSelect }: Props) {
  const { t } = useTranslation('rider');
  const { width } = useWindowDimensions();
  const [places, setPlaces] = useState<PartnerPlace[]>([]);
  // IdleView's scroll container is paddingHorizontal: 20, so the usable width
  // is width - 40. The 340 cap keeps a sliver of the next card visible on wide
  // screens, which is what tells the passenger the row scrolls at all.
  const cardWidth = Math.min(width - 40, 340);

  const load = useCallback(async () => {
    if (latitude == null || longitude == null) { setPlaces([]); return; }
    setPlaces(await partnerPlaceService.getNearby(latitude, longitude, 8));
  }, [latitude, longitude]);

  useEffect(() => { void load(); }, [load]);
  // Stale-on-mount: tabs stay mounted, so refetch on focus / app foreground.
  // `has_active_coupon` flips the moment a ride ends inside a partner radius.
  useRefreshOnFocus(load);

  if (places.length === 0) return null;

  return (
    <View style={{ marginTop: 24 }}>
      <Text style={{
        fontFamily: 'JetBrainsMono_600SemiBold', fontSize: 10, letterSpacing: 2,
        color: tokens.ink.subtle, marginBottom: 8,
      }}>
        {t('home.partner_places_label', { defaultValue: 'LUGARES CON BENEFICIO' })}
      </Text>

      {/* One card per swipe. `pagingEnabled` is deliberately NOT set: it snaps
          to multiples of the viewport width, which is not the card pitch, and
          RN documents it as fighting `snapToInterval`. Interval + fast
          deceleration is the combination that actually pages these cards. */}
      <ScrollView
        horizontal
        snapToInterval={cardWidth + 10}
        snapToAlignment="start"
        decelerationRate="fast"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 10, paddingRight: 16 }}
      >
        {places.map((p) => (
          // Layout (`width`) lives in a plain style OBJECT, never inside a
          // Pressable style FUNCTION — RN silently drops layout props from
          // the function form. See the Pressable note in CLAUDE.md.
          <Pressable
            key={p.id}
            style={{ width: cardWidth }}
            onPress={() => onSelect(p)}
            android_ripple={{ color: 'rgba(255,255,255,0.18)' }}
            accessibilityRole="button"
            accessibilityLabel={`${p.name}: ${p.benefit_title}`}
          >
            {({ pressed }) => (
              <View style={{
                width: '100%', opacity: pressed ? 0.92 : 1,
                backgroundColor: tokens.bg.elev1, borderColor: tokens.line, borderWidth: 1,
                borderRadius: 18, overflow: 'hidden',
              }}>
                {p.photo_url ? (
                  <Image source={{ uri: p.photo_url }} style={{ width: '100%', height: 128 }} resizeMode="cover" />
                ) : (
                  <View style={{
                    width: '100%', height: 128, backgroundColor: tokens.bg.elev2,
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Text style={{ fontSize: 40 }}>{tricigoCategoryEmoji(p.category)}</Text>
                  </View>
                )}

                <View style={{ padding: 13 }}>
                  <View style={{
                    alignSelf: 'flex-start', backgroundColor: tokens.accent.orange,
                    borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4, marginBottom: 7,
                  }}>
                    <Text style={{
                      fontFamily: 'JetBrainsMono_600SemiBold', fontSize: 9,
                      letterSpacing: 1.2, color: '#fff',
                    }}>
                      {p.benefit_title.toUpperCase()}
                    </Text>
                  </View>

                  <Text numberOfLines={1} style={{
                    fontFamily: 'BricolageGrotesque_700Bold', fontSize: 16, color: tokens.ink.primary,
                  }}>
                    {p.name}
                  </Text>
                  <Text numberOfLines={2} style={{
                    fontFamily: 'Inter', fontSize: 12, color: tokens.ink.subtle,
                    lineHeight: 16, marginTop: 3,
                  }}>
                    {p.benefit_description}
                  </Text>
                  <Text style={{
                    fontFamily: 'JetBrainsMono_400Regular', fontSize: 10,
                    color: tokens.ink.subtle, letterSpacing: 0.5, marginTop: 7,
                  }}>
                    {(p.municipality ?? '').toUpperCase()}
                    {p.municipality ? ' · ' : ''}
                    {(p.distance_m / 1000).toFixed(1)} KM
                  </Text>

                  {p.has_active_coupon && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8 }}>
                      <Ionicons name="ticket" size={13} color={tokens.accent.orange} />
                      <Text style={{ fontFamily: 'Inter', fontSize: 11, color: tokens.accent.orange }}>
                        {t('home.partner_has_coupon', { defaultValue: 'Ya tienes un cupón activo aquí' })}
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            )}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
