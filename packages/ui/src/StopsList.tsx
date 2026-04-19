/**
 * StopsList — lista de paradas intermedias con estética Cuban Modern.
 *
 * Reemplaza la vieja lista con emojis 📍 ✅ que vivía dentro de
 * RouteSummary y viola la regla "no-emoji-icons" del design system.
 *
 * Cada parada muestra:
 *   [marker] Parada N            ×
 *           Dirección trunca
 *
 * Donde `marker` es un <StopMarker> con el estado correcto
 * (pending | current | completed), tipografía es Cuban Modern
 * (JetBrainsMono para el label uppercase, Montserrat para la
 * dirección), y el botón × se pinta con un SVG local — no hay
 * Ionicons crudos acá.
 *
 * Reference: docs/WAYPOINTS_REDESIGN.md
 */
import React from 'react';
import { View, Text as RNText, Pressable, StyleSheet } from 'react-native';
import { cubanLight, cubanDark } from '@tricigo/theme';
import { StopMarker, type StopStatus } from './StopMarker';

export interface StopsListItem {
  id?: string;
  sort_order: number;
  address: string;
  arrived_at?: string | null;
  departed_at?: string | null;
}

export interface StopsListProps {
  stops: StopsListItem[];
  /**
   * Si se pasa, se muestra el botón × al lado de cada parada para
   * eliminarla. Durante `in_progress` solo se debería habilitar
   * para paradas NO completadas; el caller decide filtrando.
   */
  onRemove?: (index: number) => void;
  mode?: 'light' | 'dark';
}

function statusOf(stop: StopsListItem): StopStatus {
  if (stop.departed_at) return 'completed';
  if (stop.arrived_at) return 'current';
  return 'pending';
}

export function StopsList({ stops, onRemove, mode = 'light' }: StopsListProps) {
  const tokens = mode === 'dark' ? cubanDark : cubanLight;

  // Figure out which pending stop is the "next one up" for the driver.
  // That one gets the pulse ring. Logic: first stop that is NOT
  // departed and NOT arrived (pending) and whose sort_order is the
  // minimum among those.
  const sorted = [...stops].sort((a, b) => a.sort_order - b.sort_order);
  const nextPendingIdx = sorted.findIndex(
    (s) => !s.departed_at && !s.arrived_at,
  );

  if (sorted.length === 0) return null;

  return (
    <View style={{ gap: 10 }}>
      {sorted.map((stop, idx) => {
        let status = statusOf(stop);
        // Elevate the first "pending" stop to "current" so it pulses.
        if (status === 'pending' && idx === nextPendingIdx) {
          status = 'current';
        }

        const isRemovable =
          onRemove && !stop.arrived_at && !stop.departed_at;

        return (
          <View
            key={stop.id ?? idx}
            style={[
              styles.row,
              {
                backgroundColor: tokens.bg.elev1,
                borderColor: tokens.line,
              },
            ]}
          >
            <StopMarker index={stop.sort_order} status={status} mode={mode} size={32} />
            <View style={styles.info}>
              <RNText
                style={{
                  fontFamily: 'JetBrainsMono_500Medium',
                  fontSize: 10,
                  letterSpacing: 2,
                  color: tokens.ink.subtle,
                }}
              >
                {status === 'completed'
                  ? `PARADA ${stop.sort_order} · YA PASÓ`
                  : status === 'current'
                    ? `PRÓXIMA PARADA`
                    : `PARADA ${stop.sort_order}`}
              </RNText>
              <RNText
                style={{
                  fontFamily: 'Montserrat_500Medium',
                  fontSize: 14,
                  color:
                    status === 'completed'
                      ? tokens.ink.subtle
                      : tokens.ink.primary,
                  marginTop: 2,
                }}
                numberOfLines={1}
              >
                {stop.address || '—'}
              </RNText>
            </View>
            {isRemovable && (
              <Pressable
                onPress={() => onRemove(idx)}
                hitSlop={10}
                style={({ pressed }) => [
                  styles.removeBtn,
                  { opacity: pressed ? 0.55 : 1 },
                ]}
                accessibilityRole="button"
                accessibilityLabel={`Eliminar parada ${stop.sort_order}`}
              >
                <CloseGlyph color={tokens.ink.subtle} size={16} />
              </Pressable>
            )}
          </View>
        );
      })}
    </View>
  );
}

/** Close glyph built from two rotated lines — keeps the stroke on-brand. */
function CloseGlyph({ color, size }: { color: string; size: number }) {
  const stroke = 1.8;
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <View
        style={{
          position: 'absolute',
          width: size,
          height: stroke,
          backgroundColor: color,
          borderRadius: stroke,
          transform: [{ rotate: '45deg' }],
        }}
      />
      <View
        style={{
          position: 'absolute',
          width: size,
          height: stroke,
          backgroundColor: color,
          borderRadius: stroke,
          transform: [{ rotate: '-45deg' }],
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
  },
  info: {
    flex: 1,
    minWidth: 0,
  },
  removeBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
