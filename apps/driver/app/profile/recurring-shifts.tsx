/**
 * Driver recurring shifts CRUD screen — Phase 1 D5.
 *
 * Driver-side equivalent to the rider's `/profile/recurring-rides`. The
 * driver pre-defines their typical work shifts (label + days × time
 * window + optional preferred zone). The system uses these to:
 *   - notify ~15 min before a scheduled shift starts (future scheduler)
 *   - surface contextual prompts on the home bottom sheet
 *   - measure shift adherence (planned vs actual online time)
 *
 * Backed by `driver_recurring_shifts` (migration 00259). Tolerates the
 * table being absent in prod (MCP guard) — getShifts returns [] and the
 * empty state renders normally. Writes will surface the Postgres error
 * to the user via toast if the migration isn't applied yet.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Pressable,
  Alert,
  ActivityIndicator,
  ScrollView,
  RefreshControl,
  Modal,
  TextInput,
  Text as RNText,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber } from '@tricigo/theme';
import { driverRecurringShiftService } from '@tricigo/api';
import { getErrorMessage, logger } from '@tricigo/utils';
import Toast from 'react-native-toast-message';
import { ErrorState } from '@tricigo/ui/ErrorState';
import type { DriverRecurringShift } from '@tricigo/types';
import { useDriverStore } from '@/stores/driver.store';

const DAY_KEYS = ['day_mon', 'day_tue', 'day_wed', 'day_thu', 'day_fri', 'day_sat', 'day_sun'] as const;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function formatNextOccurrence(dateStr: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('es-CU', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface ShiftFormState {
  label: string;
  days_of_week: number[];
  start_time: string;
  end_time: string;
}

const EMPTY_FORM: ShiftFormState = {
  label: '',
  days_of_week: [1, 2, 3, 4, 5], // default Mon–Fri
  start_time: '07:00',
  end_time: '15:00',
};

export default function RecurringShiftsScreen() {
  const { t } = useTranslation('driver');
  const driverProfile = useDriverStore((s) => s.profile);
  const driverId = driverProfile?.id ?? null;

  const [shifts, setShifts] = useState<DriverRecurringShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [editingShift, setEditingShift] = useState<DriverRecurringShift | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ShiftFormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  const fetchShifts = useCallback(async () => {
    if (!driverId) return;
    try {
      const data = await driverRecurringShiftService.getShifts(driverId);
      setShifts(data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [driverId]);

  useEffect(() => {
    fetchShifts();
  }, [fetchShifts]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchShifts();
    setRefreshing(false);
  }, [fetchShifts]);

  const handlePause = useCallback(async (id: string) => {
    setActionLoading(id);
    try {
      await driverRecurringShiftService.pauseShift(id);
      await fetchShifts();
      Toast.show({ type: 'success', text1: t('shifts.paused_success', { defaultValue: 'Turno pausado' }) });
    } catch (err) {
      logger.error('[shifts] pause failed', { error: String(err) });
      Toast.show({ type: 'error', text1: t('shifts.action_failed', { defaultValue: 'No se pudo pausar' }) });
    }
    setActionLoading(null);
  }, [fetchShifts, t]);

  const handleResume = useCallback(async (id: string) => {
    setActionLoading(id);
    try {
      await driverRecurringShiftService.resumeShift(id);
      await fetchShifts();
      Toast.show({ type: 'success', text1: t('shifts.resumed_success', { defaultValue: 'Turno reanudado' }) });
    } catch (err) {
      logger.error('[shifts] resume failed', { error: String(err) });
      Toast.show({ type: 'error', text1: t('shifts.action_failed', { defaultValue: 'No se pudo reanudar' }) });
    }
    setActionLoading(null);
  }, [fetchShifts, t]);

  const handleDelete = useCallback((id: string) => {
    Alert.alert(
      t('shifts.delete_confirm', { defaultValue: 'Eliminar turno' }),
      t('shifts.delete_confirm_body', { defaultValue: 'Se eliminará este turno recurrente. Tus turnos pasados no se ven afectados.' }),
      [
        { text: t('common.cancel', { defaultValue: 'Cancelar' }), style: 'cancel' },
        {
          text: t('shifts.delete', { defaultValue: 'Eliminar' }),
          style: 'destructive',
          onPress: async () => {
            setActionLoading(id);
            try {
              await driverRecurringShiftService.deleteShift(id);
              await fetchShifts();
              Toast.show({ type: 'success', text1: t('shifts.deleted_success', { defaultValue: 'Turno eliminado' }) });
            } catch (err) {
              logger.error('[shifts] delete failed', { error: String(err) });
              Toast.show({ type: 'error', text1: t('shifts.action_failed', { defaultValue: 'No se pudo eliminar' }) });
            }
            setActionLoading(null);
          },
        },
      ],
    );
  }, [fetchShifts, t]);

  const openCreate = useCallback(() => {
    setEditingShift(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  }, []);

  const openEdit = useCallback((shift: DriverRecurringShift) => {
    setEditingShift(shift);
    setForm({
      label: shift.label ?? '',
      days_of_week: shift.days_of_week,
      start_time: shift.start_time.slice(0, 5),
      end_time: shift.end_time.slice(0, 5),
    });
    setShowForm(true);
  }, []);

  const closeForm = useCallback(() => {
    setShowForm(false);
    setEditingShift(null);
  }, []);

  const toggleDay = useCallback((day: number) => {
    setForm((f) => ({
      ...f,
      days_of_week: f.days_of_week.includes(day)
        ? f.days_of_week.filter((d) => d !== day)
        : [...f.days_of_week, day].sort(),
    }));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!driverId) return;
    // Validate
    if (!HHMM_RE.test(form.start_time) || !HHMM_RE.test(form.end_time)) {
      Toast.show({
        type: 'error',
        text1: t('shifts.invalid_time', { defaultValue: 'Hora inválida (formato HH:MM)' }),
      });
      return;
    }
    if (form.start_time === form.end_time) {
      Toast.show({
        type: 'error',
        text1: t('shifts.same_times', { defaultValue: 'Inicio y fin no pueden coincidir' }),
      });
      return;
    }
    if (form.days_of_week.length === 0) {
      Toast.show({
        type: 'error',
        text1: t('shifts.no_days', { defaultValue: 'Elegí al menos un día' }),
      });
      return;
    }

    setSubmitting(true);
    try {
      if (editingShift) {
        await driverRecurringShiftService.updateShift(editingShift.id, {
          label: form.label.trim() || null,
          days_of_week: form.days_of_week,
          start_time: form.start_time,
          end_time: form.end_time,
        });
        Toast.show({ type: 'success', text1: t('shifts.updated_success', { defaultValue: 'Turno actualizado' }) });
      } else {
        await driverRecurringShiftService.createShift({
          driver_id: driverId,
          label: form.label.trim() || null,
          days_of_week: form.days_of_week,
          start_time: form.start_time,
          end_time: form.end_time,
        });
        Toast.show({ type: 'success', text1: t('shifts.created_success', { defaultValue: 'Turno creado' }) });
      }
      closeForm();
      await fetchShifts();
    } catch (err: unknown) {
      const errCode = (err as { code?: string }).code;
      logger.error('[shifts] submit failed', { error: String(err) });
      if (errCode === 'MAX_SHIFTS') {
        Toast.show({
          type: 'error',
          text1: t('shifts.max_reached', { defaultValue: 'Máximo 10 turnos por conductor' }),
        });
      } else {
        Toast.show({
          type: 'error',
          text1: t('shifts.action_failed', { defaultValue: 'No se pudo guardar' }),
          text2: getErrorMessage(err),
        });
      }
    } finally {
      setSubmitting(false);
    }
  }, [driverId, form, editingShift, closeForm, fetchShifts, t]);

  if (error) {
    return (
      <ErrorState
        title="Error"
        description={error}
        onRetry={() => { setError(null); setLoading(true); fetchShifts(); }}
      />
    );
  }

  return (
    <Screen>
      <ScreenHeader
        title={t('shifts.title', { defaultValue: 'Turnos recurrentes' })}
        onBack={() => router.back()}
        rightAction={
          <Pressable onPress={openCreate} hitSlop={8} accessibilityLabel={t('shifts.create', { defaultValue: 'Crear turno' })}>
            <Ionicons name="add-circle-outline" size={26} color={midnightEmber.accent[500]} />
          </Pressable>
        }
      />

      {loading ? (
        <View style={styles.centerFill}>
          <ActivityIndicator size="large" color={midnightEmber.accent[500]} />
        </View>
      ) : shifts.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="calendar-outline" size={48} color={midnightEmber.screen.text.tertiary} />
          <Text variant="body" color="secondary" style={{ marginTop: 16, textAlign: 'center', fontWeight: '600' }}>
            {t('shifts.empty', { defaultValue: 'Aún no tenés turnos definidos' })}
          </Text>
          <Text variant="caption" color="tertiary" style={{ marginTop: 4, textAlign: 'center', maxWidth: 280 }}>
            {t('shifts.empty_description', {
              defaultValue: 'Definí tus horarios típicos (ej: lunes a viernes 7am-3pm) y te avisamos cuando empieza tu turno.',
            })}
          </Text>
          <Button
            title={t('shifts.create', { defaultValue: 'Crear turno' })}
            size="md"
            onPress={openCreate}
            style={{ marginTop: 24 }}
          />
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, gap: 12, paddingBottom: 32 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={midnightEmber.accent[500]} />
          }
        >
          {shifts.map((shift) => (
            <Card key={shift.id} variant="outlined" padding="md">
              {/* Header: label + status */}
              <View style={styles.shiftHeader}>
                <View style={{ flex: 1 }}>
                  <Text variant="body" color="primary" style={{ fontWeight: '600' }}>
                    {shift.label?.trim() || t('shifts.unnamed', { defaultValue: 'Turno' })}
                  </Text>
                  <Text variant="caption" color="secondary" style={{ marginTop: 2 }}>
                    {shift.start_time.slice(0, 5)} – {shift.end_time.slice(0, 5)}
                  </Text>
                </View>
                <StatusBadge
                  label={
                    shift.status === 'active'
                      ? t('shifts.status_active', { defaultValue: 'Activo' })
                      : t('shifts.status_paused', { defaultValue: 'Pausado' })
                  }
                  variant={shift.status === 'active' ? 'success' : 'neutral'}
                />
              </View>

              {/* Days-of-week chips */}
              <View style={styles.daysRow}>
                {[1, 2, 3, 4, 5, 6, 7].map((day) => {
                  const isActive = shift.days_of_week.includes(day);
                  return (
                    <View
                      key={day}
                      style={[
                        styles.dayChip,
                        {
                          backgroundColor: isActive
                            ? midnightEmber.accent[500]
                            : midnightEmber.screen.bg.sunken,
                        },
                      ]}
                    >
                      <RNText
                        style={{
                          fontSize: 11,
                          fontWeight: '600',
                          color: isActive
                            ? midnightEmber.screen.text.inverse
                            : midnightEmber.screen.text.tertiary,
                        }}
                      >
                        {t(`shifts.${DAY_KEYS[day - 1]}`, {
                          defaultValue: ['L', 'M', 'X', 'J', 'V', 'S', 'D'][day - 1],
                        })}
                      </RNText>
                    </View>
                  );
                })}
              </View>

              {/* Next occurrence */}
              {shift.next_occurrence_at && shift.status === 'active' && (
                <Text variant="caption" color="tertiary" style={{ marginBottom: 8 }}>
                  {t('shifts.next_at', {
                    date: formatNextOccurrence(shift.next_occurrence_at),
                    defaultValue: `Próximo: ${formatNextOccurrence(shift.next_occurrence_at)}`,
                  })}
                </Text>
              )}

              {/* Actions */}
              <View style={styles.actionsRow}>
                {actionLoading === shift.id ? (
                  <ActivityIndicator size="small" color={midnightEmber.accent[500]} />
                ) : (
                  <>
                    <Pressable
                      onPress={() => (shift.status === 'active' ? handlePause(shift.id) : handleResume(shift.id))}
                      style={({ pressed }) => [styles.actionPill, { opacity: pressed ? 0.7 : 1 }]}
                    >
                      <Ionicons
                        name={shift.status === 'active' ? 'pause-outline' : 'play-outline'}
                        size={14}
                        color={midnightEmber.screen.text.secondary}
                      />
                      <RNText style={styles.actionPillText}>
                        {shift.status === 'active'
                          ? t('shifts.pause', { defaultValue: 'Pausar' })
                          : t('shifts.resume', { defaultValue: 'Reanudar' })}
                      </RNText>
                    </Pressable>
                    <Pressable
                      onPress={() => openEdit(shift)}
                      style={({ pressed }) => [styles.actionPill, { opacity: pressed ? 0.7 : 1 }]}
                    >
                      <Ionicons name="pencil-outline" size={14} color={midnightEmber.screen.text.secondary} />
                      <RNText style={styles.actionPillText}>
                        {t('shifts.edit', { defaultValue: 'Editar' })}
                      </RNText>
                    </Pressable>
                    <Pressable
                      onPress={() => handleDelete(shift.id)}
                      style={({ pressed }) => [
                        styles.actionPill,
                        {
                          backgroundColor: `${midnightEmber.state.danger}1F`,
                          opacity: pressed ? 0.7 : 1,
                        },
                      ]}
                    >
                      <Ionicons name="trash-outline" size={14} color={midnightEmber.state.danger} />
                      <RNText style={[styles.actionPillText, { color: midnightEmber.state.danger }]}>
                        {t('shifts.delete', { defaultValue: 'Eliminar' })}
                      </RNText>
                    </Pressable>
                  </>
                )}
              </View>
            </Card>
          ))}
        </ScrollView>
      )}

      {/* Create / edit modal — inline to avoid extra route files */}
      <Modal visible={showForm} animationType="slide" transparent onRequestClose={closeForm}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
              <View style={styles.modalHeader}>
                <Text variant="h3" color="primary">
                  {editingShift
                    ? t('shifts.edit_title', { defaultValue: 'Editar turno' })
                    : t('shifts.create_title', { defaultValue: 'Nuevo turno' })}
                </Text>
                <Pressable onPress={closeForm} hitSlop={12} accessibilityLabel={t('common.close', { defaultValue: 'Cerrar' })}>
                  <Ionicons name="close" size={24} color={midnightEmber.screen.text.secondary} />
                </Pressable>
              </View>

              {/* Label (optional) */}
              <Text variant="caption" color="secondary" style={{ marginTop: 16, marginBottom: 6 }}>
                {t('shifts.label_field', { defaultValue: 'Nombre (opcional)' })}
              </Text>
              <TextInput
                value={form.label}
                onChangeText={(v) => setForm((f) => ({ ...f, label: v }))}
                placeholder={t('shifts.label_placeholder', { defaultValue: 'Ej: Mañana Vedado' })}
                placeholderTextColor={midnightEmber.screen.text.tertiary}
                style={styles.input}
                maxLength={40}
              />

              {/* Days of week */}
              <Text variant="caption" color="secondary" style={{ marginTop: 16, marginBottom: 6 }}>
                {t('shifts.days_field', { defaultValue: 'Días' })}
              </Text>
              <View style={styles.daysRowSelectable}>
                {[1, 2, 3, 4, 5, 6, 7].map((day) => {
                  const isActive = form.days_of_week.includes(day);
                  return (
                    <Pressable
                      key={day}
                      onPress={() => toggleDay(day)}
                      style={({ pressed }) => [
                        styles.dayChipSelectable,
                        {
                          backgroundColor: isActive
                            ? midnightEmber.accent[500]
                            : midnightEmber.screen.bg.sunken,
                          opacity: pressed ? 0.7 : 1,
                        },
                      ]}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: isActive }}
                    >
                      <RNText
                        style={{
                          fontSize: 13,
                          fontWeight: '600',
                          color: isActive
                            ? midnightEmber.screen.text.inverse
                            : midnightEmber.screen.text.tertiary,
                        }}
                      >
                        {t(`shifts.${DAY_KEYS[day - 1]}`, {
                          defaultValue: ['L', 'M', 'X', 'J', 'V', 'S', 'D'][day - 1],
                        })}
                      </RNText>
                    </Pressable>
                  );
                })}
              </View>

              {/* Start + end time */}
              <View style={{ flexDirection: 'row', gap: 12, marginTop: 16 }}>
                <View style={{ flex: 1 }}>
                  <Text variant="caption" color="secondary" style={{ marginBottom: 6 }}>
                    {t('shifts.start_time_field', { defaultValue: 'Inicio' })}
                  </Text>
                  <TextInput
                    value={form.start_time}
                    onChangeText={(v) => setForm((f) => ({ ...f, start_time: v }))}
                    placeholder="07:00"
                    placeholderTextColor={midnightEmber.screen.text.tertiary}
                    style={styles.input}
                    keyboardType="numbers-and-punctuation"
                    maxLength={5}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text variant="caption" color="secondary" style={{ marginBottom: 6 }}>
                    {t('shifts.end_time_field', { defaultValue: 'Fin' })}
                  </Text>
                  <TextInput
                    value={form.end_time}
                    onChangeText={(v) => setForm((f) => ({ ...f, end_time: v }))}
                    placeholder="15:00"
                    placeholderTextColor={midnightEmber.screen.text.tertiary}
                    style={styles.input}
                    keyboardType="numbers-and-punctuation"
                    maxLength={5}
                  />
                </View>
              </View>

              {/* Submit */}
              <Button
                title={
                  submitting
                    ? t('common.saving', { defaultValue: 'Guardando…' })
                    : editingShift
                      ? t('shifts.save', { defaultValue: 'Guardar cambios' })
                      : t('shifts.create_btn', { defaultValue: 'Crear turno' })
                }
                onPress={handleSubmit}
                disabled={submitting}
                size="md"
                style={{ marginTop: 24 }}
              />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  centerFill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  shiftHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 12,
    gap: 12,
  },
  daysRow: {
    flexDirection: 'row',
    gap: 4,
    marginBottom: 8,
  },
  dayChip: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  daysRowSelectable: {
    flexDirection: 'row',
    gap: 6,
    flexWrap: 'wrap',
  },
  dayChipSelectable: {
    minWidth: 44,
    height: 44,
    paddingHorizontal: 10,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: midnightEmber.screen.line.default,
  },
  actionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 44,
    borderRadius: midnightEmber.radius.input,
    backgroundColor: midnightEmber.screen.bg.sunken,
  },
  actionPillText: {
    fontSize: 12,
    fontWeight: '500',
    color: midnightEmber.screen.text.secondary,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: midnightEmber.screen.bg.canvas,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '85%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  input: {
    backgroundColor: midnightEmber.screen.bg.sunken,
    borderRadius: midnightEmber.radius.input,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: midnightEmber.screen.text.primary,
    minHeight: 48,
  },
});
