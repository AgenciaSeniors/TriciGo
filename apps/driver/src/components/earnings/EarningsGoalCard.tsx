/**
 * EarningsGoalCard — Midnight Ember edition (PR-B).
 *
 * Three internal states:
 *   1. No goal yet → minimal "Establecer meta del día" CTA card.
 *   2. Editing → input + Save / Cancel buttons.
 *   3. Goal set → progress bar + percentage + milestone label.
 *
 * v2 tokenization:
 *   - Card surface: `screen.bg.surface` + `screen.line.default` border
 *     + `radius.card` + `shadow.card`.
 *   - Progress threshold rainbow (success / yellow / red) collapsed to
 *     the system semantics: `state.success` (≥75%), `state.warning`
 *     (≥50%), `state.danger` (<50%).
 *   - Save CTA uses `accent[500]` solid fill.
 *   - Input uses `screen.bg.sunken` + `screen.line.default` border —
 *     the same pattern as other input affordances in the dashboard.
 *   - Change-goal link uses `accent[500]` text affordance instead of
 *     the legacy `text-primary-400` Tailwind class.
 *
 * Behaviour preserved verbatim — same AsyncStorage persistence,
 * milestone toasts, BUG-079 day-rollover reset, HF-3 validation.
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, Pressable, TextInput } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Toast from 'react-native-toast-message';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { formatCUP } from '@tricigo/utils';
import { midnightEmber } from '@tricigo/theme';

const GOAL_STORAGE_KEY = '@tricigo/earnings_goal';
const MILESTONE_STORAGE_PREFIX = '@tricigo/milestone_shown_';

function getTodayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface EarningsGoalCardProps {
  currentEarnings: number;
}

export function EarningsGoalCard({ currentEarnings }: EarningsGoalCardProps) {
  const { t } = useTranslation('driver');
  const [goal, setGoal] = useState<number>(0);
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const shownMilestonesRef = useRef<Set<number>>(new Set());
  const prevTodayKeyRef = useRef<string>(getTodayKey());

  // Load goal from AsyncStorage
  useEffect(() => {
    AsyncStorage.getItem(GOAL_STORAGE_KEY).then((v) => {
      if (v) {
        const parsed = parseInt(v, 10);
        if (!isNaN(parsed) && parsed > 0) setGoal(parsed);
      }
    });
  }, []);

  // Load already-shown milestones for today
  useEffect(() => {
    const todayKey = getTodayKey();
    AsyncStorage.getItem(`${MILESTONE_STORAGE_PREFIX}${todayKey}`).then((v) => {
      if (v) {
        try {
          const arr = JSON.parse(v) as number[];
          shownMilestonesRef.current = new Set(arr);
        } catch { /* ignore */ }
      }
    });
  }, []);

  // Milestone toasts
  useEffect(() => {
    if (goal <= 0 || currentEarnings <= 0) return;
    const pct = (currentEarnings / goal) * 100;
    const todayKey = getTodayKey();

    // BUG-079: Reset shown milestones when day changes
    if (todayKey !== prevTodayKeyRef.current) {
      shownMilestonesRef.current = new Set();
      prevTodayKeyRef.current = todayKey;
    }

    const milestones: { threshold: number; message: string }[] = [
      { threshold: 25, message: t('earnings.milestone_25', { defaultValue: 'Buen inicio!' }) },
      { threshold: 50, message: t('earnings.milestone_50', { defaultValue: 'Mitad del camino!' }) },
      { threshold: 75, message: t('earnings.milestone_75', { defaultValue: 'Casi llegas!' }) },
      { threshold: 100, message: t('earnings.milestone_100', { defaultValue: 'Meta cumplida!' }) },
    ];

    for (const ms of milestones) {
      if (pct >= ms.threshold && !shownMilestonesRef.current.has(ms.threshold)) {
        shownMilestonesRef.current.add(ms.threshold);
        Toast.show({
          type: ms.threshold === 100 ? 'success' : 'info',
          text1: ms.threshold === 100 ? '🎉 ' + ms.message : ms.message,
          text2: `${Math.round(pct)}% ${t('earnings.of_goal', { defaultValue: 'de tu meta' })}`,
        });
        // Persist shown milestones for today
        AsyncStorage.setItem(
          `${MILESTONE_STORAGE_PREFIX}${todayKey}`,
          JSON.stringify(Array.from(shownMilestonesRef.current)),
        );
      }
    }
  }, [currentEarnings, goal, t]);

  const saveGoal = useCallback(() => {
    const parsed = parseInt(inputValue.replace(/\D/g, ''), 10);
    // HF-3: Validate goal bounds to prevent unreasonable values
    if (!isNaN(parsed) && parsed > 0 && parsed <= 999999) {
      setGoal(parsed);
      AsyncStorage.setItem(GOAL_STORAGE_KEY, String(parsed));
      // Reset milestones for new goal
      const todayKey = getTodayKey();
      shownMilestonesRef.current.clear();
      AsyncStorage.removeItem(`${MILESTONE_STORAGE_PREFIX}${todayKey}`);
    }
    setEditing(false);
  }, [inputValue]);

  const pct = goal > 0 ? Math.min((currentEarnings / goal) * 100, 100) : 0;

  // PR-B: collapse the 3-hex progress rainbow onto semantic state tokens.
  const progressColor =
    pct >= 75
      ? midnightEmber.state.success
      : pct >= 50
        ? midnightEmber.state.warning
        : midnightEmber.state.danger;

  const milestoneLabel = pct >= 100
    ? t('earnings.milestone_100', { defaultValue: 'Meta cumplida!' })
    : pct >= 75
      ? t('earnings.milestone_75', { defaultValue: 'Casi llegas!' })
      : pct >= 50
        ? t('earnings.milestone_50', { defaultValue: 'Mitad del camino!' })
        : pct >= 25
          ? t('earnings.milestone_25', { defaultValue: 'Buen inicio!' })
          : null;

  // Reusable card surface — every internal state shares this look.
  const cardStyle = {
    backgroundColor: midnightEmber.screen.bg.surface,
    borderWidth: 1,
    borderColor: midnightEmber.screen.line.default,
    borderRadius: midnightEmber.radius.card,
    padding: 14,
    marginBottom: 16,
    ...midnightEmber.shadow.card,
  };

  if (goal <= 0 && !editing) {
    return (
      <Pressable
        onPress={() => { setEditing(true); setInputValue(''); }}
        style={cardStyle}
        accessibilityRole="button"
        accessibilityLabel={t('earnings.set_goal', { defaultValue: 'Establecer meta del dia' })}
      >
        <View className="flex-row items-center">
          <Text style={{ fontSize: 20, marginRight: 8 }}>🎯</Text>
          <Text
            variant="body"
            className="font-semibold"
            style={{ color: midnightEmber.screen.text.primary }}
          >
            {t('earnings.set_goal', { defaultValue: 'Establecer meta del dia' })}
          </Text>
        </View>
        <Text
          variant="badge"
          style={{ color: midnightEmber.screen.text.secondary, marginTop: 4 }}
        >
          {t('earnings.set_goal_hint', { defaultValue: 'Define cuanto quieres ganar hoy' })}
        </Text>
      </Pressable>
    );
  }

  if (editing) {
    return (
      <View style={cardStyle}>
        <Text
          variant="body"
          className="font-semibold mb-3"
          style={{ color: midnightEmber.screen.text.primary }}
        >
          🎯 {t('earnings.daily_goal', { defaultValue: 'Meta del dia' })} (CUP)
        </Text>
        <View className="flex-row items-center gap-3">
          <TextInput
            style={{
              flex: 1,
              borderRadius: midnightEmber.radius.input,
              paddingHorizontal: 16,
              paddingVertical: 12,
              fontSize: 18,
              backgroundColor: midnightEmber.screen.bg.sunken,
              color: midnightEmber.screen.text.primary,
              borderWidth: 1,
              borderColor: midnightEmber.screen.line.default,
            }}
            value={inputValue}
            onChangeText={setInputValue}
            placeholder={goal > 0 ? String(goal) : '5000'}
            placeholderTextColor={midnightEmber.screen.text.tertiary}
            keyboardType="numeric"
            autoFocus
            onSubmitEditing={saveGoal}
            accessibilityLabel={t('earnings.goal_input', { defaultValue: 'Monto de meta diaria' })}
          />
          <Pressable
            onPress={saveGoal}
            style={{
              backgroundColor: midnightEmber.accent[500],
              borderRadius: midnightEmber.radius.input,
              paddingHorizontal: 20,
              minHeight: 48,
              justifyContent: 'center',
            }}
            accessibilityRole="button"
            accessibilityLabel={t('earnings.save_goal', { defaultValue: 'Guardar meta' })}
          >
            <Text
              variant="body"
              className="font-semibold"
              style={{ color: midnightEmber.screen.text.inverse }}
            >
              OK
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setEditing(false)}
            className="px-3 min-h-[48px] justify-center"
            accessibilityRole="button"
            accessibilityLabel={t('earnings.cancel', { defaultValue: 'Cancelar' })}
          >
            <Text variant="body" style={{ color: midnightEmber.screen.text.tertiary }}>
              ✕
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={cardStyle}>
      <View className="flex-row items-center justify-between mb-2">
        <Text
          variant="body"
          className="font-semibold"
          style={{ color: midnightEmber.screen.text.primary }}
        >
          🎯 {t('earnings.daily_goal', { defaultValue: 'Meta del dia' })}: {formatCUP(goal)}
        </Text>
        {pct >= 100 && <Text style={{ fontSize: 18 }}>🎉</Text>}
      </View>

      {/* Progress bar */}
      <View
        style={{
          height: 12,
          borderRadius: 9999,
          overflow: 'hidden',
          marginBottom: 8,
          backgroundColor: midnightEmber.screen.line.hairline,
        }}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: goal, now: Math.min(currentEarnings, goal) }}
      >
        <View
          style={{
            height: '100%',
            borderRadius: 9999,
            width: `${Math.round(pct)}%`,
            backgroundColor: progressColor,
          }}
        />
      </View>

      <View className="flex-row items-center justify-between">
        <Text
          variant="bodySmall"
          style={{ color: midnightEmber.screen.text.secondary }}
        >
          {formatCUP(currentEarnings)} / {formatCUP(goal)} — {Math.round(pct)}% {t('earnings.completed', { defaultValue: 'completado' })}
        </Text>
      </View>

      {milestoneLabel && (
        <Text
          variant="badge"
          style={{ color: progressColor, marginTop: 4, fontWeight: '600' }}
        >
          {milestoneLabel}
        </Text>
      )}

      <Pressable
        onPress={() => { setEditing(true); setInputValue(String(goal)); }}
        className="mt-2 min-h-[48px] justify-center"
        accessibilityRole="button"
        accessibilityLabel={t('earnings.change_goal', { defaultValue: 'Cambiar meta' })}
      >
        <Text variant="caption" style={{ color: midnightEmber.accent[500] }}>
          {t('earnings.change_goal', { defaultValue: 'Cambiar meta' })}
        </Text>
      </Pressable>
    </View>
  );
}
