import React, { useState, useEffect, useCallback } from 'react';
import { View, FlatList, Alert, Pressable, TextInput } from 'react-native';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { Input } from '@tricigo/ui/Input';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { formatTRC, getErrorMessage } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { useRouter } from 'expo-router';
import { useCorporateAccounts } from '@/hooks/useCorporateAccounts';
import { useAuthStore } from '@/stores/auth.store';
import { corporateService, paymentService, invoiceService } from '@tricigo/api';
import * as Linking from 'expo-linking';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@tricigo/theme';
import type { CorporateAccount, CorporateEmployeeWithUser, CorporateEmployeeRole, CorporateBillingSummary, CorporateRide, EmployeeReport } from '@tricigo/types';

const ALL_SERVICE_TYPES = [
  'triciclo_basico', 'triciclo_premium', 'triciclo_cargo',
  'moto_standard', 'auto_standard', 'auto_confort', 'mensajeria',
] as const;

const SERVICE_LABELS: Record<string, string> = {
  triciclo_basico: 'Triciclo Básico',
  triciclo_premium: 'Triciclo Premium',
  triciclo_cargo: 'Triciclo Cargo',
  moto_standard: 'Moto',
  auto_standard: 'Auto',
  auto_confort: 'Confort',
  mensajeria: 'Mensajería',
};

