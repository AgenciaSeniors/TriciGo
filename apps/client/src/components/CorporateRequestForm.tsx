// ============================================================
// TriciGo — Corporate request form (Phase 3)
// Used by /profile/corporate when the user has no corporate
// membership and no in-flight request. Submits via
// corporateService.submitClientRequest.
// ============================================================

import React, { useState } from 'react';
import { View, Pressable, Alert } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { Input } from '@tricigo/ui/Input';
import { useAuthStore } from '@/stores/auth.store';
import { corporateService } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';

const SECTORS = [
  { id: 'tourism', label: 'Turismo' },
  { id: 'gastronomy', label: 'Gastronomía' },
  { id: 'health', label: 'Salud' },
  { id: 'education', label: 'Educación' },
  { id: 'tech', label: 'Tecnología' },
  { id: 'logistics', label: 'Logística' },
  { id: 'other', label: 'Otro' },
];

const SIZE_RANGES = [
  { id: '1-10', label: '1 – 10' },
  { id: '11-50', label: '11 – 50' },
  { id: '51-200', label: '51 – 200' },
  { id: '200+', label: '200+' },
];

const PAYMENT_OPTIONS: Array<{ id: 'cash' | 'tricicoin' | 'mixed' | 'card'; label: string }> = [
  { id: 'cash', label: 'Efectivo' },
  { id: 'tricicoin', label: 'TriciCoin' },
  { id: 'mixed', label: 'Mixto' },
  { id: 'card', label: 'Tarjeta' },
];

interface Props {
  onSubmitted: () => void;
  initialError?: string;
}

