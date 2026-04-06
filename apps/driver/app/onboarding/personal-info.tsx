import React, { useState, useMemo } from 'react';
import { View, Pressable, Switch, Platform, ScrollView, KeyboardAvoidingView } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { Card } from '@tricigo/ui/Card';
import { StatusStepper } from '@tricigo/ui/StatusStepper';
import { AnimatedCard } from '@tricigo/ui/AnimatedCard';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { useAuthStore } from '@/stores/auth.store';
import { useOnboardingStore } from '@/stores/onboarding.store';
import { isValidEmail, sanitizeText, isValidCubanId, isValidCubanPhone, normalizeCubanPhone, CUBA_PROVINCES, CUBA_MUNICIPALITIES } from '@tricigo/utils';
import { useResponsive } from '@tricigo/ui/hooks/useResponsive';

function useSteps() {
  const { t } = useTranslation('driver');
  return [
    { key: 'personal', label: t('onboarding.step_personal', { defaultValue: 'Personal' }) },
    { key: 'vehicle', label: t('onboarding.step_vehicle', { defaultValue: 'Vehículo' }) },
    { key: 'documents', label: t('onboarding.step_docs', { defaultValue: 'Docs' }) },
    { key: 'review', label: t('onboarding.step_review', { defaultValue: 'Revisión' }) },
  ];
}

