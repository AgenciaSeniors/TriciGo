import React, { useState, useMemo, useEffect, useRef } from 'react';
import { View, Pressable, Switch, Platform, ScrollView, KeyboardAvoidingView } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Toast from 'react-native-toast-message';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { Card } from '@tricigo/ui/Card';
import { StatusStepper } from '@tricigo/ui/StatusStepper';
import { AnimatedCard } from '@tricigo/ui/AnimatedCard';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber } from '@tricigo/theme';
import { useAuthStore } from '@/stores/auth.store';
import { useOnboardingStore } from '@/stores/onboarding.store';
import { SwitchAccountFooter } from '@/components/onboarding/SwitchAccountFooter';
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
        className="flex-row items-center justify-between border rounded-xl px-4 py-3.5"
        style={{
          backgroundColor: midnightEmber.map.bg.surface,
          borderColor: error ? midnightEmber.state.danger : midnightEmber.map.line.hairline,
        }}
      >
        <Text
          variant="body"
          style={{ color: selectedLabel ? midnightEmber.map.text.primary : midnightEmber.map.text.tertiary }}
        >
          {selectedLabel || placeholder}
        </Text>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={18}
          color={midnightEmber.map.text.tertiary}
        />
      </Pressable>
      {error && (
        <Text variant="caption" color="error" className="mt-1">
          {error}
        </Text>
      )}
      {expanded && (
        <View
          className="border rounded-xl mt-1 max-h-48 overflow-hidden"
          style={{
            backgroundColor: midnightEmber.map.bg.surface,
            borderColor: midnightEmber.map.line.hairline,
          }}
        >
          <ScrollView nestedScrollEnabled style={{ maxHeight: 192 }}>
            {options.map((opt) => (
              <Pressable
                key={opt.value}
                onPress={() => {
                  onSelect(opt.value);
                  setExpanded(false);
                }}
                className="px-4 py-3 border-b"
                style={{
                  borderBottomColor: midnightEmber.map.line.hairline,
                  backgroundColor: opt.value === value ? midnightEmber.accent.glow : undefined,
                }}
              >
                <View className="flex-row items-center">
                  {opt.value === value && (
                    <Ionicons name="checkmark-circle" size={16} color={midnightEmber.accent[500]} style={{ marginRight: 8 }} />
                  )}
                  <Text
                    variant="bodySmall"
                    style={{ color: opt.value === value ? midnightEmber.accent[500] : midnightEmber.map.text.primary }}
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
  // BUG-205 (3b): pre-fill email lazily. The user object can hydrate after the
  // first render (e.g. after Supabase Auth resolves a Google OAuth session),
  // so a one-shot useState initializer leaves the field blank. We use a ref to
  // remember whether the user typed manually so we don't clobber their input
  // when `user.email` arrives later.
  const [email, setEmailState] = useState(personalInfo.email || user?.email || '');
  const userEditedEmailRef = useRef(!!personalInfo.email);
  const setEmail = (val: string) => {
    userEditedEmailRef.current = true;
    setEmailState(val);
  };
  useEffect(() => {
    if (!userEditedEmailRef.current && !email && user?.email) {
      setEmailState(user.email);
    }
  }, [user?.email, email]);
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
    if (!validate()) {
      // UX: without a global cue, drivers hit "Siguiente" and the button
      // appears to do nothing — the inline red marks are easy to miss on
      // a tall form. This toast tells them WHY it didn't advance.
      Toast.show({
        type: 'error',
        text1: t('onboarding.validation_summary_title', { defaultValue: 'Revisá los campos' }),
        text2: t('onboarding.validation_summary_sub', { defaultValue: 'Faltan datos o hay errores marcados en rojo.' }),
        visibilityTime: 3000,
      });
      return;
    }
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
            colors={[midnightEmber.accent[500], midnightEmber.accent[400]]}
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
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 9999,
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginRight: 12,
                    backgroundColor: midnightEmber.accent[100],
                  }}
                >
                  <Ionicons name="person" size={20} color={midnightEmber.accent[500]} />
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
              <Card
                forceDark
                variant="filled"
                padding="lg"
                className="mb-5"
                style={{ backgroundColor: midnightEmber.map.bg.surface }}
              >
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
                    <View
                      className="border rounded-xl px-3 py-3.5"
                      style={{
                        backgroundColor: midnightEmber.map.bg.surface,
                        borderColor: midnightEmber.map.line.hairline,
                      }}
                    >
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
                  // BUG-205 (3a): the i18n value for `onboarding.email` already
                  // includes "(opcional)" / "(optional)" / "(opcional)" in
                  // every locale. Concatenating an extra
                  // t('common.optional_suffix') produced "Correo (opcional) (opcional)".
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
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 9999,
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginRight: 12,
                    backgroundColor: midnightEmber.accent[100],
                  }}
                >
                  <Ionicons name="location" size={20} color={midnightEmber.accent[500]} />
                </View>
                <Text variant="h3" color="inverse">
                  {t('onboarding.section_location')}
                </Text>
              </View>
            </AnimatedCard>

            <AnimatedCard delay={300} duration={400}>
              <Card
                forceDark
                variant="filled"
                padding="lg"
                className="mb-5"
                style={{ backgroundColor: midnightEmber.map.bg.surface }}
              >
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
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 9999,
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginRight: 12,
                    backgroundColor: midnightEmber.accent[100],
                  }}
                >
                  <Ionicons name="shield-checkmark" size={20} color={midnightEmber.accent[500]} />
                </View>
                <Text variant="h3" color="inverse">
                  {t('onboarding.section_background')}
                </Text>
              </View>
            </AnimatedCard>

            <AnimatedCard delay={500} duration={400}>
              <Card
                forceDark
                variant="filled"
                padding="lg"
                className="mb-5"
                style={{ backgroundColor: midnightEmber.map.bg.surface }}
              >
                <View className="flex-row items-center justify-between mb-2">
                  <View className="flex-1 mr-3">
                    <Text variant="body" color="inverse">
                      {t('onboarding.criminal_record')}
                    </Text>
                    {/* UX: antecedentes is a sensitive question. Without a
                         why-we-ask line, some drivers bail out assuming it
                         disqualifies them. It doesn't — declaring honestly
                         just changes the review timeline. */}
                    <Text variant="caption" color="secondary" className="mt-1 opacity-60">
                      {t('onboarding.criminal_record_hint', {
                        defaultValue: 'Requisito de verificación. Declarar antecedentes no te descalifica automáticamente.',
                      })}
                    </Text>
                  </View>
                  <Switch
                    value={hasCriminalRecord}
                    onValueChange={setHasCriminalRecord}
                    trackColor={{ false: midnightEmber.map.bg.elevated, true: midnightEmber.accent[500] }}
                    thumbColor={midnightEmber.map.text.onAccent}
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

            {/* BUG-299: escape hatch — driver can switch accounts at any
                onboarding step. Without this they're trapped after OTP. */}
            <SwitchAccountFooter />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
