import React, { useEffect, useState } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@tricigo/ui';
import {
  getOnlineStatus,
  onQueueChange,
  type QueuedMutation,
  type ProcessingStatus,
} from '@tricigo/api';
import { getOfflineActionLabel, getOfflineActionIcon, formatTimeAgo } from '@tricigo/utils/offlineLabels';
import { Ionicons } from '@expo/vector-icons';

/**
 * Enhanced offline banner (dark theme variant) with expandable pending actions queue.
 */
export function OfflineBanner() {
  const [isOnline, setIsOnline] = useState(true);
  const [mutations, setMutations] = useState<QueuedMutation[]>([]);
  const [processing, setProcessing] = useState<ProcessingStatus>({
    isProcessing: false,
    currentAction: null,
    currentIndex: 0,
    total: 0,
  });
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setIsOnline(getOnlineStatus());
    }, 2000);

    const unsubscribe = onQueueChange((queue, status) => {
      setMutations(queue);
      setProcessing(status);
    });

    return () => {
      clearInterval(interval);
      unsubscribe();
    };
  }, []);

  const pending = mutations.length;

  if (isOnline && pending === 0) return null;

  const progressPct = processing.isProcessing && processing.total > 0
    ? Math.round((processing.currentIndex / processing.total) * 100)
    : 0;

  return (
    <View className="bg-yellow-600">
      {/* Header */}
      <Pressable
        onPress={() => pending > 0 && setExpanded(!expanded)}
        className="px-4 py-2 flex-row items-center justify-between"
      >
        <View className="flex-row items-center gap-2 flex-1">
          <Ionicons
            name={!isOnline ? 'cloud-offline-outline' : 'sync-outline'}
            size={14}
            color="#1a1a1a"
          />
          <Text variant="caption" className="font-semibold text-neutral-900 flex-1" numberOfLines={1}>
            {processing.isProcessing && processing.currentAction
              ? `Sincronizando ${processing.currentIndex}/${processing.total}: ${getOfflineActionLabel(processing.currentAction)}...`
              : !isOnline
                ? `Sin conexión${pending > 0 ? ` · ${pending} pendiente${pending > 1 ? 's' : ''}` : ''}`
                : `Sincronizando ${pending} cambio${pending > 1 ? 's' : ''}...`}
          </Text>
        </View>
        {pending > 0 && (
          <Ionicons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={14}
            color="#1a1a1a"
          />
        )}
      </Pressable>

      {/* Progress bar */}
      {processing.isProcessing && (
        <View className="h-0.5 bg-yellow-700">
          <View
            className="h-full bg-green-600"
            style={{ width: `${progressPct}%` }}
          />
        </View>
      )}

      {/* Expanded queue */}
      {expanded && mutations.length > 0 && (
        <View className="px-4 pb-2">
          {mutations.map((m) => (
            <View key={m.id} className="flex-row items-center py-1.5 gap-2">
              <Ionicons
                name={getOfflineActionIcon(m.action) as any}
                size={14}
                color="#44403c"
              />
              <Text variant="caption" className="text-neutral-800 flex-1">
                {getOfflineActionLabel(m.action)}
              </Text>
              <Text variant="caption" className="text-neutral-700 opacity-70">
                {formatTimeAgo(m.timestamp)}
              </Text>
              {m.retries > 0 && (
                <Text variant="caption" className="text-red-800 font-medium">
                  {m.retries}/3
                </Text>
              )}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
