/**
 * EarningsGoalCard — extracted from apps/driver/app/(tabs)/earnings.tsx
 * for PR-A.
 *
 * Three internal states:
 *   1. No goal yet (goal === 0 && !editing) → minimal "Establecer meta
 *      del día" CTA card.
 *   2. Editing → input + Save / Cancel buttons.
 *   3. Goal set → progress bar + percentage + milestone label.
 *
 * Behaviour preserved verbatim:
 *   - Goal persisted in AsyncStorage at @tricigo/earnings_goal.
 *   - Milestone toasts (25 / 50 / 75 / 100 %) fire once per day,
 *     persisted under @tricigo/milestone_shown_<YYYY-MM-DD>.
 *   - BUG-079 day-rollover reset is preserved.
 *   - HF-3 goal validation (1..999999) is preserved.
 *
 * Visual + tokens preserved verbatim from the inline version. Migration
 * to midnightEmber happens in PR-B.
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, Pressable, TextInput } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Toast from 'react-native-toast-message';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { formatCUP } from '@tricigo/utils';
import { colors, driverStandardLightColors } from '@tricigo/theme';

const lt = driverStandardLightColors;
const CARD_BG = lt.card;
const BORDER_SUBTLE = lt.border.default;
const CARD_SHADOW = {
  shadowColor: '#000',
  shadowOpacity: 0.04,
  shadowRadius: 8,
  shadowOffset: { width: 0, height: 2 },
  elevation: 2,
};

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
  const progressColor = pct >= 75 ? colors.success.DEFAULT : pct >= 50 ? '#eab308' : '#ef4444';

  const milestoneLabel = pct >= 100
    ? t('earnings.milestone_100', { defaultValue: 'Meta cumplida!' })
    : pct >= 75
      ? t('earnings.milestone_75', { defaultValue: 'Casi llegas!' })
      : pct >= 50
        ? t('earnings.milestone_50', { defaultValue: 'Mitad del camino!' })
        : pct >= 25
          ? t('earnings.milestone_25', { defaultValue: 'Buen inicio!' })
          : null;

  if (goal <= 0 && !editing) {
    return (
      <Pressable
        onPress={() => { setEditing(true); setInputValue(''); }}
        className="rounded-2xl p-4 mb-4"
        style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, ...CARD_SHADOW }}
        accessibilityRole="button"
        accessibilityLabel={t('earnings.set_goal', { defaultValue: 'Establecer meta del dia' })}
      >
        <View className="flex-row items-center">
          <Text style={{ fontSize: 20, marginRight: 8 }}>🎯</Text>
          <Text variant="body" className="font-semibold" style={{ color: lt.text.primary }}>
            {t('earnings.set_goal', { defaultValue: 'Establecer meta del dia' })}
          </Text>
        </View>
        <Text variant="badge" style={{ color: lt.text.secondary }} className="mt-1">
          {t('earnings.set_goal_hint', { defaultValue: 'Define cuanto quieres ganar hoy' })}
        </Text>
      </Pressable>
    );
  }

  if (editing) {
    return (
      <View
        className="rounded-2xl p-4 mb-4"
        style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, ...CARD_SHADOW }}
      >
        <Text variant="body" className="font-semibold mb-3" style={{ color: lt.text.primary }}>
          🎯 {t('earnings.daily_goal', { defaultValue: 'Meta del dia' })} (CUP)
        </Text>
        <View className="flex-row items-center gap-3">
          <TextInput
            className="flex-1 rounded-xl px-4 py-3 text-lg"
            style={{ backgroundColor: lt.background.tertiary, color: lt.text.primary, fontSize: 18, borderWidth: 1, borderColor: lt.border.default }}
            value={inputValue}
            onChangeText={setInputValue}
            placeholder={goal > 0 ? String(goal) : '5000'}
            placeholderTextColor={lt.text.tertiary}
            keyboardType="numeric"
            autoFocus
            onSubmitEditing={saveGoal}
            accessibilityLabel={t('earnings.goal_input', { defaultValue: 'Monto de meta diaria' })}
          />
          <Pressable
            onPress={saveGoal}
            className="bg-primary-500 rounded-xl px-5 min-h-[48px] justify-center"
            accessibilityRole="button"
            accessibilityLabel={t('earnings.save_goal', { defaultValue: 'Guardar meta' })}
          >
            <Text variant="body" color="inverse" className="font-semibold">OK</Text>
          </Pressable>
          <Pressable
            onPress={() => setEditing(false)}
            className="px-3 min-h-[48px] justify-center"
            accessibilityRole="button"
            accessibilityLabel={t('earnings.cancel', { defaultValue: 'Cancelar' })}
          >
            <Text variant="body" style={{ color: lt.text.tertiary }}>✕</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View
      className="rounded-2xl p-4 mb-4"
      style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, ...CARD_SHADOW }}
    >
      <View className="flex-row items-center justify-between mb-2">
        <Text variant="body" className="font-semibold" style={{ color: lt.text.primary }}>
          🎯 {t('earnings.daily_goal', { defaultValue: 'Meta del dia' })}: {formatCUP(goal)}
        </Text>
        {pct >= 100 && <Text style={{ fontSize: 18 }}>🎉</Text>}
      </View>

      {/* Progress bar */}
      <View
        className="h-3 rounded-full overflow-hidden mb-2"
        style={{ backgroundColor: lt.border.subtle }}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: goal, now: Math.min(currentEarnings, goal) }}
      >
        <View
          className="h-full rounded-full"
          style={{ width: `${Math.round(pct)}%`, backgroundColor: progressColor }}
        />
      </View>

      <View className="flex-row items-center justify-between">
        <Text variant="bodySmall" style={{ color: lt.text.secondary }}>
          {formatCUP(currentEarnings)} / {formatCUP(goal)} — {Math.round(pct)}% {t('earnings.completed', { defaultValue: 'completado' })}
        </Text>
      </View>

      {milestoneLabel && (
        <Text variant="badge" style={{ color: progressColor, marginTop: 4, fontWeight: '600' }}>
          {milestoneLabel}
        </Text>
      )}

      <Pressable
        onPress={() => { setEditing(true); setInputValue(String(goal)); }}
        className="mt-2 min-h-[48px] justify-center"
        accessibilityRole="button"
        accessibilityLabel={t('earnings.change_goal', { defaultValue: 'Cambiar meta' })}
      >
        <Text variant="caption" className="text-primary-400">
          {t('earnings.change_goal', { defaultValue: 'Cambiar meta' })}
        </Text>
      </Pressable>
    </View>
  );
}
