// ============================================================
// TriciGo Driver — Fleet registration form (Phase 4)
// Dueño de flota completa: datos de la flota + vehículos +
// lista repetible de conductores (mín 1, máx 30). Submit crea
// corporate_account + driver_fleets + fleet_members en bloque.
// ============================================================

import React, { useState } from 'react';
import { View, Pressable, Alert, ScrollView } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { Input } from '@tricigo/ui/Input';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@tricigo/theme';
import { corporateService, fleetService } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
import type { FleetMemberInput } from '@tricigo/types';

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

export default function FleetRequestForm({ ownerUserId, ownerPhone, onSubmitted }: Props) {
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
      // 1. Create corporate_account with is_fleet_owner = true
      const account = await corporateService.registerAccount({
        name: fleetName.trim(),
        contact_phone: ownerPhone,
        contact_email: responsibleEmail.trim() || undefined,
        tax_id: taxId.trim() || undefined,
        created_by: ownerUserId,
      });

      // 2. Mark as fleet owner (the column is_fleet_owner defaults to false)
      const supabase = (await import('@tricigo/api')).getSupabaseClient();
      await supabase
        .from('corporate_accounts')
        .update({ is_fleet_owner: true })
        .eq('id', account.id);

      // 3. Submit fleet request (creates driver_fleets + fleet_members)
      await fleetService.submitFleetRequest({
        corporate_account_id: account.id,
        name: fleetName.trim(),
        vehicle_count_estimate: vehicleCount ? parseInt(vehicleCount, 10) : undefined,
        vehicle_types: vehicleTypes,
        operating_zones: zones
          .split(',')
          .map((z) => z.trim())
          .filter(Boolean),
        estimated_rides_per_day_per_vehicle: ridesPerDay ? parseInt(ridesPerDay, 10) : undefined,
        operating_hours_start: hoursStart.trim() || undefined,
        operating_hours_end: hoursEnd.trim() || undefined,
        notes: responsibleName.trim() ? `Responsable: ${responsibleName.trim()}` : undefined,
        members: validMembers.map((m) => ({
          driver_name: m.driver_name.trim(),
          driver_phone: m.driver_phone.trim(),
          driver_email: m.driver_email?.trim() || undefined,
          driver_license_number: m.driver_license_number?.trim() || undefined,
          driver_id_number: m.driver_id_number?.trim() || undefined,
        })),
      });

      onSubmitted();
    } catch (err) {
      Alert.alert('Error', getErrorMessage(err));
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
        Registra tu flota para que tus conductores se vinculen automáticamente cuando descarguen TriciGo Driver con su número de teléfono.
      </Text>

      {/* Flota */}
      <Card variant="outlined" padding="lg" className="mb-3">
        <Text variant="h4" className="mb-3">Flota</Text>
        <Input label="Nombre de la flota *" value={fleetName} onChangeText={setFleetName} placeholder="Ej: TaxiHabana" />
        <View className="h-3" />
        <Input label="RUC / Tax ID" value={taxId} onChangeText={setTaxId} />
        <View className="h-3" />
        <Input label="Ciudad / municipio principal *" value={city} onChangeText={setCity} placeholder="Ej: La Habana" />
        <View className="h-3" />
        <Input label="Responsable (nombre)" value={responsibleName} onChangeText={setResponsibleName} />
        <View className="h-3" />
        <Input
          label="Email de contacto"
          value={responsibleEmail}
          onChangeText={setResponsibleEmail}
          keyboardType="email-address"
          autoCapitalize="none"
        />
      </Card>

      {/* Vehículos */}
      <Card variant="outlined" padding="lg" className="mb-3">
        <Text variant="h4" className="mb-3">Vehículos</Text>
        <Text variant="caption" color="secondary" className="mb-2">Tipos *</Text>
        <View className="flex-row flex-wrap gap-2">
          {VEHICLE_TYPES.map((v) => (
            <Chip key={v.id} selected={vehicleTypes.includes(v.id)} onPress={() => toggleVehicleType(v.id)} label={v.label} />
          ))}
        </View>
        <View className="h-3" />
        <Input
          label="Cantidad estimada"
          value={vehicleCount}
          onChangeText={setVehicleCount}
          keyboardType="numeric"
          placeholder="Ej: 12"
        />
        <View className="h-3" />
        <Input
          label="Zonas que cubren (separadas por coma)"
          value={zones}
          onChangeText={setZones}
          placeholder="Ej: Vedado, Habana Vieja, Miramar"
        />
      </Card>

      {/* Operación */}
      <Card variant="outlined" padding="lg" className="mb-3">
        <Text variant="h4" className="mb-3">Operación</Text>
        <Text variant="caption" color="secondary" className="mb-1">Horario habitual (HH:MM)</Text>
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
          label="Viajes estimados por día (por vehículo)"
          value={ridesPerDay}
          onChangeText={setRidesPerDay}
          keyboardType="numeric"
          placeholder="Ej: 8"
        />
      </Card>

      {/* Conductores */}
      <Card variant="outlined" padding="lg" className="mb-3">
        <View className="flex-row items-center justify-between mb-3">
          <Text variant="h4">Conductores ({members.length})</Text>
          {members.length < MAX_MEMBERS && (
            <Pressable onPress={addMember} hitSlop={8} accessibilityRole="button" accessibilityLabel="Agregar conductor">
              <Ionicons name="add-circle" size={28} color={colors.primary[500]} />
            </Pressable>
          )}
        </View>

        {members.map((m, i) => (
          <View key={i} className="border border-neutral-200 dark:border-neutral-700 rounded-xl p-3 mb-3">
            <View className="flex-row items-center justify-between mb-2">
              <Text variant="bodySmall" color="secondary">Conductor {i + 1}</Text>
              {members.length > 1 && (
                <Pressable onPress={() => removeMember(i)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Quitar conductor">
                  <Ionicons name="trash-outline" size={18} color={colors.error.DEFAULT} />
                </Pressable>
              )}
            </View>
            <Input
              label="Nombre completo *"
              value={m.driver_name}
              onChangeText={(v) => updateMember(i, 'driver_name', v)}
            />
            <View className="h-2" />
            <Input
              label="Teléfono *"
              value={m.driver_phone}
              onChangeText={(v) => updateMember(i, 'driver_phone', v)}
              keyboardType="phone-pad"
              placeholder="+53 5XXXXXXX"
            />
            <View className="h-2" />
            <Input
              label="Email"
              value={m.driver_email ?? ''}
              onChangeText={(v) => updateMember(i, 'driver_email', v)}
              keyboardType="email-address"
              autoCapitalize="none"
            />
            <View className="h-2" />
            <Input
              label="Nº de licencia"
              value={m.driver_license_number ?? ''}
              onChangeText={(v) => updateMember(i, 'driver_license_number', v)}
            />
            <View className="h-2" />
            <Input
              label="Carné de identidad"
              value={m.driver_id_number ?? ''}
              onChangeText={(v) => updateMember(i, 'driver_id_number', v)}
            />
            <Text variant="caption" color="secondary" className="mt-2">
              Podrás subir las fotos de licencia desde el panel después de aprobar la flota.
            </Text>
          </View>
        ))}
      </Card>

      <Button
        title={submitting ? 'Enviando…' : 'Enviar solicitud de flota'}
        variant="primary"
        size="lg"
        fullWidth
        loading={submitting}
        disabled={!canSubmit}
        onPress={handleSubmit}
      />

      <Text variant="caption" color="secondary" className="mt-3 text-center">
        Mínimo 1 conductor · Máximo {MAX_MEMBERS} por solicitud
      </Text>
    </ScrollView>
  );
}
