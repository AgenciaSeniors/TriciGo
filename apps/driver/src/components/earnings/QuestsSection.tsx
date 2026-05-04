/**
 * QuestsSection — Midnight Ember edition (PR-B).
 *
 * "Misiones" header + quest progress list. Empty state shows the
 * "No hay misiones activas" tertiary line.
 *
 * v2 tokenization:
 *   - Active quest card: `screen.bg.surface` + `line.default` border.
 *   - Completed quest card: `state.success` family at ~12% tint background +
 *     ~33% border (replaces `rgba(34,197,94,0.08)` / `rgba(34,197,94,0.2)`
 *     literals).
 *   - Reward chip + in-progress bar fill: `accent[500]`.
 *   - Completed bar fill: `state.success`.
 *   - Headers + labels via `screen.text.*`.
 */
import React from 'react';
import { View } from 'react-native';
import i18next from 'i18next';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { formatCUP } from '@tricigo/utils';
import { midnightEmber } from '@tricigo/theme';
import type { QuestWithProgress } from '@tricigo/types';

interface QuestsSectionProps {
  quests: QuestWithProgress[];
}

/** Append two hex digits (alpha) to a `#rrggbb` color. */
function tinted(color: string, alphaHex: string): string {
  return `${color}${alphaHex}`;
}

export function QuestsSection({ quests }: QuestsSectionProps) {
  const { t } = useTranslation('driver');
  const langKey = i18next.language === 'en' ? 'en' : 'es';

  // PR-C: hide the section entirely when there are no active challenges.
  // Showing an empty header + "Sin retos activos" line was visual
  // noise (the section's whole purpose is the list).
  if (quests.length === 0) return null;

  return (
    <View className="mt-8">
      <Text
        variant="h4"
        style={{ color: midnightEmber.screen.text.primary, marginBottom: 12 }}
      >
        {t('earnings.quests_title', { defaultValue: 'Tus retos' })}
      </Text>
      {quests.map((q) => {
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
                backgroundColor: isCompleted
                  ? tinted(midnightEmber.state.success, '1F') // ~12%
                  : midnightEmber.screen.bg.surface,
                borderWidth: 1,
                borderColor: isCompleted
                  ? tinted(midnightEmber.state.success, '52') // ~32%
                  : midnightEmber.screen.line.default,
                borderRadius: midnightEmber.radius.card,
                ...midnightEmber.shadow.card,
              }}
            >
              <View className="flex-row items-center justify-between mb-1">
                <Text
                  variant="body"
                  className="font-semibold flex-1 mr-2"
                  style={{ color: midnightEmber.screen.text.primary }}
                >
                  {isCompleted ? '✅ ' : ''}{title}
                </Text>
                <Text
                  variant="badge"
                  style={{ color: midnightEmber.accent[500], fontWeight: '700' }}
                >
                  +{formatCUP(q.reward_cup)}
                </Text>
              </View>
              <Text
                variant="caption"
                style={{ color: midnightEmber.screen.text.secondary, marginBottom: 8 }}
              >
                {desc}
              </Text>
              {/* Progress bar */}
              <View
                style={{
                  height: 8,
                  borderRadius: 9999,
                  overflow: 'hidden',
                  marginBottom: 4,
                  backgroundColor: midnightEmber.screen.line.hairline,
                }}
                accessibilityRole="progressbar"
                accessibilityValue={{ min: 0, max: q.target_value, now: current }}
              >
                <View
                  style={{
                    height: '100%',
                    borderRadius: 9999,
                    width: `${Math.round(progress * 100)}%`,
                    backgroundColor: isCompleted
                      ? midnightEmber.state.success
                      : midnightEmber.accent[500],
                  }}
                />
              </View>
              <Text
                variant="badge"
                style={{ color: midnightEmber.screen.text.secondary }}
              >
                {current} / {q.target_value} {isCompleted
                  ? t('earnings.quest_completed', { defaultValue: '¡Completaste!' })
                  : t('earnings.quest_remaining', { defaultValue: 'restante' })}
              </Text>
            </Card>
          );
        })}
    </View>
  );
}
