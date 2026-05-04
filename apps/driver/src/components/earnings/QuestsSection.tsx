/**
 * QuestsSection — extracted from apps/driver/app/(tabs)/earnings.tsx
 * for PR-A.
 *
 * Renders the "Misiones" header and a list of quests with progress.
 * If `quests` is empty, shows the "No hay misiones activas" tertiary
 * line — header still renders so the section's identity is consistent
 * across visits.
 *
 * Each quest card shows:
 *   - Title (localised; falls back to es)
 *   - Description (localised)
 *   - Reward CUP chip
 *   - Progress bar (success colour when completed, brand orange while
 *     in progress)
 *   - "current / target ¡Completada! / restante" caption
 *
 * Visual + tokens preserved verbatim from the inline version.
 * Migration to midnightEmber happens in PR-B.
 */
import React from 'react';
import { View } from 'react-native';
import i18next from 'i18next';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { formatCUP } from '@tricigo/utils';
import { colors, driverStandardLightColors } from '@tricigo/theme';
import type { QuestWithProgress } from '@tricigo/types';

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

interface QuestsSectionProps {
  quests: QuestWithProgress[];
}

export function QuestsSection({ quests }: QuestsSectionProps) {
  const { t } = useTranslation('driver');
  const langKey = i18next.language === 'en' ? 'en' : 'es';

  return (
    <View className="mt-8">
      <Text variant="h4" style={{ color: lt.text.primary }} className="mb-3">
        {t('earnings.quests_title', { defaultValue: 'Misiones' })}
      </Text>
      {quests.length === 0 ? (
        <Text variant="bodySmall" style={{ color: lt.text.tertiary }}>
          {t('earnings.no_quests', { defaultValue: 'No hay misiones activas' })}
        </Text>
      ) : (
        quests.map((q) => {
          const isCompleted = !!q.progress?.completed_at;
          const current = q.progress?.current_value ?? 0;
          const progress = Math.min(current / q.target_value, 1);
          const qAny = q as unknown as Record<string, unknown>;
          const title = (qAny[`title_${langKey}`] as string | undefined) ?? q.title_es;
          const desc = (qAny[`description_${langKey}`] as string | undefined) ?? q.description_es;

          return (
            <Card
              key={q.id}
              variant="filled"
              padding="md"
              className="mb-3"
              style={{
                backgroundColor: isCompleted ? 'rgba(34,197,94,0.08)' : CARD_BG,
                borderWidth: 1,
                borderColor: isCompleted ? 'rgba(34,197,94,0.2)' : BORDER_SUBTLE,
                borderRadius: 16,
                ...CARD_SHADOW,
              }}
            >
              <View className="flex-row items-center justify-between mb-1">
                <Text variant="body" className="font-semibold flex-1 mr-2" style={{ color: lt.text.primary }}>
                  {isCompleted ? '✅ ' : ''}{title}
                </Text>
                <Text variant="badge" style={{ color: colors.brand.orange, fontWeight: '700' }}>
                  +{formatCUP(q.reward_cup)}
                </Text>
              </View>
              <Text variant="caption" style={{ color: lt.text.secondary }} className="mb-2">
                {desc}
              </Text>
              {/* Progress bar */}
              <View
                className="h-2 rounded-full overflow-hidden mb-1"
                style={{ backgroundColor: lt.border.subtle }}
                accessibilityRole="progressbar"
                accessibilityValue={{ min: 0, max: q.target_value, now: current }}
              >
                <View
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.round(progress * 100)}%`,
                    backgroundColor: isCompleted ? colors.success.DEFAULT : colors.brand.orange,
                  }}
                />
              </View>
              <Text variant="badge" style={{ color: lt.text.secondary }}>
                {current} / {q.target_value} {isCompleted
                  ? t('earnings.quest_completed', { defaultValue: '¡Completada!' })
                  : t('earnings.quest_remaining', { defaultValue: 'restante' })}
              </Text>
            </Card>
          );
        })
      )}
    </View>
  );
}
