import React, { useState, useMemo, useEffect, useRef } from 'react';
import { View, Pressable, Switch, Platform, ScrollView, KeyboardAvoidingView, Modal } from 'react-native';
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
import { authService, isRateLimitError, referralService } from '@tricigo/api';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuthStore } from '@/stores/auth.store';
import { useOnboardingStore } from '@/stores/onboarding.store';
import { SwitchAccountFooter } from '@/components/onboarding/SwitchAccountFooter';
import { isValidEmail, sanitizeText, isValidCubanId, isValidCubanPhone, normalizeCubanPhone, isValidOTP, CUBA_PROVINCES, CUBA_MUNICIPALITIES, realEmail } from '@tricigo/utils';
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
  const { t: tc } = useTranslation('common');
  const STEPS = useSteps();
  const { isPhone } = useResponsive();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
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
  const [email, setEmailState] = useState(personalInfo.email || realEmail(user?.email) || '');
  const userEditedEmailRef = useRef(!!personalInfo.email);
  const setEmail = (val: string) => {
    userEditedEmailRef.current = true;
    setEmailState(val);
  };
  useEffect(() => {
    // Skip the synthetic phone-OTP placeholder — only pre-fill a real address.
    const real = realEmail(user?.email);
    if (!userEditedEmailRef.current && !email && real) {
      setEmailState(real);
    }
  }, [user?.email, email]);
  const [identityNumber, setIdentityNumber] = useState(personalInfo.identity_number || '');
  const [province, setProvince] = useState(personalInfo.province || '');
  const [municipality, setMunicipality] = useState(personalInfo.municipality || '');
  const [address, setAddress] = useState(personalInfo.address || '');
  const [hasCriminalRecord, setHasCriminalRecord] = useState(personalInfo.has_criminal_record || false);
  const [criminalDetails, setCriminalDetails] = useState(personalInfo.criminal_record_details || '');

  // Referral capture (marketing audit 2026-07-02): a referred driver must
  // apply the code BEFORE approval — the reward trigger only fires on the
  // transition to 'approved', so a code applied later stays pending forever.
  // This optional field closes that window during onboarding.
  const [referralCode, setReferralCode] = useState('');
  const [referralApplied, setReferralApplied] = useState(false);
  const [referralApplying, setReferralApplying] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const referred = await referralService.hasBeenReferred(user.id);
        if (referred) {
          if (!cancelled) setReferralApplied(true);
          return;
        }
        // Deferred deep link: tricigo-driver://refer/<code> stashed by
        // app/refer/[code].tsx before the driver logged in.
        const pending = await AsyncStorage.getItem('pending_referral_code');
        if (!pending || cancelled) return;
        await AsyncStorage.removeItem('pending_referral_code');
        try {
          await referralService.applyReferralCode(user.id, pending);
          if (!cancelled) {
            setReferralApplied(true);
            Toast.show({
              type: 'success',
              text1: t('onboarding.referral_applied_title', { defaultValue: 'Código de referido aplicado' }),
            });
          }
        } catch {
          // Invalid/duplicate stash — surface it in the field so they can fix it.
          if (!cancelled) setReferralCode(pending.toUpperCase());
        }
      } catch {
        /* best-effort — the field still works manually */
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const handleApplyReferral = async () => {
    if (!user?.id || !referralCode.trim() || referralApplying) return;
    setReferralApplying(true);
    try {
      await referralService.applyReferralCode(user.id, referralCode.trim());
      setReferralApplied(true);
      Toast.show({
        type: 'success',
        text1: t('onboarding.referral_applied_title', { defaultValue: 'Código de referido aplicado' }),
        text2: t('onboarding.referral_applied_body', { defaultValue: 'El bono se acreditará cuando tu cuenta sea aprobada.' }),
      });
    } catch (err) {
      Toast.show({
        type: 'error',
        text1: tc('error', { defaultValue: 'Ocurrió un error' }),
        text2: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setReferralApplying(false);
    }
  };

  // Errors
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Phone OTP verification (OAuth signups type the phone by hand — it must be
  // verified before the application accepts it; OTP logins already verified it).
  const [otpVisible, setOtpVisible] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [otpError, setOtpError] = useState('');
  const [otpLoading, setOtpLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [resendTimer, setResendTimer] = useState(0);
  const [pendingPhone, setPendingPhone] = useState('');

  useEffect(() => {
    if (resendTimer <= 0) return;
    const interval = setInterval(() => {
      setResendTimer((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resendTimer > 0]);

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
      newErrors.phone = t('onboarding.error_phone_invalid', { defaultValue: 'Número cubano inválido (5XXXXXXX o 6XXXXXXX)' });
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

  const proceedToVehicle = (normalizedPhone: string) => {
    setPersonalInfo({
      full_name: sanitizeText(fullName),
      phone: normalizedPhone,
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

  const handleNext = async () => {
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
    const normalizedPhone = normalizeCubanPhone(finalPhone);

    // Phone already verified for this account (OTP login, or linked earlier in
    // this onboarding) → no OTP round-trip needed.
    if (user?.phone === normalizedPhone) {
      proceedToVehicle(normalizedPhone);
      return;
    }

    // OAuth signup: the phone was typed by hand. Verify it via OTP (same D7
    // chain as login) before the application accepts it — otherwise drivers
    // could submit someone else's / a wrong number (SMS, passenger contact and
    // SOS all depend on it).
    setSendingCode(true);
    try {
      await authService.linkPhone(normalizedPhone);
      setPendingPhone(normalizedPhone);
      setOtpCode('');
      setOtpError('');
      setResendTimer(60);
      setOtpVisible(true);
    } catch (err) {
      Toast.show({
        type: 'error',
        text1: isRateLimitError(err) ? tc('auth.otp_rate_limited_body') : tc('auth.send_otp_failed'),
        visibilityTime: 3000,
      });
    } finally {
      setSendingCode(false);
    }
  };

  const handleVerifyOtp = async () => {
    setOtpError('');
    if (!isValidOTP(otpCode)) {
      setOtpError(tc('auth.invalid_otp'));
      return;
    }
    setOtpLoading(true);
    try {
      // link-phone EF validates the code and links the phone server-side
      // (auth.users + public.users mirror) — no separate updateProfile needed.
      await authService.verifyPhoneLink(pendingPhone, otpCode);
      if (user) {
        try {
          const updated = await authService.getUserById(user.id);
          if (updated) setUser(updated);
        } catch { /* store refresh is best-effort — the server already linked it */ }
      }
      setOtpVisible(false);
      proceedToVehicle(pendingPhone);
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      setOtpError(
        code === 'PHONE_TAKEN'
          ? tc('auth.phone_taken')
          : code === 'INVALID_CODE'
            ? tc('auth.invalid_otp')
            : tc('errors.generic'),
      );
    } finally {
      setOtpLoading(false);
    }
  };

  const handleResendOtp = async () => {
    try {
      await authService.linkPhone(pendingPhone);
      setResendTimer(60);
      Toast.show({
        type: 'success',
        text1: tc('auth.resend_success_title', { defaultValue: 'Código reenviado' }),
        text2: tc('auth.resend_success_body', { defaultValue: 'Revisá los mensajes del teléfono.' }),
        visibilityTime: 2500,
      });
    } catch (err) {
      setOtpError(isRateLimitError(err) ? tc('auth.otp_rate_limited_body') : tc('auth.send_otp_failed'));
    }
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
                  <Text variant="caption" color="secondary" style={{ color: midnightEmber.map.text.secondary }}>
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
                        placeholder="5XXXXXXX o 6XXXXXXX"
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
                    <Text variant="caption" color="secondary" className="mt-1" style={{ color: midnightEmber.map.text.secondary }}>
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
                    <Text variant="caption" color="secondary" className="mt-1" style={{ color: midnightEmber.map.text.secondary }}>
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

            {/* ─── Referral code (optional) ─── */}
            <AnimatedCard delay={550} duration={400}>
              <Card
                forceDark
                variant="filled"
                padding="lg"
                className="mb-5"
                style={{ backgroundColor: midnightEmber.map.bg.surface }}
              >
                {referralApplied ? (
                  <View className="flex-row items-center">
                    <Ionicons name="checkmark-circle" size={20} color={midnightEmber.state.success} />
                    <Text variant="bodySmall" color="inverse" className="ml-2 flex-1">
                      {t('onboarding.referral_applied_title', { defaultValue: 'Código de referido aplicado' })}
                    </Text>
                  </View>
                ) : (
                  <>
                    <Text variant="body" color="inverse">
                      {t('onboarding.referral_title', { defaultValue: '¿Te invitó alguien? (opcional)' })}
                    </Text>
                    <Text variant="caption" color="secondary" className="mt-1" style={{ color: midnightEmber.map.text.secondary }}>
                      {t('onboarding.referral_hint', { defaultValue: 'Ingresa el código de referido de quien te invitó. Aplícalo antes de que aprobemos tu cuenta.' })}
                    </Text>
                    <View className="mt-3">
                      <Input
                        label=""
                        placeholder={tc('profile.referral_enter_code', { defaultValue: 'Ingresa el código' })}
                        value={referralCode}
                        onChangeText={setReferralCode}
                        autoCapitalize="characters"
                        variant="dark"
                      />
                      {referralCode.trim().length > 0 && (
                        <Button
                          title={tc('profile.referral_apply', { defaultValue: 'Aplicar código' })}
                          variant="outline"
                          size="sm"
                          forceDark
                          onPress={handleApplyReferral}
                          loading={referralApplying}
                          disabled={referralApplying}
                          className="mt-2"
                        />
                      )}
                    </View>
                  </>
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
                loading={sendingCode}
                disabled={sendingCode}
                className="mt-2 mb-8"
              />
            </AnimatedCard>

            {/* BUG-299: escape hatch — driver can switch accounts at any
                onboarding step. Without this they're trapped after OTP. */}
            <SwitchAccountFooter />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* ─── Phone OTP verification (OAuth signups) ─── */}
      <Modal
        visible={otpVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setOtpVisible(false)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.6)',
            justifyContent: 'center',
            paddingHorizontal: 24,
          }}
        >
          <View
            style={{
              backgroundColor: midnightEmber.map.bg.surface,
              borderRadius: 20,
              padding: 24,
              borderWidth: 1,
              borderColor: midnightEmber.map.line.hairline,
              maxWidth: 420,
              width: '100%',
              alignSelf: 'center',
            }}
          >
            <View className="flex-row items-center mb-3">
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
                <Ionicons name="shield-checkmark-outline" size={20} color={midnightEmber.accent[500]} />
              </View>
              <Text variant="h3" color="inverse">
                {tc('auth.otp_title')}
              </Text>
            </View>
            <Text variant="bodySmall" color="secondary" className="mb-5" style={{ color: midnightEmber.map.text.secondary }}>
              {tc('auth.otp_subtitle', { phone: pendingPhone })}
            </Text>

            <Input
              placeholder="000000"
              keyboardType="number-pad"
              maxLength={6}
              value={otpCode}
              onChangeText={(v) => {
                // UX: clear stale error as the user retypes — same pattern
                // as the rest of the auth flow.
                if (otpError) setOtpError('');
                setOtpCode(v);
              }}
              variant="dark"
              autoFocus
            />

            {otpError ? (
              <Text variant="bodySmall" color="error" className="mb-2">{otpError}</Text>
            ) : null}

            <Button
              title={tc('auth.verify')}
              onPress={handleVerifyOtp}
              loading={otpLoading}
              disabled={otpCode.length !== 6 || otpLoading}
              fullWidth
              size="lg"
              className="mt-1"
            />
            <Button
              title={
                resendTimer > 0
                  ? tc('auth.resend_in', { seconds: resendTimer })
                  : tc('auth.resend_code')
              }
              variant="ghost"
              onPress={handleResendOtp}
              disabled={resendTimer > 0 || otpLoading}
              forceDark
              className="mt-3"
              fullWidth
            />
            <Button
              title={tc('auth.change_number')}
              variant="ghost"
              onPress={() => {
                setOtpVisible(false);
                setOtpCode('');
                setOtpError('');
              }}
              disabled={otpLoading}
              forceDark
              className="mt-1"
              fullWidth
            />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}