/** Styled select dropdown using Pressable cards */
function SelectField({
  label,
  value,
  options,
  onSelect,
  placeholder,
  error,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onSelect: (value: string) => void;
  placeholder: string;
  error?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const selectedLabel = options.find((o) => o.value === value)?.label;

  return (
    <View className="mb-4">
      <Text variant="bodySmall" color="inverse" className="mb-1.5 font-medium opacity-70">
        {label}
      </Text>
      <Pressable
        onPress={() => setExpanded(!expanded)}
        className="flex-row items-center justify-between bg-[#1a1a2e] border border-white/6 rounded-xl px-4 py-3.5"
        style={error ? { borderColor: '#EF4444' } : undefined}
      >
        <Text
          variant="body"
          style={{ color: selectedLabel ? '#FFFFFF' : '#6B7280' }}
        >
          {selectedLabel || placeholder}
        </Text>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={18}
          color="#9CA3AF"
        />
      </Pressable>
      {error && (
        <Text variant="caption" color="error" className="mt-1">
          {error}
        </Text>
      )}
      {expanded && (
        <View className="bg-[#1a1a2e] border border-white/6 rounded-xl mt-1 max-h-48 overflow-hidden">
          <ScrollView nestedScrollEnabled style={{ maxHeight: 192 }}>
            {options.map((opt) => (
              <Pressable
                key={opt.value}
                onPress={() => {
                  onSelect(opt.value);
                  setExpanded(false);
                }}
                className="px-4 py-3 border-b border-white/6 active:bg-[#252540]"
                style={opt.value === value ? { backgroundColor: 'rgba(255, 77, 0, 0.15)' } : undefined}
              >
                <View className="flex-row items-center">
                  {opt.value === value && (
                    <Ionicons name="checkmark-circle" size={16} color={colors.brand.orange} style={{ marginRight: 8 }} />
                  )}
                  <Text
                    variant="bodySmall"
                    style={{ color: opt.value === value ? colors.brand.orange : '#FFFFFF' }}
                  >
                    {opt.label}
                  </Text>
                </View>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

export default function PersonalInfoScreen() {
  const { t } = useTranslation('driver');
  const STEPS = useSteps();
  const { isPhone } = useResponsive();
  const user = useAuthStore((s) => s.user);
  const { personalInfo, setPersonalInfo } = useOnboardingStore();

  // Extract phone without +53 prefix for editing
  const rawPhone = user?.phone?.replace(/^\+53/, '') || '';
  const isPhoneFromOtp = !!user?.phone && isValidCubanPhone(user.phone);

  // Form state
  const [fullName, setFullName] = useState(personalInfo.full_name || user?.full_name || '');
  const [phone, setPhone] = useState(personalInfo.phone || rawPhone || '');
  const [email, setEmail] = useState(personalInfo.email || user?.email || '');
  const [identityNumber, setIdentityNumber] = useState(personalInfo.identity_number || '');
  const [province, setProvince] = useState(personalInfo.province || '');
  const [municipality, setMunicipality] = useState(personalInfo.municipality || '');
  const [address, setAddress] = useState(personalInfo.address || '');
  const [hasCriminalRecord, setHasCriminalRecord] = useState(personalInfo.has_criminal_record || false);
  const [criminalDetails, setCriminalDetails] = useState(personalInfo.criminal_record_details || '');

  // Errors
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Dynamic municipalities based on selected province
  const municipalities = useMemo(() => {
    if (!province) return [];
    return CUBA_MUNICIPALITIES[province] || [];
  }, [province]);

  // Reset municipality when province changes
  const handleProvinceChange = (value: string) => {
    setProvince(value);
    setMunicipality('');
  };

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    const trimmedName = sanitizeText(fullName);

    if (!trimmedName || trimmedName.length < 2) {
      newErrors.fullName = t('onboarding.error_name_required');
    }
    const normalizedPhone = phone.trim().startsWith('+53') ? phone.trim() : `+53${phone.trim()}`;
    if (!phone.trim()) {
      newErrors.phone = t('onboarding.error_phone_required', { defaultValue: 'El teléfono es obligatorio' });
    } else if (!isValidCubanPhone(normalizedPhone)) {
      newErrors.phone = t('onboarding.error_phone_invalid', { defaultValue: 'Número cubano inválido (5XXXXXXX)' });
    }
    if (email.trim() && !isValidEmail(email.trim())) {
      newErrors.email = t('onboarding.error_invalid_email');
    }
    if (!identityNumber.trim()) {
      newErrors.identityNumber = t('onboarding.error_identity_required');
    } else if (!isValidCubanId(identityNumber.trim())) {
      newErrors.identityNumber = t('onboarding.error_identity_invalid');
    }
    if (!province) {
      newErrors.province = t('onboarding.error_province_required');
    }
    if (!municipality) {
      newErrors.municipality = t('onboarding.error_municipality_required');
    }
    if (!address.trim()) {
      newErrors.address = t('onboarding.error_address_required');
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleNext = () => {
    if (!validate()) return;
    const finalPhone = phone.trim().startsWith('+53') ? phone.trim() : `+53${phone.trim()}`;
    setPersonalInfo({
      full_name: sanitizeText(fullName),
      phone: normalizeCubanPhone(finalPhone),
      email: email.trim(),
      identity_number: identityNumber.trim(),
      province,
      municipality,
      address: address.trim(),
      has_criminal_record: hasCriminalRecord,
      criminal_record_details: hasCriminalRecord ? criminalDetails.trim() : '',
    });
    router.push('/onboarding/vehicle-info');
  };

  return (
    <Screen bg="dark" statusBarStyle="light-content" padded={false}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, paddingBottom: 40 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Header gradient */}
          <LinearGradient
            colors={['#1A1A1A', '#111111']}
            style={{ paddingTop: 12, paddingBottom: 20, paddingHorizontal: 20 }}
          >
            <View style={!isPhone ? { maxWidth: 480, width: '100%', alignSelf: 'center' } : undefined}>
              <StatusStepper steps={STEPS} currentStep="personal" variant="dark" className="mb-4" />
            </View>
          </LinearGradient>

          {/* Orange accent line */}
          <LinearGradient
            colors={['#FF4D00', '#FF6B2C']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={{ height: 3 }}
          />

          <View
            className="px-5 pt-6"
            style={!isPhone ? { maxWidth: 480, width: '100%', alignSelf: 'center' } : undefined}
          >
            {/* ─── Section 1: Personal Data ─── */}
            <AnimatedCard delay={0} duration={400}>
              <View className="flex-row items-center mb-4">
                <View className="w-10 h-10 rounded-full bg-[#252540] items-center justify-center mr-3">
                  <Ionicons name="person" size={20} color={colors.brand.orange} />
                </View>
                <View>
                  <Text variant="h3" color="inverse">
                    {t('onboarding.section_personal')}
                  </Text>
                  <Text variant="caption" color="secondary">
                    {t('onboarding.step_n_of_total', { step: 1, total: 4 })}
                  </Text>
                </View>
              </View>
            </AnimatedCard>

            <AnimatedCard delay={100} duration={400}>
              <Card forceDark variant="filled" padding="lg" className="bg-neutral-900 mb-5">
                <Input
                  label={t('onboarding.full_name')}
                  placeholder="Juan Pérez"
                  value={fullName}
                  onChangeText={setFullName}
                  error={errors.fullName}
                  variant="dark"
                  autoFocus
                />
                <View>
                  <Text variant="bodySmall" color="inverse" className="mb-1.5 font-medium opacity-70">
                    {t('onboarding.phone')}
                  </Text>
                  <View className="flex-row items-center gap-2">
                    <View className="bg-[#1a1a2e] border border-white/6 rounded-xl px-3 py-3.5">
                      <Text variant="body" color="inverse" className="font-semibold">+53</Text>
                    </View>
                    <View className="flex-1">
                      <Input
                        placeholder="5XXXXXXX"
                        keyboardType="phone-pad"
                        maxLength={8}
                        value={phone}
                        onChangeText={setPhone}
                        error={errors.phone}
                        variant="dark"
                        editable={!isPhoneFromOtp}
                      />
                    </View>
                  </View>
                  {isPhoneFromOtp && (
                    <Text variant="caption" color="secondary" className="mt-1 opacity-50">
                      {t('onboarding.phone_verified', { defaultValue: 'Verificado por OTP' })}
                    </Text>
                  )}
                </View>
                <Input
                  label={t('onboarding.email')}
                  placeholder="email@ejemplo.com"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  value={email}
                  onChangeText={setEmail}
                  error={errors.email}
                  variant="dark"
                />
                <Input
                  label={t('onboarding.identity_number')}
                  placeholder={t('onboarding.identity_number_placeholder')}
                  keyboardType="number-pad"
                  maxLength={11}
                  value={identityNumber}
                  onChangeText={setIdentityNumber}
                  error={errors.identityNumber}
                  variant="dark"
                />
              </Card>
            </AnimatedCard>

            {/* ─── Section 2: Location ─── */}
            <AnimatedCard delay={200} duration={400}>
              <View className="flex-row items-center mb-4">
                <View className="w-10 h-10 rounded-full bg-blue-500/20 items-center justify-center mr-3">
                  <Ionicons name="location" size={20} color="#3B82F6" />
                </View>
                <Text variant="h3" color="inverse">
                  {t('onboarding.section_location')}
                </Text>
              </View>
            </AnimatedCard>

            <AnimatedCard delay={300} duration={400}>
              <Card forceDark variant="filled" padding="lg" className="bg-neutral-900 mb-5">
                <SelectField
                  label={t('onboarding.province')}
                  value={province}
                  options={CUBA_PROVINCES}
                  onSelect={handleProvinceChange}
                  placeholder={t('onboarding.select_province')}
                  error={errors.province}
                />
                <SelectField
                  label={t('onboarding.municipality')}
                  value={municipality}
                  options={municipalities}
                  onSelect={setMunicipality}
                  placeholder={t('onboarding.select_municipality')}
                  error={errors.municipality}
                />
                <Input
                  label={t('onboarding.address')}
                  placeholder={t('onboarding.address_placeholder')}
                  value={address}
                  onChangeText={setAddress}
                  error={errors.address}
                  variant="dark"
                  multiline
                  numberOfLines={2}
                />
              </Card>
            </AnimatedCard>

            {/* ─── Section 3: Background ─── */}
            <AnimatedCard delay={400} duration={400}>
              <View className="flex-row items-center mb-4">
                <View className="w-10 h-10 rounded-full bg-green-500/20 items-center justify-center mr-3">
                  <Ionicons name="shield-checkmark" size={20} color="#22C55E" />
                </View>
                <Text variant="h3" color="inverse">
                  {t('onboarding.section_background')}
                </Text>
              </View>
            </AnimatedCard>

            <AnimatedCard delay={500} duration={400}>
              <Card forceDark variant="filled" padding="lg" className="bg-neutral-900 mb-5">
                <View className="flex-row items-center justify-between mb-2">
                  <Text variant="body" color="inverse" className="flex-1">
                    {t('onboarding.criminal_record')}
                  </Text>
                  <Switch
                    value={hasCriminalRecord}
                    onValueChange={setHasCriminalRecord}
                    trackColor={{ false: '#252540', true: colors.brand.orange }}
                    thumbColor="#FFFFFF"
                    accessibilityLabel={t('onboarding.criminal_record')}
                  />
                </View>
                {hasCriminalRecord && (
                  <View className="mt-3">
                    <Input
                      label={t('onboarding.criminal_record_details')}
                      placeholder={t('onboarding.criminal_record_details_placeholder')}
                      value={criminalDetails}
                      onChangeText={setCriminalDetails}
                      variant="dark"
                      multiline
                      numberOfLines={3}
                    />
                  </View>
                )}
              </Card>
            </AnimatedCard>

            {/* ─── Next Button ─── */}
            <AnimatedCard delay={600} duration={400}>
              <Button
                title={t('common:next', { defaultValue: 'Siguiente' })}
                size="lg"
                fullWidth
                onPress={handleNext}
                className="mt-2 mb-8"
              />
            </AnimatedCard>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
