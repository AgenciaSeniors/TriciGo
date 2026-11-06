// ============================================================
// TriciGo — Fleet registration form (Phase 4)
// The owner fills in the fleet, its vehicles and a repeatable list
// of drivers (min 1, max 30). Submitting creates corporate_account +
// driver_fleets + fleet_members in one go.
// ============================================================

import React, { useState } from 'react';
import { View, Pressable, Alert, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@tricigo/theme';
import { useTranslation } from '@tricigo/i18n';
import { getErrorMessage } from '@tricigo/utils';
import type { FleetMemberInput } from '@tricigo/types';
import { buildFleetRequest, createFleetRequestSubmission } from '@tricigo/api';
import { Text } from '../Text';
import { Card } from '../Card';
import { Button } from '../Button';
import { Input } from '../Input';

// Each label is the Spanish default of fleet.vehicle_type.<id>.
const VEHICLE_TYPES = [
  { id: 'triciclo_basico', label: 'Triciclo' },
  { id: 'moto_standard', label: 'Moto' },
  { id: 'auto_standard', label: 'Auto' },
  { id: 'triciclo_cargo', label: 'Cargo' },
];

const MAX_MEMBERS = 30;

interface Props {
  ownerUserId: string;
  ownerPhone: string;
  onSubmitted: () => void;
}

export function FleetRequestForm({ ownerUserId, ownerPhone, onSubmitted }: Props) {
  const { t } = useTranslation('driver');

  // Fleet info
  const [fleetName, setFleetName] = useState('');
  const [taxId, setTaxId] = useState('');
  const [city, setCity] = useState('');
  const [responsibleName, setResponsibleName] = useState('');
  const [responsibleEmail, setResponsibleEmail] = useState('');

  // Vehicles
  const [vehicleTypes, setVehicleTypes] = useState<string[]>([]);
  const [vehicleCount, setVehicleCount] = useState('');
  const [zones, setZones] = useState('');

  // Operations
  const [hoursStart, setHoursStart] = useState('');
  const [hoursEnd, setHoursEnd] = useState('');
  const [ridesPerDay, setRidesPerDay] = useState('');

  // Members
  const [members, setMembers] = useState<FleetMemberInput[]>([
    { driver_name: '', driver_phone: '', driver_email: '', driver_license_number: '', driver_id_number: '' },
  ]);

  const [submitting, setSubmitting] = useState(false);
  // Remembers the account a failed attempt created, so a retry reuses it.
  const [submission] = useState(createFleetRequestSubmission);

  const toggleVehicleType = (id: string) => {
    setVehicleTypes((prev) =>
      prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id],
    );
  };

  const updateMember = (index: number, field: keyof FleetMemberInput, value: string) => {
    setMembers((prev) =>
      prev.map((m, i) => (i === index ? { ...m, [field]: value } : m)),
    );
  };

  const addMember = () => {
    if (members.length >= MAX_MEMBERS) return;
    setMembers((prev) => [
      ...prev,
      { driver_name: '', driver_phone: '', driver_email: '', driver_license_number: '', driver_id_number: '' },
    ]);
  };

  const removeMember = (index: number) => {
    if (members.length <= 1) return;
    setMembers((prev) => prev.filter((_, i) => i !== index));
  };

  const validMembers = members.filter((m) => m.driver_name.trim() && m.driver_phone.trim());
  const canSubmit =
    !!fleetName.trim() &&
    !!city.trim() &&
    vehicleTypes.length > 0 &&
    validMembers.length > 0 &&
    !submitting;

  const handleSubmit = async () => {
    if (!ownerUserId) return;
    setSubmitting(true);
    try {
      const { account, fleet } = buildFleetRequest({
        ownerUserId,
        ownerPhone,
        fleetName,
        taxId,
        city,
        responsibleName,
        responsibleEmail,
        vehicleTypes,
        vehicleCount,
        zones,
        hoursStart,
        hoursEnd,
        ridesPerDay,
        members: validMembers,
      });
      await submission.submit(account, fleet);

      onSubmitted();
    } catch (err) {
      Alert.alert(t('common.error', { defaultValue: 'Error' }), getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const Chip = ({ selected, onPress, label }: { selected: boolean; onPress: () => void; label: string }) => (
    <Pressable
      onPress={onPress}
      className={`px-3 py-2 rounded-lg border ${
        selected
          ? 'bg-primary-500 border-primary-500'
          : 'bg-white dark:bg-neutral-800 border-neutral-200 dark:border-neutral-700'
      }`}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
    >
      <Text variant="caption" color={selected ? 'inverse' : 'secondary'}>{label}</Text>
    </Pressable>
  );

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <Text variant="bodySmall" color="secondary" className="mb-3">
        {t('fleet.request_intro', {
          defaultValue:
            'Registra tu flota para que tus conductores se vinculen automáticamente cuando descarguen TriciGo Driver con su número de teléfono.',
        })}
      </Text>

      {/* Fleet */}
      <Card variant="outlined" padding="lg" className="mb-3">
        <Text variant="h4" className="mb-3">{t('fleet.request_fleet', { defaultValue: 'Flota' })}</Text>
        <Input
          label={t('fleet.request_fleet_name', { defaultValue: 'Nombre de la flota *' })}
          value={fleetName}
          onChangeText={setFleetName}
          placeholder={t('fleet.request_fleet_name_placeholder', { defaultValue: 'Ej: TaxiHabana' })}
        />
        <View className="h-3" />
        <Input
          label={t('fleet.request_tax_id', { defaultValue: 'RUC / Tax ID' })}
          value={taxId}
          onChangeText={setTaxId}
        />
        <View className="h-3" />
        <Input
          label={t('fleet.request_city', { defaultValue: 'Ciudad / municipio principal *' })}
          value={city}
          onChangeText={setCity}
          placeholder={t('fleet.request_city_placeholder', { defaultValue: 'Ej: La Habana' })}
          maxLength={120}
        />
        <View className="h-3" />
        <Input
          label={t('fleet.request_responsible', { defaultValue: 'Responsable (nombre)' })}
          value={responsibleName}
          onChangeText={setResponsibleName}
        />
        <View className="h-3" />
        <Input
          label={t('fleet.request_contact_email', { defaultValue: 'Email de contacto' })}
          value={responsibleEmail}
          onChangeText={setResponsibleEmail}
          keyboardType="email-address"
          autoCapitalize="none"
        />
      </Card>

      {/* Vehicles */}
      <Card variant="outlined" padding="lg" className="mb-3">
        <Text variant="h4" className="mb-3">{t('fleet.request_vehicles', { defaultValue: 'Vehículos' })}</Text>
        <Text variant="caption" color="secondary" className="mb-2">
          {t('fleet.request_vehicle_types', { defaultValue: 'Tipos *' })}
        </Text>
        <View className="flex-row flex-wrap gap-2">
          {VEHICLE_TYPES.map((v) => (
            <Chip
              key={v.id}
              selected={vehicleTypes.includes(v.id)}
              onPress={() => toggleVehicleType(v.id)}
              label={t(`fleet.vehicle_type.${v.id}`, { defaultValue: v.label })}
            />
          ))}
        </View>
        <View className="h-3" />
        <Input
          label={t('fleet.request_vehicle_count', { defaultValue: 'Cantidad estimada' })}
          value={vehicleCount}
          onChangeText={setVehicleCount}
          keyboardType="numeric"
          placeholder={t('fleet.request_vehicle_count_placeholder', { defaultValue: 'Ej: 12' })}
        />
        <View className="h-3" />
        <Input
          label={t('fleet.request_zones', { defaultValue: 'Zonas que cubren (separadas por coma)' })}
          value={zones}
          onChangeText={setZones}
          placeholder={t('fleet.request_zones_placeholder', { defaultValue: 'Ej: Vedado, Habana Vieja, Miramar' })}
        />
      </Card>

      {/* Operations */}
      <Card variant="outlined" padding="lg" className="mb-3">
        <Text variant="h4" className="mb-3">{t('fleet.request_operation', { defaultValue: 'Operación' })}</Text>
        <Text variant="caption" color="secondary" className="mb-1">
          {t('fleet.request_hours', { defaultValue: 'Horario habitual (HH:MM)' })}
        </Text>
        <View className="flex-row items-center gap-2 mb-3">
          <View className="flex-1">
            <Input value={hoursStart} onChangeText={setHoursStart} placeholder="06:00" />
          </View>
          <Text variant="body" color="secondary">—</Text>
          <View className="flex-1">
            <Input value={hoursEnd} onChangeText={setHoursEnd} placeholder="22:00" />
          </View>
        </View>
        <Input
          label={t('fleet.request_rides_per_day', { defaultValue: 'Viajes estimados por día (por vehículo)' })}
          value={ridesPerDay}
          onChangeText={setRidesPerDay}
          keyboardType="numeric"
          placeholder={t('fleet.request_rides_per_day_placeholder', { defaultValue: 'Ej: 8' })}
        />
      </Card>

      {/* Drivers */}
      <Card variant="outlined" padding="lg" className="mb-3">
        <View className="flex-row items-center justify-between mb-3">
          <Text variant="h4">
            {t('fleet.request_drivers', { defaultValue: 'Conductores ({{total}})', total: members.length })}
          </Text>
          {members.length < MAX_MEMBERS && (
            <Pressable
              onPress={addMember}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('fleet.add_driver', { defaultValue: 'Agregar conductor' })}
            >
              <Ionicons name="add-circle" size={28} color={colors.primary[500]} />
            </Pressable>
          )}
        </View>

        {members.map((m, i) => (
          <View key={i} className="border border-neutral-200 dark:border-neutral-700 rounded-xl p-3 mb-3">
            <View className="flex-row items-center justify-between mb-2">
              <Text variant="bodySmall" color="secondary">
                {t('fleet.request_driver_row', { defaultValue: 'Conductor {{row}}', row: i + 1 })}
              </Text>
              {members.length > 1 && (
                <Pressable
                  onPress={() => removeMember(i)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('fleet.request_remove_driver', { defaultValue: 'Quitar conductor' })}
                >
                  <Ionicons name="trash-outline" size={18} color={colors.error.DEFAULT} />
                </Pressable>
              )}
            </View>
            <Input
              label={t('fleet.add_driver_name', { defaultValue: 'Nombre completo *' })}
              value={m.driver_name}
              onChangeText={(v) => updateMember(i, 'driver_name', v)}
            />
            <View className="h-2" />
            <Input
              label={t('fleet.add_driver_phone', { defaultValue: 'Teléfono *' })}
              value={m.driver_phone}
              onChangeText={(v) => updateMember(i, 'driver_phone', v)}
              keyboardType="phone-pad"
              placeholder={t('fleet.phone_placeholder', { defaultValue: '+53 5XXXXXXX o 6XXXXXXX' })}
            />
            <View className="h-2" />
            <Input
              label={t('fleet.add_driver_email', { defaultValue: 'Email' })}
              value={m.driver_email ?? ''}
              onChangeText={(v) => updateMember(i, 'driver_email', v)}
              keyboardType="email-address"
              autoCapitalize="none"
            />
            <View className="h-2" />
            <Input
              label={t('fleet.add_driver_license', { defaultValue: 'Nº de licencia' })}
              value={m.driver_license_number ?? ''}
              onChangeText={(v) => updateMember(i, 'driver_license_number', v)}
            />
            <View className="h-2" />
            <Input
              label={t('fleet.add_driver_id_number', { defaultValue: 'Carné de identidad' })}
              value={m.driver_id_number ?? ''}
              onChangeText={(v) => updateMember(i, 'driver_id_number', v)}
            />
            <Text variant="caption" color="secondary" className="mt-2">
              {t('fleet.request_license_hint', {
                defaultValue: 'Podrás subir la foto de su licencia desde la lista de conductores mientras esté en revisión.',
              })}
            </Text>
          </View>
        ))}
      </Card>

      <Button
        title={
          submitting
            ? t('fleet.request_submitting', { defaultValue: 'Enviando…' })
            : t('fleet.request_submit', { defaultValue: 'Enviar solicitud de flota' })
        }
        variant="primary"
        size="lg"
        fullWidth
        loading={submitting}
        disabled={!canSubmit}
        onPress={handleSubmit}
      />

      <Text variant="caption" color="secondary" className="mt-3 text-center">
        {t('fleet.request_limits', {
          defaultValue: 'Mínimo 1 conductor · Máximo {{max}} por solicitud',
          max: MAX_MEMBERS,
        })}
      </Text>
    </ScrollView>
  );
}