export default function CorporateProfileScreen() {
  const { t } = useTranslation('rider');
  const router = useRouter();
  const userId = useAuthStore((s) => s.user?.id);
  const { accounts, loading } = useCorporateAccounts();

  // Role map: accountId -> role (loaded eagerly)
  const [roleMap, setRoleMap] = useState<Record<string, CorporateEmployeeRole | null>>({});

  useEffect(() => {
    if (!userId || accounts.length === 0) return;
    Promise.all(
      accounts.map(async (acc) => {
        const role = await corporateService.getEmployeeRole(acc.id, userId);
        return [acc.id, role] as const;
      }),
    ).then((entries) => {
      setRoleMap(Object.fromEntries(entries));
    });
  }, [userId, accounts]);

  // Employee management state
  const [expandedAccountId, setExpandedAccountId] = useState<string | null>(null);
  const [employees, setEmployees] = useState<CorporateEmployeeWithUser[]>([]);
  const [loadingEmployees, setLoadingEmployees] = useState(false);

  // Add employee sheet
  const [addSheetVisible, setAddSheetVisible] = useState(false);
  const [newPhone, setNewPhone] = useState('');
  const [newRole, setNewRole] = useState<CorporateEmployeeRole>('employee');
  const [addingEmployee, setAddingEmployee] = useState(false);

  // Policy editor state
  const [policyExpanded, setPolicyExpanded] = useState<string | null>(null);
  const [policyForm, setPolicyForm] = useState({
    monthly_budget_trc: 0,
    per_ride_cap_trc: 0,
    allowed_service_types: [] as string[],
    allowed_hours_start: '',
    allowed_hours_end: '',
  });
  const [savingPolicy, setSavingPolicy] = useState(false);

  // Billing state
  const [billingExpanded, setBillingExpanded] = useState<string | null>(null);
  const [billingSummary, setBillingSummary] = useState<CorporateBillingSummary | null>(null);
  const [corporateBalance, setCorporateBalance] = useState<number | null>(null);
  const [corporateRides, setCorporateRides] = useState<CorporateRide[]>([]);
  const [loadingBilling, setLoadingBilling] = useState(false);

  // Recharge state
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [recharging, setRecharging] = useState(false);

  // Invoice state
  const [generatingInvoice, setGeneratingInvoice] = useState(false);
  const [invoiceMonth, setInvoiceMonth] = useState(() => new Date().getMonth() + 1);
  const [invoiceYear, setInvoiceYear] = useState(() => new Date().getFullYear());

  // Reports month filter
  const [reportMonth, setReportMonth] = useState(() => new Date().getMonth() + 1);
  const [reportYear, setReportYear] = useState(() => new Date().getFullYear());

  // Employee reports state
  const [reportsExpanded, setReportsExpanded] = useState<string | null>(null);
  const [employeeReports, setEmployeeReports] = useState<EmployeeReport[]>([]);
  const [loadingReports, setLoadingReports] = useState(false);

  const loadEmployees = useCallback(async (accountId: string) => {
    setLoadingEmployees(true);
    try {
      const emps = await corporateService.getEmployees(accountId);
      setEmployees(emps);
    } catch {
      setEmployees([]);
    } finally {
      setLoadingEmployees(false);
    }
  }, []);

  const handleToggleEmployees = (accountId: string) => {
    if (expandedAccountId === accountId) {
      setExpandedAccountId(null);
      setEmployees([]);
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
      Alert.alert(t('common:error', { defaultValue: 'Error' }), getErrorMessage(err));
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
              Alert.alert(t('common:error', { defaultValue: 'Error' }), t('common:errors.corporate_load_failed', { defaultValue: 'Error al cargar cuenta corporativa' }));
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

  const handleDownloadInvoice = async (accountId: string) => {
    setGeneratingInvoice(true);
    try {
      const data = await invoiceService.generateMonthlyInvoice(accountId, invoiceYear, invoiceMonth);

      const { jsPDF } = await import('jspdf');
      const doc = new jsPDF();

      doc.setFontSize(18);
      doc.text('TriciGo', 14, 20);
      doc.setFontSize(10);
      doc.text('Factura Corporativa', 14, 27);

      doc.setFontSize(11);
      doc.text(data.account_name, 14, 40);
      if (data.tax_id) doc.text(`RUC/NIT: ${data.tax_id}`, 14, 46);

      doc.setFontSize(12);
      doc.text(`Período: ${data.period}`, 130, 40);

      const startY = 60;
      doc.setFillColor(240, 240, 240);
      doc.rect(14, startY, 182, 8, 'F');
      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');
      doc.text('Fecha', 16, startY + 5.5);
      doc.text('Empleado', 50, startY + 5.5);
      doc.text('Monto TRC', 160, startY + 5.5);

      doc.setFont('helvetica', 'normal');
      let y = startY + 14;
      for (const item of data.items) {
        if (y > 270) { doc.addPage(); y = 20; }
        doc.text(new Date(item.date).toLocaleDateString('es-CU', { day: '2-digit', month: 'short' }), 16, y);
        doc.text(item.employee_name.substring(0, 30), 50, y);
        doc.text(item.fare_trc.toFixed(2), 160, y);
        y += 7;
      }

      y += 5;
      doc.line(14, y, 196, y);
      y += 8;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.text(`Total: ${data.total_trc.toFixed(2)} TRC (${data.total_rides} viajes)`, 14, y);

      const base64 = doc.output('datauristring').split(',')[1];
      const filename = `factura-${data.period.replace(/\s/g, '_')}.pdf`;
      const filePath = `${FileSystem.cacheDirectory}${filename}`;
      await FileSystem.writeAsStringAsync(filePath, base64, { encoding: FileSystem.EncodingType.Base64 });

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(filePath, { mimeType: 'application/pdf' });
      } else {
        Alert.alert('PDF', t('corporate.invoice_saved', { defaultValue: 'Factura generada' }));
      }
    } catch (err) {
      Alert.alert(t('common:error', { defaultValue: 'Error' }), getErrorMessage(err));
    } finally {
      setGeneratingInvoice(false);
    }
  };

  const handleRecharge = async (accountId: string) => {
    const amt = parseInt(rechargeAmount, 10);
    if (!amt || amt <= 0 || !userId) return;
    setRecharging(true);
    try {
      const result = await paymentService.createCorporateRechargeLink(accountId, amt, userId);
      await Linking.openURL(result.paymentUrl);
      setRechargeAmount('');
    } catch (err) {
      Alert.alert(t('common:error', { defaultValue: 'Error' }), getErrorMessage(err));
    } finally {
      setRecharging(false);
    }
  };

  const handleToggleReports = useCallback(async (accountId: string) => {
    if (reportsExpanded === accountId) {
      setReportsExpanded(null);
      return;
    }
    setReportsExpanded(accountId);
    setLoadingReports(true);
    try {
      const data = await corporateService.getEmployeeReport(accountId, reportYear, reportMonth);
      setEmployeeReports(data);
    } catch {
      setEmployeeReports([]);
    } finally {
      setLoadingReports(false);
    }
  }, [reportsExpanded, reportYear, reportMonth]);

  // Reload reports when month/year changes while expanded
  useEffect(() => {
    if (!reportsExpanded) return;
    setLoadingReports(true);
    corporateService.getEmployeeReport(reportsExpanded, reportYear, reportMonth)
      .then(setEmployeeReports)
      .catch(() => setEmployeeReports([]))
      .finally(() => setLoadingReports(false));
  }, [reportYear, reportMonth, reportsExpanded]);

  const handleTogglePolicy = (acc: CorporateAccount) => {
    if (policyExpanded === acc.id) {
      setPolicyExpanded(null);
    } else {
      setPolicyExpanded(acc.id);
      setPolicyForm({
        monthly_budget_trc: acc.monthly_budget_trc,
        per_ride_cap_trc: acc.per_ride_cap_trc,
        allowed_service_types: [...acc.allowed_service_types],
        allowed_hours_start: acc.allowed_hours_start ?? '',
        allowed_hours_end: acc.allowed_hours_end ?? '',
      });
    }
  };

  const toggleServiceType = (svc: string) => {
    setPolicyForm((prev) => ({
      ...prev,
      allowed_service_types: prev.allowed_service_types.includes(svc)
        ? prev.allowed_service_types.filter((s) => s !== svc)
        : [...prev.allowed_service_types, svc],
    }));
  };

  const handleSavePolicy = async (accountId: string) => {
    setSavingPolicy(true);
    try {
      await corporateService.updateAccount(accountId, {
        monthly_budget_trc: policyForm.monthly_budget_trc,
        per_ride_cap_trc: policyForm.per_ride_cap_trc,
        allowed_service_types: policyForm.allowed_service_types,
        allowed_hours_start: policyForm.allowed_hours_start || null,
        allowed_hours_end: policyForm.allowed_hours_end || null,
      });
      Alert.alert(
        t('corporate.policies_saved_title', { defaultValue: 'Guardado' }),
        t('corporate.policies_saved_msg', { defaultValue: 'Las políticas se actualizaron correctamente' }),
      );
      setPolicyExpanded(null);
    } catch (err) {
      Alert.alert(t('common:error', { defaultValue: 'Error' }), getErrorMessage(err));
    } finally {
      setSavingPolicy(false);
    }
  };

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

      {accounts.map((acc) => {
        const isAdmin = roleMap[acc.id] === 'admin';
        return (
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

          {/* Policy editor section (admin only) */}
          {isAdmin && (
            <>
              <Pressable
                onPress={() => handleTogglePolicy(acc)}
                className="flex-row items-center justify-between py-2 mt-1 border-t border-neutral-100"
                accessibilityRole="button"
                accessibilityLabel={t('corporate.policies_section', { defaultValue: 'Políticas' })}
              >
                <View className="flex-row items-center gap-2">
                  <Ionicons name="settings-outline" size={18} color={colors.neutral[500]} />
                  <Text variant="body" className="font-medium">
                    {t('corporate.policies_section', { defaultValue: 'Editar políticas' })}
                  </Text>
                </View>
                <Ionicons
                  name={policyExpanded === acc.id ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color={colors.neutral[400]}
                />
              </Pressable>

              {policyExpanded === acc.id && (
                <View className="mt-2 mb-2">
                  <Input
                    label={t('corporate.monthly_budget', { defaultValue: 'Presupuesto mensual (TRC)' })}
                    value={String(policyForm.monthly_budget_trc)}
                    onChangeText={(v) => setPolicyForm((p) => ({ ...p, monthly_budget_trc: parseFloat(v) || 0 }))}
                    keyboardType="numeric"
                  />
                  <View className="h-3" />
                  <Input
                    label={t('corporate.ride_cap', { defaultValue: 'Tope por viaje (TRC)' })}
                    value={String(policyForm.per_ride_cap_trc)}
                    onChangeText={(v) => setPolicyForm((p) => ({ ...p, per_ride_cap_trc: parseFloat(v) || 0 }))}
                    keyboardType="numeric"
                  />
                  <View className="h-3" />
                  <Text variant="caption" color="secondary" className="mb-2">
                    {t('corporate.allowed_services_label', { defaultValue: 'Servicios permitidos' })}
                  </Text>
                  <View className="flex-row flex-wrap gap-2 mb-3">
                    {ALL_SERVICE_TYPES.map((svc) => {
                      const selected = policyForm.allowed_service_types.includes(svc);
                      return (
                        <Pressable
                          key={svc}
                          onPress={() => toggleServiceType(svc)}
                          className={`px-3 py-1.5 rounded-lg border ${
                            selected
                              ? 'bg-primary-500 border-primary-500'
                              : 'bg-neutral-50 border-neutral-200'
                          }`}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: selected }}
                        >
                          <Text variant="caption" color={selected ? 'inverse' : 'secondary'}>
                            {SERVICE_LABELS[svc] || svc}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  <Text variant="caption" color="secondary" className="mb-1">
                    {t('corporate.allowed_hours_label', { defaultValue: 'Horario permitido (HH:MM)' })}
                  </Text>
                  <View className="flex-row items-center gap-2 mb-3">
                    <View className="flex-1">
                      <TextInput
                        value={policyForm.allowed_hours_start}
                        onChangeText={(v) => setPolicyForm((p) => ({ ...p, allowed_hours_start: v }))}
                        placeholder="08:00"
                        style={{
                          borderWidth: 1,
                          borderColor: colors.neutral[200],
                          borderRadius: 8,
                          paddingHorizontal: 12,
                          paddingVertical: 8,
                          fontSize: 14,
                          color: colors.neutral[900],
                        }}
                      />
                    </View>
                    <Text variant="body" color="secondary">—</Text>
                    <View className="flex-1">
                      <TextInput
                        value={policyForm.allowed_hours_end}
                        onChangeText={(v) => setPolicyForm((p) => ({ ...p, allowed_hours_end: v }))}
                        placeholder="18:00"
                        style={{
                          borderWidth: 1,
                          borderColor: colors.neutral[200],
                          borderRadius: 8,
                          paddingHorizontal: 12,
                          paddingVertical: 8,
                          fontSize: 14,
                          color: colors.neutral[900],
                        }}
                      />
                    </View>
                  </View>
                  <Button
                    title={savingPolicy
                      ? t('corporate.saving_policies', { defaultValue: 'Guardando...' })
                      : t('corporate.save_policies', { defaultValue: 'Guardar políticas' })}
                    variant="primary"
                    size="lg"
                    fullWidth
                    loading={savingPolicy}
                    disabled={savingPolicy}
                    onPress={() => handleSavePolicy(acc.id)}
                  />
                </View>
              )}
            </>
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

                      {/* Recharge button (admin) */}
                      <View className="mb-3">
                        <Input
                          label={t('corporate.recharge_amount', { defaultValue: 'Monto a recargar (CUP)' })}
                          value={rechargeAmount}
                          onChangeText={setRechargeAmount}
                          keyboardType="numeric"
                          placeholder="1000"
                        />
                        <View className="mt-2">
                          <Button
                            title={recharging
                              ? t('corporate.generating_link', { defaultValue: 'Generando...' })
                              : t('corporate.recharge_btn', { defaultValue: 'Recargar via TropiPay' })}
                            variant="primary"
                            size="md"
                            fullWidth
                            loading={recharging}
                            disabled={recharging || !rechargeAmount.trim()}
                            onPress={() => handleRecharge(acc.id)}
                          />
                        </View>
                      </View>

                      {/* Download invoice */}
                      <View className="mb-3">
                        <Text variant="caption" color="secondary" className="mb-1">
                          {t('corporate.invoice_period', { defaultValue: 'Período de factura' })}
                        </Text>
                        <View className="flex-row items-center gap-2 mb-2">
                          <Pressable
                            onPress={() => setInvoiceMonth((m) => m > 1 ? m - 1 : 12)}
                            hitSlop={8}
                          >
                            <Ionicons name="chevron-back" size={20} color={colors.neutral[500]} />
                          </Pressable>
                          <Text variant="body" className="font-medium flex-1 text-center">
                            {['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][invoiceMonth - 1]} {invoiceYear}
                          </Text>
                          <Pressable
                            onPress={() => setInvoiceMonth((m) => m < 12 ? m + 1 : 1)}
                            hitSlop={8}
                          >
                            <Ionicons name="chevron-forward" size={20} color={colors.neutral[500]} />
                          </Pressable>
                          <Pressable
                            onPress={() => setInvoiceYear((y) => y - 1)}
                            hitSlop={8}
                          >
                            <Ionicons name="remove-circle-outline" size={20} color={colors.neutral[400]} />
                          </Pressable>
                          <Text variant="caption" color="secondary">{invoiceYear}</Text>
                          <Pressable
                            onPress={() => setInvoiceYear((y) => y + 1)}
                            hitSlop={8}
                          >
                            <Ionicons name="add-circle-outline" size={20} color={colors.neutral[400]} />
                          </Pressable>
                        </View>
                        <Button
                          title={generatingInvoice
                            ? t('corporate.generating_invoice', { defaultValue: 'Generando...' })
                            : t('corporate.download_invoice', { defaultValue: 'Descargar factura PDF' })}
                          variant="outline"
                          size="md"
                          fullWidth
                          loading={generatingInvoice}
                          disabled={generatingInvoice}
                          onPress={() => handleDownloadInvoice(acc.id)}
                        />
                      </View>

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

          {/* Employee Reports section (admin only) */}
          {isAdmin && (
            <>
              <Pressable
                onPress={() => handleToggleReports(acc.id)}
                className="flex-row items-center justify-between py-2 mt-1 border-t border-neutral-100"
                accessibilityRole="button"
                accessibilityLabel={t('corporate.reports_section', { defaultValue: 'Reportes' })}
              >
                <View className="flex-row items-center gap-2">
                  <Ionicons name="bar-chart-outline" size={18} color={colors.neutral[500]} />
                  <Text variant="body" className="font-medium">
                    {t('corporate.reports_section', { defaultValue: 'Reportes por empleado' })}
                  </Text>
                </View>
                <Ionicons
                  name={reportsExpanded === acc.id ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color={colors.neutral[400]}
                />
              </Pressable>

              {reportsExpanded === acc.id && (
                <View className="mt-2">
                  {/* Month/year filter */}
                  <View className="flex-row items-center gap-2 mb-3">
                    <Pressable
                      onPress={() => {
                        const newM = reportMonth > 1 ? reportMonth - 1 : 12;
                        const newY = reportMonth > 1 ? reportYear : reportYear - 1;
                        setReportMonth(newM);
                        setReportYear(newY);
                      }}
                      hitSlop={8}
                    >
                      <Ionicons name="chevron-back" size={20} color={colors.neutral[500]} />
                    </Pressable>
                    <Text variant="body" className="font-medium flex-1 text-center">
                      {['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][reportMonth - 1]} {reportYear}
                    </Text>
                    <Pressable
                      onPress={() => {
                        const newM = reportMonth < 12 ? reportMonth + 1 : 1;
                        const newY = reportMonth < 12 ? reportYear : reportYear + 1;
                        setReportMonth(newM);
                        setReportYear(newY);
                      }}
                      hitSlop={8}
                    >
                      <Ionicons name="chevron-forward" size={20} color={colors.neutral[500]} />
                    </Pressable>
                  </View>
                  {loadingReports ? (
                    <Text variant="bodySmall" color="secondary" className="text-center py-3">
                      {t('common:loading', { defaultValue: 'Cargando...' })}
                    </Text>
                  ) : employeeReports.length === 0 ? (
                    <Text variant="bodySmall" color="secondary" className="text-center py-3">
                      {t('corporate.no_reports', { defaultValue: 'Sin viajes este mes' })}
                    </Text>
                  ) : (
                    employeeReports.map((r) => (
                      <Card key={r.user_id} variant="filled" padding="sm" className="mb-2 bg-neutral-50">
                        <View className="flex-row justify-between items-center mb-1">
                          <Text variant="bodySmall" className="font-semibold">{r.name}</Text>
                          <Text variant="caption" color="secondary">{r.phone}</Text>
                        </View>
                        <View className="flex-row justify-between">
                          <View>
                            <Text variant="caption" color="secondary">
                              {t('corporate.report_rides', { defaultValue: 'Viajes' })}
                            </Text>
                            <Text variant="bodySmall">{r.total_rides}</Text>
                          </View>
                          <View className="items-center">
                            <Text variant="caption" color="secondary">
                              {t('corporate.report_total', { defaultValue: 'Total' })}
                            </Text>
                            <Text variant="bodySmall" className="font-medium">{formatTRC(r.total_spent_trc)}</Text>
                          </View>
                          <View className="items-end">
                            <Text variant="caption" color="secondary">
                              {t('corporate.report_avg', { defaultValue: 'Promedio' })}
                            </Text>
                            <Text variant="bodySmall">{formatTRC(r.avg_fare_trc)}</Text>
                          </View>
                        </View>
                      </Card>
                    ))
                  )}
                </View>
              )}
            </>
          )}
        </Card>
        );
      })}

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