export default function CorporateRequestForm({ onSubmitted, initialError }: Props) {
  const userId = useAuthStore((s) => s.user?.id);

  const [name, setName] = useState('');
  const [taxId, setTaxId] = useState('');
  const [sector, setSector] = useState<string>('');
  const [size, setSize] = useState<string>('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [estimatedRides, setEstimatedRides] = useState('');
  const [hoursStart, setHoursStart] = useState('');
  const [hoursEnd, setHoursEnd] = useState('');
  const [payment, setPayment] = useState<'cash' | 'tricicoin' | 'mixed' | 'card' | ''>('');
  const [requiresInvoice, setRequiresInvoice] = useState(false);
  const [comments, setComments] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = !!name.trim() && !!contactPhone.trim() && !!sector && !!size && !submitting;

  const handleSubmit = async () => {
    if (!userId) return;
    setSubmitting(true);
    try {
      await corporateService.submitClientRequest({
        name: name.trim(),
        contact_phone: contactPhone.trim(),
        contact_email: contactEmail.trim() || undefined,
        tax_id: taxId.trim() || undefined,
        created_by: userId,
        sector,
        employees_count_range: size,
        estimated_rides_per_month: estimatedRides ? parseInt(estimatedRides, 10) : undefined,
        operating_hours_start: hoursStart.trim() || undefined,
        operating_hours_end: hoursEnd.trim() || undefined,
        preferred_payment: payment || undefined,
        requires_invoice: requiresInvoice,
        comments: comments.trim() || undefined,
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
      accessibilityRole="radio"
      accessibilityState={{ selected }}
    >
      <Text variant="caption" color={selected ? 'inverse' : 'secondary'}>
        {label}
      </Text>
    </Pressable>
  );

  return (
    <View className="mt-4">
      {initialError && (
        <Card variant="filled" padding="md" className="mb-4 bg-error-50 dark:bg-error-900/20">
          <Text variant="bodySmall" color="error">{initialError}</Text>
        </Card>
      )}

      <Text variant="bodySmall" color="secondary" className="mb-3">
        Completa los datos de tu empresa para solicitar una cuenta corporativa. Te contactaremos en 1–2 días hábiles.
      </Text>

      {/* Empresa */}
      <Card variant="outlined" padding="lg" className="mb-3">
        <Text variant="h4" className="mb-3">Empresa</Text>
        <Input label="Nombre comercial *" value={name} onChangeText={setName} placeholder="Ej: Hotel Palmares S.A." />
        <View className="h-3" />
        <Input label="RUC / Tax ID" value={taxId} onChangeText={setTaxId} placeholder="Opcional" />

        <Text variant="caption" color="secondary" className="mt-3 mb-2">Sector *</Text>
        <View className="flex-row flex-wrap gap-2">
          {SECTORS.map((s) => (
            <Chip key={s.id} selected={sector === s.id} onPress={() => setSector(s.id)} label={s.label} />
          ))}
        </View>

        <Text variant="caption" color="secondary" className="mt-3 mb-2">Tamaño (empleados) *</Text>
        <View className="flex-row flex-wrap gap-2">
          {SIZE_RANGES.map((s) => (
            <Chip key={s.id} selected={size === s.id} onPress={() => setSize(s.id)} label={s.label} />
          ))}
        </View>
      </Card>

      {/* Contacto */}
      <Card variant="outlined" padding="lg" className="mb-3">
        <Text variant="h4" className="mb-3">Contacto</Text>
        <Input label="Nombre del responsable" value={contactName} onChangeText={setContactName} />
        <View className="h-3" />
        <Input
          label="Teléfono *"
          value={contactPhone}
          onChangeText={setContactPhone}
          keyboardType="phone-pad"
          placeholder="+53 5XXXXXXX"
        />
        <View className="h-3" />
        <Input
          label="Email"
          value={contactEmail}
          onChangeText={setContactEmail}
          keyboardType="email-address"
          autoCapitalize="none"
        />
      </Card>

      {/* Operación */}
      <Card variant="outlined" padding="lg" className="mb-3">
        <Text variant="h4" className="mb-3">Operación</Text>
        <Input
          label="Viajes estimados por mes"
          value={estimatedRides}
          onChangeText={setEstimatedRides}
          keyboardType="numeric"
          placeholder="Ej: 200"
        />
        <Text variant="caption" color="secondary" className="mt-3 mb-1">Horarios habituales (HH:MM)</Text>
        <View className="flex-row items-center gap-2">
          <View className="flex-1">
            <Input value={hoursStart} onChangeText={setHoursStart} placeholder="08:00" />
          </View>
          <Text variant="body" color="secondary">—</Text>
          <View className="flex-1">
            <Input value={hoursEnd} onChangeText={setHoursEnd} placeholder="18:00" />
          </View>
        </View>
      </Card>

      {/* Pago */}
      <Card variant="outlined" padding="lg" className="mb-3">
        <Text variant="h4" className="mb-3">Pago / Facturación</Text>
        <Text variant="caption" color="secondary" className="mb-2">Método de pago preferido</Text>
        <View className="flex-row flex-wrap gap-2">
          {PAYMENT_OPTIONS.map((o) => (
            <Chip key={o.id} selected={payment === o.id} onPress={() => setPayment(o.id)} label={o.label} />
          ))}
        </View>
        <Pressable
          onPress={() => setRequiresInvoice((v) => !v)}
          className="flex-row items-center gap-2 mt-3"
          accessibilityRole="checkbox"
          accessibilityState={{ checked: requiresInvoice }}
        >
          <View
            className={`w-5 h-5 rounded border-2 items-center justify-center ${
              requiresInvoice
                ? 'bg-primary-500 border-primary-500'
                : 'border-neutral-300 dark:border-neutral-600'
            }`}
          >
            {requiresInvoice && <Text className="text-white text-xs">✓</Text>}
          </View>
          <Text variant="bodySmall">Requiero factura mensual</Text>
        </Pressable>
      </Card>

      {/* Comentarios */}
      <Card variant="outlined" padding="lg" className="mb-4">
        <Text variant="h4" className="mb-3">Comentarios</Text>
        <Input
          value={comments}
          onChangeText={setComments}
          placeholder="Cualquier detalle adicional…"
          multiline
          numberOfLines={4}
        />
      </Card>

      <Button
        title={submitting ? 'Enviando…' : 'Enviar solicitud'}
        variant="primary"
        size="lg"
        fullWidth
        loading={submitting}
        disabled={!canSubmit}
        onPress={handleSubmit}
      />
    </View>
  );
}
