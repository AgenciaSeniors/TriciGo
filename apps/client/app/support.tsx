import React, { useState } from 'react';
import { View, Pressable, Linking, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';

const FAQ_ITEMS = [
  { qKey: 'support.faq_q1', aKey: 'support.faq_a1', defaultQ: '¿Cómo solicito un viaje?', defaultA: 'Abre la app, selecciona tu destino en el mapa o escríbelo en la barra de búsqueda, elige el tipo de vehículo y confirma tu solicitud.' },
  { qKey: 'support.faq_q2', aKey: 'support.faq_a2', defaultQ: '¿Cómo recargo mi billetera?', defaultA: 'Ve a la sección Billetera, selecciona "Recargar con TropiPay" e ingresa el monto deseado en CUP.' },
  { qKey: 'support.faq_q3', aKey: 'support.faq_a3', defaultQ: '¿Cómo reporto un problema con un viaje?', defaultA: 'Ve a Perfil → Ayuda y crea un nuevo ticket seleccionando la categoría "Problema con viaje".' },
  { qKey: 'support.faq_q4', aKey: 'support.faq_a4', defaultQ: '¿Puedo transferir saldo a otro usuario?', defaultA: 'Sí. En la Billetera, usa la sección "Transferir a otro usuario" e ingresa el teléfono del destinatario.' },
  { qKey: 'support.faq_q5', aKey: 'support.faq_a5', defaultQ: '¿Cómo contacto al conductor?', defaultA: 'Durante un viaje activo, puedes chatear con tu conductor desde la pantalla del viaje o llamarlo directamente.' },
];

export default function SupportScreen() {
  const { t } = useTranslation('common');
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const contactMethods = [
    {
      icon: 'logo-whatsapp' as const,
      label: 'WhatsApp',
      description: t('support.whatsapp_desc', { defaultValue: 'Chatea con nuestro equipo' }),
      color: '#25D366',
      onPress: () => Linking.openURL('https://wa.me/5355555555'),
    },
    {
      icon: 'mail-outline' as const,
      label: t('support.email', { defaultValue: 'Correo electrónico' }),
      description: 'soporte@tricigo.com',
      color: colors.primary.DEFAULT,
      onPress: () => Linking.openURL('mailto:soporte@tricigo.com?subject=Soporte%20TriciGo'),
    },
  ];

  return (
    <Screen bg="white" padded>
      <ScrollView showsVerticalScrollIndicator={false}>
        <View className="pt-4 pb-8">
          <ScreenHeader
            title={t('support.title', { defaultValue: 'Soporte' })}
            onBack={() => router.back()}
          />

          {/* Contact methods */}
          <Text variant="caption" color="tertiary" className="mt-5 mb-2 uppercase tracking-wider font-semibold">
            {t('support.contact_us', { defaultValue: 'Contáctanos' })}
          </Text>
          {contactMethods.map((method) => (
            <Pressable
              key={method.label}
              onPress={method.onPress}
              className="flex-row items-center py-4 border-b border-neutral-100 dark:border-neutral-800"
            >
              <View
                style={{
                  width: 40, height: 40, borderRadius: 12,
                  backgroundColor: `${method.color}15`,
                  justifyContent: 'center', alignItems: 'center',
                }}
              >
                <Ionicons name={method.icon} size={22} color={method.color} />
              </View>
              <View className="flex-1 ml-3">
                <Text variant="body" className="font-medium">{method.label}</Text>
                <Text variant="caption" color="tertiary">{method.description}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.neutral[400]} />
            </Pressable>
          ))}

          {/* Help center link */}
          <Pressable
            onPress={() => router.push('/profile/help')}
            className="flex-row items-center py-4 border-b border-neutral-100 dark:border-neutral-800"
          >
            <View
              style={{
                width: 40, height: 40, borderRadius: 12,
                backgroundColor: `${colors.primary.DEFAULT}15`,
                justifyContent: 'center', alignItems: 'center',
              }}
            >
              <Ionicons name="ticket-outline" size={22} color={colors.primary.DEFAULT} />
            </View>
            <View className="flex-1 ml-3">
              <Text variant="body" className="font-medium">
                {t('support.help_center', { defaultValue: 'Centro de Ayuda' })}
              </Text>
              <Text variant="caption" color="tertiary">
                {t('support.help_center_desc', { defaultValue: 'Tickets, historial y seguimiento' })}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.neutral[400]} />
          </Pressable>

          {/* FAQ */}
          <Text variant="caption" color="tertiary" className="mt-6 mb-2 uppercase tracking-wider font-semibold">
            {t('support.faq_title', { defaultValue: 'Preguntas frecuentes' })}
          </Text>
          <Card variant="outlined" padding="none" className="overflow-hidden">
            {FAQ_ITEMS.map((item, idx) => (
              <View key={idx}>
                <Pressable
                  onPress={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
                  className="flex-row items-center justify-between px-4 py-3.5"
                  style={idx > 0 ? { borderTopWidth: 1, borderTopColor: '#f3f4f6' } : undefined}
                >
                  <Text variant="bodySmall" className="flex-1 pr-2 font-medium">
                    {t(item.qKey, { defaultValue: item.defaultQ })}
                  </Text>
                  <Ionicons
                    name={expandedIdx === idx ? 'chevron-up' : 'chevron-down'}
                    size={18}
                    color={colors.neutral[400]}
                  />
                </Pressable>
                {expandedIdx === idx && (
                  <View className="px-4 pb-3.5">
                    <Text variant="bodySmall" color="secondary">
                      {t(item.aKey, { defaultValue: item.defaultA })}
                    </Text>
                  </View>
                )}
              </View>
            ))}
          </Card>

          {/* App info */}
          <View className="mt-8 items-center">
            <Text variant="caption" color="tertiary">
              TriciGo v1.0.0
            </Text>
            <Text variant="caption" color="tertiary" className="mt-1">
              {t('support.available', { defaultValue: 'Disponible 24/7' })}
            </Text>
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}
