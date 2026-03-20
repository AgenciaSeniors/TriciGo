import React, { useState, useEffect, useCallback } from 'react';
import { View, FlatList, Alert, Pressable } from 'react-native';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { Input } from '@tricigo/ui/Input';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { formatTRC } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { useRouter } from 'expo-router';
import { useCorporateAccounts } from '@/hooks/useCorporateAccounts';
import { useAuthStore } from '@/stores/auth.store';
import { corporateService } from '@tricigo/api';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@tricigo/theme';
import type { CorporateEmployeeWithUser, CorporateEmployeeRole, CorporateBillingSummary, CorporateRide } from '@tricigo/types';

export default function CorporateProfileScreen() {
  const { t } = useTranslation('rider');
  const router = useRouter();
  const userId = useAuthStore((s) => s.user?.id);
  const { accounts, loading } = useCorporateAccounts();

  // Employee management state
  const [expandedAccountId, setExpandedAccountId] = useState<string | null>(null);
  const [employees, setEmployees] = useState<CorporateEmployeeWithUser[]>([]);
  const [loadingEmployees, setLoadingEmployees] = useState(false);
  const [myRole, setMyRole] = useState<CorporateEmployeeRole | null>(null);

  // Add employee sheet
  const [addSheetVisible, setAddSheetVisible] = useState(false);
  const [newPhone, setNewPhone] = useState('');
  const [newRole, setNewRole] = useState<CorporateEmployeeRole>('employee');
  const [addingEmployee, setAddingEmployee] = useState(false);

  // Billing state
  const [billingExpanded, setBillingExpanded] = useState<string | null>(null);
  const [billingSummary, setBillingSummary] = useState<CorporateBillingSummary | null>(null);
  const [corporateBalance, setCorporateBalance] = useState<number | null>(null);
  const [corporateRides, setCorporateRides] = useState<CorporateRide[]>([]);
  const [loadingBilling, setLoadingBilling] = useState(false);

  const loadEmployees = useCallback(async (accountId: string) => {
    setLoadingEmployees(true);
    try {
      const [emps, role] = await Promise.all([
        corporateService.getEmployees(accountId),
        userId ? corporateService.getEmployeeRole(accountId, userId) : null,
      ]);
      setEmployees(emps);
      setMyRole(role);
    } catch {
      setEmployees([]);
      setMyRole(null);
    } finally {
      setLoadingEmployees(false);
    }
  }, [userId]);

  const handleToggleEmployees = (accountId: string) => {
    if (expandedAccountId === accountId) {
      setExpandedAccountId(null);
      setEmployees([]);
      setMyRole(null);
    } else {
      setExpandedAccountId(accountId);
      loadEmployees(accountId);
    }
  };

  const handleAddEmployee = async () => {
    if (!expandedAccountId || !newPhone.trim() || !userId) return;
    setAddingEmployee(true);
    try {
      await corporateService.addEmployee(expandedAccountId, newPhone.trim(), newRole, userId);
      setAddSheetVisible(false);
      setNewPhone('');
      setNewRole('employee');
      await loadEmployees(expandedAccountId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('common:errors.generic', { defaultValue: 'Error' });
      Alert.alert(t('common:error', { defaultValue: 'Error' }), msg);
    } finally {
      setAddingEmployee(false);
    }
  };

  const handleRemoveEmployee = (empUserId: string, empName: string) => {
    if (!expandedAccountId) return;
    Alert.alert(
      t('corporate.remove_employee_title', { defaultValue: 'Remover empleado' }),
      t('corporate.remove_employee_confirm', { defaultValue: 'Remover a {{name}}?', name: empName }),
      [
        { text: t('common:cancel', { defaultValue: 'Cancelar' }), style: 'cancel' },
        {
          text: t('common:delete', { defaultValue: 'Eliminar' }),
          style: 'destructive',
          onPress: async () => {
            try {
              await corporateService.removeEmployee(expandedAccountId, empUserId);
              await loadEmployees(expandedAccountId);
            } catch {
              Alert.alert(t('common:error', { defaultValue: 'Error' }), t('common:errors.generic', { defaultValue: 'No se pudo completar la acción' }));
            }
          },
        },
      ],
    );
  };

  const handleToggleBilling = useCallback(async (accountId: string) => {
    if (billingExpanded === accountId) {
      setBillingExpanded(null);
      return;
    }
    setBillingExpanded(accountId);
    setLoadingBilling(true);
    try {
      const [summary, balance, rides] = await Promise.all([
        corporateService.getBillingSummary(accountId),
        corporateService.getCorporateBalance(accountId),
        corporateService.getCorporateRides(accountId, 0, 10),
      ]);
      setBillingSummary(summary);
      setCorporateBalance(balance);
      setCorporateRides(rides);
    } catch {
      setBillingSummary(null);
      setCorporateBalance(null);
      setCorporateRides([]);
    } finally {
      setLoadingBilling(false);
    }
  }, [billingExpanded]);

  const isAdmin = myRole === 'admin';

  return (
    <Screen bg="white" padded scroll>
      <ScreenHeader
        title={t('corporate.title', { defaultValue: 'Cuenta Corporativa' })}
        onBack={() => router.back()}
      />

      {loading && (
        <Text variant="body" color="secondary" className="text-center mt-8">
          {t('common:loading', { defaultValue: 'Cargando...' })}
        </Text>
      )}

      {!loading && accounts.length === 0 && (
        <View className="items-center mt-12">
          <Ionicons name="business-outline" size={48} color={colors.neutral[300]} />
          <Text variant="body" color="secondary" className="mt-4 text-center">
            {t('corporate.no_membership')}
          </Text>
        </View>
      )}

      {accounts.map((acc) => (
        <Card key={acc.id} variant="outlined" padding="lg" className="mb-4 mt-4">
          <View className="flex-row items-center justify-between mb-3">
            <Text variant="h4">{acc.name}</Text>
            <StatusBadge
              label={acc.status}
              variant={acc.status === 'active' ? 'success' : acc.status === 'suspended' ? 'error' : 'warning'}
            />
          </View>

          <View className="mb-3">
            <Text variant="caption" color="secondary">
              {t('corporate.contact', { defaultValue: 'Contacto' })}
            </Text>
            <Text variant="body">{acc.contact_phone}</Text>
            {acc.contact_email && (
              <Text variant="bodySmall" color="secondary">{acc.contact_email}</Text>
            )}
          </View>

          {acc.monthly_budget_trc > 0 && (
            <View className="mb-3">
              <Text variant="caption" color="secondary">
                {t('corporate.budget_remaining')}
              </Text>
              <View className="flex-row items-center mt-1">
                <View
                  className="h-2 rounded-full bg-primary-500"
                  style={{
                    width: `${Math.max(0, Math.min(100, ((acc.monthly_budget_trc - acc.current_month_spent) / acc.monthly_budget_trc) * 100))}%`,
                  }}
                />
                <View className="h-2 flex-1 rounded-full bg-neutral-200" />
              </View>
              <Text variant="caption" color="accent" className="mt-1">
                {formatTRC(acc.monthly_budget_trc - acc.current_month_spent)} / {formatTRC(acc.monthly_budget_trc)}
              </Text>
            </View>
          )}

          {acc.per_ride_cap_trc > 0 && (
            <View className="mb-3">
              <Text variant="caption" color="secondary">
                {t('corporate.per_ride_cap', { defaultValue: 'Máximo por viaje' })}
              </Text>
              <Text variant="body">{formatTRC(acc.per_ride_cap_trc)}</Text>
            </View>
          )}

          {acc.allowed_service_types.length > 0 && (
            <View className="mb-3">
              <Text variant="caption" color="secondary">
                {t('corporate.allowed_services', { defaultValue: 'Servicios permitidos' })}
              </Text>
              <Text variant="body">{acc.allowed_service_types.join(', ')}</Text>
            </View>
          )}

          {acc.allowed_hours_start && acc.allowed_hours_end && (
            <View className="mb-3">
              <Text variant="caption" color="secondary">
                {t('corporate.allowed_hours', { defaultValue: 'Horario permitido' })}
              </Text>
              <Text variant="body">{acc.allowed_hours_start} - {acc.allowed_hours_end}</Text>
            </View>
          )}

          {/* Employee management toggle */}
          <Pressable
            onPress={() => handleToggleEmployees(acc.id)}
            className="flex-row items-center justify-between py-2 mt-1 border-t border-neutral-100"
            accessibilityRole="button"
            accessibilityLabel={t('corporate.employees_section', { defaultValue: 'Empleados' })}
          >
            <View className="flex-row items-center gap-2">
              <Ionicons name="people-outline" size={18} color={colors.neutral[500]} />
              <Text variant="body" className="font-medium">
                {t('corporate.employees_section', { defaultValue: 'Empleados' })}
              </Text>
            </View>
            <Ionicons
              name={expandedAccountId === acc.id ? 'chevron-up' : 'chevron-down'}
              size={18}
              color={colors.neutral[400]}
            />
          </Pressable>

          {/* Expanded employees list */}
          {expandedAccountId === acc.id && (
            <View className="mt-2">
              {loadingEmployees ? (
                <Text variant="bodySmall" color="secondary" className="text-center py-3">
                  {t('common:loading', { defaultValue: 'Cargando...' })}
                </Text>
              ) : employees.length === 0 ? (
                <Text variant="bodySmall" color="secondary" className="text-center py-3">
                  {t('corporate.no_employees', { defaultValue: 'No hay empleados registrados' })}
                </Text>
              ) : (
                employees.map((emp) => (
                  <View key={emp.id} className="flex-row items-center justify-between py-2 border-b border-neutral-50">
                    <View className="flex-1 mr-2">
                      <Text variant="bodySmall" className="font-medium">
                        {emp.users?.full_name || emp.users?.phone || '—'}
                      </Text>
                      <View className="flex-row items-center gap-2">
                        <Text variant="caption" color="secondary">
                          {emp.users?.phone}
                        </Text>
                        <StatusBadge
                          label={emp.role}
                          variant={emp.role === 'admin' ? 'info' : 'neutral'}
                        />
                        {!emp.is_active && (
                          <StatusBadge label={t('corporate.inactive', { defaultValue: 'Inactivo' })} variant="error" />
                        )}
                      </View>
                    </View>
                    {isAdmin && emp.user_id !== userId && emp.is_active && (
                      <Pressable
                        onPress={() => handleRemoveEmployee(emp.user_id, emp.users?.full_name || emp.users?.phone)}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={t('corporate.remove_employee_title', { defaultValue: 'Remover empleado' })}
                      >
                        <Ionicons name="close-circle-outline" size={22} color={colors.error.DEFAULT} />
                      </Pressable>
                    )}
                  </View>
                ))
              )}

              {isAdmin && (
                <Button
                  title={t('corporate.add_employee', { defaultValue: 'Agregar empleado' })}
                  variant="outline"
                  size="md"
                  fullWidth
                  onPress={() => { setNewPhone(''); setNewRole('employee'); setAddSheetVisible(true); }}
                  className="mt-3"
                />
              )}
            </View>
          )}

          {/* Billing section (admin only) */}
          {isAdmin && (
            <>
              <Pressable
                onPress={() => handleToggleBilling(acc.id)}
                className="flex-row items-center justify-between py-2 mt-1 border-t border-neutral-100"
                accessibilityRole="button"
                accessibilityLabel={t('corporate.billing_section', { defaultValue: 'Facturación' })}
              >
                <View className="flex-row items-center gap-2">
                  <Ionicons name="receipt-outline" size={18} color={colors.neutral[500]} />
                  <Text variant="body" className="font-medium">
                    {t('corporate.billing_section', { defaultValue: 'Facturación' })}
                  </Text>
                </View>
                <Ionicons
                  name={billingExpanded === acc.id ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color={colors.neutral[400]}
                />
              </Pressable>

              {billingExpanded === acc.id && (
                <View className="mt-2">
                  {loadingBilling ? (
                    <Text variant="bodySmall" color="secondary" className="text-center py-3">
                      {t('common:loading', { defaultValue: 'Cargando...' })}
                    </Text>
                  ) : (
                    <>
                      {/* Billing summary card */}
                      {billingSummary && (
                        <Card variant="filled" padding="md" className="mb-3 bg-primary-50">
                          <View className="flex-row justify-between mb-2">
                            <View>
                              <Text variant="caption" color="secondary">
                                {t('corporate.billing_total_rides', { defaultValue: 'Viajes este mes' })}
                              </Text>
                              <Text variant="h4">{billingSummary.total_rides}</Text>
                            </View>
                            <View className="items-end">
                              <Text variant="caption" color="secondary">
                                {t('corporate.billing_total_spent', { defaultValue: 'Total gastado' })}
                              </Text>
                              <Text variant="h4" color="accent">{formatTRC(billingSummary.total_spent_trc)}</Text>
                            </View>
                          </View>
                          <View className="flex-row justify-between">
                            <View>
                              <Text variant="caption" color="secondary">
                                {t('corporate.billing_budget_remaining', { defaultValue: 'Presupuesto restante' })}
                              </Text>
                              <Text variant="body" className="font-semibold">
                                {formatTRC(billingSummary.budget_remaining_trc)}
                              </Text>
                            </View>
                            {corporateBalance !== null && (
                              <View className="items-end">
                                <Text variant="caption" color="secondary">
                                  {t('corporate.billing_balance', { defaultValue: 'Balance corporativo' })}
                                </Text>
                                <Text variant="body" className="font-semibold">{formatTRC(corporateBalance)}</Text>
                              </View>
                            )}
                          </View>
                        </Card>
                      )}

                      {/* Recent corporate rides */}
                      {corporateRides.length > 0 && (
                        <View>
                          <Text variant="bodySmall" color="secondary" className="mb-2">
                            {t('corporate.billing_recent_rides', { defaultValue: 'Viajes recientes' })}
                          </Text>
                          {corporateRides.map((ride) => (
                            <View key={ride.id} className="flex-row items-center justify-between py-2 border-b border-neutral-50">
                              <Text variant="caption" color="secondary">
                                {new Date(ride.created_at).toLocaleDateString('es-CU', {
                                  day: 'numeric',
                                  month: 'short',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </Text>
                              <Text variant="bodySmall" className="font-medium">{formatTRC(ride.fare_trc)}</Text>
                            </View>
                          ))}
                        </View>
                      )}

                      {!billingSummary && corporateRides.length === 0 && (
                        <Text variant="bodySmall" color="secondary" className="text-center py-3">
                          {t('corporate.billing_no_data', { defaultValue: 'Sin datos de facturación' })}
                        </Text>
                      )}
                    </>
                  )}
                </View>
              )}
            </>
          )}
        </Card>
      ))}

      {/* Add employee bottom sheet */}
      <BottomSheet visible={addSheetVisible} onClose={() => setAddSheetVisible(false)}>
        <Text className="text-lg font-bold mb-4">
          {t('corporate.add_employee', { defaultValue: 'Agregar empleado' })}
        </Text>

        <Input
          label={t('corporate.employee_phone', { defaultValue: 'Teléfono del empleado' })}
          placeholder="+53 5XXXXXXX"
          value={newPhone}
          onChangeText={setNewPhone}
          keyboardType="phone-pad"
        />

        <Text variant="bodySmall" color="secondary" className="mt-3 mb-2">
          {t('corporate.employee_role', { defaultValue: 'Rol' })}
        </Text>
        <View className="flex-row gap-2">
          {(['employee', 'admin'] as const).map((role) => (
            <Pressable
              key={role}
              onPress={() => setNewRole(role)}
              className={`flex-1 py-2 rounded-lg border items-center ${
                newRole === role
                  ? 'bg-primary-500/10 border-primary-500'
                  : 'bg-neutral-50 border-neutral-200'
              }`}
              accessibilityRole="radio"
              accessibilityState={{ selected: newRole === role }}
            >
              <Text variant="bodySmall" color={newRole === role ? 'accent' : 'secondary'}>
                {role === 'admin'
                  ? t('corporate.role_admin', { defaultValue: 'Administrador' })
                  : t('corporate.role_employee', { defaultValue: 'Empleado' })}
              </Text>
            </Pressable>
          ))}
        </View>

        <View className="mt-4">
          <Button
            title={t('corporate.add_employee', { defaultValue: 'Agregar empleado' })}
            variant="primary"
            size="lg"
            fullWidth
            loading={addingEmployee}
            disabled={addingEmployee || !newPhone.trim()}
            onPress={handleAddEmployee}
          />
        </View>
      </BottomSheet>
    </Screen>
  );
}
