-- ============================================================
-- Migration 00275: Sync legal content into cms_content
--
-- The web /terms and /privacy pages (apps/web) and the mobile apps
-- render the cms_content row for a slug whenever one exists, and
-- only fall back to the i18n JSON bundle when it is missing.
--
-- The cms_content 'terms' and 'privacy' rows were seeded with short
-- placeholders in 00156_seed_cms_terms_privacy.sql. As a result the
-- LIVE legal pages show those placeholders — NOT the compliance
-- content added to the i18n bundle in Sprint 2 (closed-loop clause,
-- acceptable-use / AML limits, GDPR legal basis + ANSPDCP, PCI-DSS
-- SAQ-A, statement descriptor).
--
-- This migration overwrites the 'terms' and 'privacy' bodies with
-- the full current legal text so the live pages match the i18n
-- source of truth. Further edits should go through the admin
-- /content editor (cmsService.updateContent).
--
-- The page renders the body as plain text: newlines are converted
-- to <br /> and the result is sanitized before rendering.
-- ============================================================

UPDATE cms_content
SET
  title_es = 'Términos y Condiciones de Servicio',
  title_en = 'Terms and Conditions of Service',
  body_es = $terms_es$Última actualización: 11 de marzo de 2026

ACEPTACIÓN DE LOS TÉRMINOS
Al descargar, instalar o utilizar la aplicación TriciGo, aceptas estos Términos y Condiciones de Servicio. Si no estás de acuerdo, no utilices el servicio. TriciGo se reserva el derecho de modificar estos términos con previo aviso.

DESCRIPCIÓN DEL SERVICIO
TriciGo es una plataforma tecnológica que conecta pasajeros con conductores independientes de triciclos, motos y autos en La Habana, Cuba. TriciGo no es una empresa de transporte; actúa como intermediario tecnológico facilitando la conexión entre usuarios y conductores.

ELEGIBILIDAD
Para usar TriciGo debes tener al menos 18 años de edad, poseer un número de teléfono móvil válido en Cuba, y proporcionar información veraz al registrarte. Los conductores deben cumplir requisitos adicionales de documentación y verificación.

CUENTAS DE USUARIO
Cada usuario debe crear una cuenta con un número de teléfono válido. Eres responsable de mantener la seguridad de tu cuenta y de todas las actividades realizadas bajo ella. No debes compartir tu cuenta con terceros. TriciGo puede suspender o cancelar cuentas que violen estos términos.

VIAJES
Al solicitar un viaje, recibirás una estimación de tarifa que puede variar según la distancia real, el tiempo y las condiciones de demanda (tarifa dinámica). La tarifa final es la acordada entre pasajero y conductor. TriciGo cobra una comisión de servicio sobre cada viaje completado.

PAGOS
Los pagos pueden realizarse en efectivo (CUP) o con créditos de viaje TriciCoin. Los créditos TriciCoin son crédito de viaje prepago, canjeable únicamente por servicios de transporte de TriciGo — ver la sección «Naturaleza de los créditos TriciCoin». Las tarifas se muestran en la moneda local (CUP).

NATURALEZA DE LOS CRÉDITOS TRICICOIN
Los créditos TriciCoin son saldo interno prepago, canjeable exclusivamente por servicios de transporte dentro de la plataforma TriciGo. No constituyen dinero, moneda, dinero electrónico (e-money) ni un instrumento de pago; no son transferibles a otros usuarios ni convertibles a efectivo, y no representan una cuenta de pago ni bancaria. Los créditos se adquieren por adelantado y se consumen únicamente al pagar viajes.

USO ACEPTABLE DE LOS CRÉDITOS
Los créditos TriciCoin solo pueden utilizarse para pagar viajes dentro de la plataforma TriciGo. Cada recarga está sujeta a límites: un mínimo de 20 USD y un máximo de 500 USD por operación. Monitoreamos patrones de uso anómalos y nos reservamos el derecho de suspender una cuenta ante cualquier indicio de uso indebido o fraudulento de los créditos.

SEGURIDAD DE LOS PAGOS CON TARJETA
El procesamiento de pagos con tarjeta se realiza a través de un proveedor de pagos certificado bajo el estándar PCI-DSS Level 1. MACH DIGITAL TECH S.R.L. no almacena datos de tarjetas en sus sistemas; su entorno de pago califica como PCI-DSS SAQ-A.

IDENTIFICACIÓN DEL CARGO
Los cargos asociados a tus recargas aparecerán en el estado de cuenta de tu tarjeta con la descripción "TRICIGO MOBILITY RO".

CANCELACIONES
Puedes cancelar un viaje antes de que el conductor llegue al punto de recogida. Cancelaciones frecuentes o tardías pueden resultar en restricciones temporales de tu cuenta. Los conductores también pueden cancelar viajes bajo circunstancias justificadas.

CÓDIGO DE CONDUCTA
Todos los usuarios deben:
- Tratar a conductores y pasajeros con respeto y cortesía
- Cumplir con todas las leyes y regulaciones locales aplicables
- No realizar actividades fraudulentas ni manipular el sistema de referidos o promociones
- No causar daños a los vehículos ni a las pertenencias de otros usuarios

LIMITACIÓN DE RESPONSABILIDAD
TriciGo facilita la conexión entre pasajeros y conductores pero no es responsable directo del transporte. No garantizamos la disponibilidad permanente del servicio. Nuestra responsabilidad se limita al monto pagado por el servicio en cuestión. No somos responsables de objetos perdidos, aunque facilitaremos la comunicación entre las partes.

PROPIEDAD INTELECTUAL
La aplicación TriciGo, su diseño, logotipo, nombre y contenido son propiedad de TriciGo. No puedes copiar, modificar, distribuir o crear obras derivadas sin autorización escrita.

TERMINACIÓN
TriciGo puede suspender o terminar tu acceso al servicio en cualquier momento si violas estos términos, realizas actividades fraudulentas o pones en riesgo la seguridad de otros usuarios. Puedes eliminar tu cuenta en cualquier momento desde la configuración de la app.

MODIFICACIONES AL SERVICIO
TriciGo puede modificar, suspender o discontinuar cualquier aspecto del servicio en cualquier momento. Te notificaremos sobre cambios significativos con antelación razonable.

LEY APLICABLE
Estos términos se rigen por las leyes de la República de Cuba. Cualquier disputa será resuelta en los tribunales competentes de La Habana, Cuba.

CONTACTO
Para consultas sobre estos Términos y Condiciones:
soporte@tricigo.com$terms_es$,
  body_en = $terms_en$Last updated: March 11, 2026

ACCEPTANCE OF TERMS
By downloading, installing, or using the TriciGo application, you agree to these Terms and Conditions of Service. If you disagree, do not use the service. TriciGo reserves the right to modify these terms with prior notice.

SERVICE DESCRIPTION
TriciGo is a technology platform that connects passengers with independent drivers of triciclos, motorcycles, and cars in Havana, Cuba. TriciGo is not a transportation company; it acts as a technology intermediary facilitating connections between users and drivers.

ELIGIBILITY
To use TriciGo you must be at least 18 years old, have a valid mobile phone number in Cuba, and provide accurate information when registering. Drivers must meet additional documentation and verification requirements.

USER ACCOUNTS
Each user must create an account with a valid phone number. You are responsible for maintaining the security of your account and all activities conducted under it. You must not share your account with third parties. TriciGo may suspend or cancel accounts that violate these terms.

RIDES
When requesting a ride, you will receive a fare estimate that may vary based on actual distance, time, and demand conditions (surge pricing). The final fare is agreed upon between passenger and driver. TriciGo charges a service commission on each completed ride.

PAYMENTS
Payments can be made in cash (CUP) or with TriciCoin trip credits. TriciCoin credits are prepaid trip credit, redeemable solely for TriciGo transportation services — see the section "Nature of TriciCoin Credits". Fares are displayed in local currency (CUP).

NATURE OF TRICICOIN CREDITS
TriciCoin credits are internal prepaid balance, redeemable exclusively for transportation services within the TriciGo platform. They do not constitute money, currency, electronic money (e-money), or a payment instrument; they are not transferable to other users or convertible to cash, and they do not represent a payment or bank account. Credits are purchased in advance and are consumed solely when paying for rides.

ACCEPTABLE USE OF CREDITS
TriciCoin credits may only be used to pay for rides within the TriciGo platform. Each top-up is subject to limits: a minimum of 20 USD and a maximum of 500 USD per transaction. We monitor anomalous usage patterns and reserve the right to suspend an account upon any indication of misuse or fraudulent use of credits.

CARD PAYMENT SECURITY
Card payment processing is carried out through a payment provider certified under the PCI-DSS Level 1 standard. MACH DIGITAL TECH S.R.L. does not store card data on its systems; its payment environment qualifies as PCI-DSS SAQ-A.

CHARGE IDENTIFICATION
Charges related to your top-ups will appear on your card statement with the description "TRICIGO MOBILITY RO".

CANCELLATIONS
You may cancel a ride before the driver arrives at the pickup point. Frequent or late cancellations may result in temporary restrictions on your account. Drivers may also cancel rides under justified circumstances.

CODE OF CONDUCT
All users must:
- Treat drivers and passengers with respect and courtesy
- Comply with all applicable local laws and regulations
- Not engage in fraudulent activities or manipulate the referral or promotions system
- Not cause damage to vehicles or other users' belongings

LIMITATION OF LIABILITY
TriciGo facilitates connections between passengers and drivers but is not directly responsible for transportation. We do not guarantee permanent service availability. Our liability is limited to the amount paid for the service in question. We are not responsible for lost items, although we will facilitate communication between parties.

INTELLECTUAL PROPERTY
The TriciGo application, its design, logo, name, and content are property of TriciGo. You may not copy, modify, distribute, or create derivative works without written authorization.

TERMINATION
TriciGo may suspend or terminate your access to the service at any time if you violate these terms, engage in fraudulent activities, or endanger other users' safety. You may delete your account at any time from the app settings.

SERVICE MODIFICATIONS
TriciGo may modify, suspend, or discontinue any aspect of the service at any time. We will notify you of significant changes with reasonable advance notice.

GOVERNING LAW
These terms are governed by the laws of the Republic of Cuba. Any dispute shall be resolved in the competent courts of Havana, Cuba.

CONTACT
For inquiries about these Terms and Conditions:
soporte@tricigo.com$terms_en$,
  updated_at = NOW()
WHERE slug = 'terms';

UPDATE cms_content
SET
  title_es = 'Política de Privacidad',
  title_en = 'Privacy Policy',
  body_es = $privacy_es$Última actualización: 11 de marzo de 2026

INTRODUCCIÓN
TriciGo ("nosotros", "nuestro") opera la aplicación móvil y el sitio web TriciGo. Esta Política de Privacidad describe cómo recopilamos, usamos, almacenamos y protegemos tu información personal cuando utilizas nuestros servicios de transporte.

RESPONSABLE DEL TRATAMIENTO
El responsable del tratamiento de tus datos personales es MACH DIGITAL TECH S.R.L., sociedad constituida en Brașov, Rumanía. Para cualquier consulta relacionada con la protección de datos puedes contactar a nuestro responsable de protección de datos en soporte@tricigo.com.

BASE LEGAL DEL TRATAMIENTO
Tratamos tus datos personales conforme al Artículo 6 del Reglamento General de Protección de Datos (GDPR). Las bases legales aplicables son: la ejecución del contrato de servicio que nos vincula contigo; nuestro interés legítimo en garantizar la seguridad de la plataforma y prevenir el fraude; y tu consentimiento, cuando este sea requerido para un tratamiento específico.

INFORMACIÓN QUE RECOPILAMOS
Recopilamos la siguiente información para prestarte el servicio:
- Nombre completo y número de teléfono (registro de cuenta)
- Ubicación en tiempo real (solo durante el uso activo de la app para conectarte con conductores cercanos)
- Historial de viajes (origen, destino, tarifa, fecha y hora)
- Información de pago (saldo de créditos de viaje TriciCoin, transacciones)
- Información del dispositivo (modelo, sistema operativo, token de notificaciones push)

CÓMO USAMOS TU INFORMACIÓN
Usamos tu información exclusivamente para:
- Conectarte con conductores y gestionar tus viajes
- Mejorar la calidad del servicio y la experiencia del usuario
- Garantizar la seguridad de pasajeros y conductores
- Enviarte notificaciones sobre tus viajes y actualizaciones del servicio
- Cumplir con obligaciones legales aplicables

COMPARTIR INFORMACIÓN
Compartimos tu nombre y ubicación con el conductor asignado a tu viaje para que pueda recogerte. No vendemos, alquilamos ni compartimos tu información personal con terceros para fines comerciales. Podemos compartir datos anonimizados con fines estadísticos.

ENCARGADOS DEL TRATAMIENTO
Recurrimos a proveedores que procesan datos personales por cuenta de TriciGo, bajo instrucciones contractuales: Supabase (backend y base de datos), Stripe (procesamiento de pagos), Mapbox (servicios de mapas), Sentry (registro de errores) y PostHog (analítica, alojada en la región de la UE). Algunos de estos proveedores pueden implicar transferencias internacionales de datos, sujetas siempre a garantías adecuadas conforme al GDPR.

RETENCIÓN DE DATOS
Conservamos tu información personal mientras mantengas tu cuenta activa. Puedes solicitar la eliminación de tu cuenta y datos asociados en cualquier momento contactándonos. El historial de viajes se conserva por un período mínimo de 1 año por requisitos legales y de seguridad.

TUS DERECHOS
Tienes derecho a:
- Acceder a tu información personal almacenada
- Solicitar la corrección de datos inexactos
- Solicitar la eliminación de tu cuenta y datos
- Solicitar una copia de tus datos en formato portable

AUTORIDAD DE CONTROL
La autoridad de control competente es la ANSPDCP (Autoritatea Națională de Supraveghere a Prelucrării Datelor cu Caracter Personal), la autoridad nacional de protección de datos de Rumanía. Si consideras que el tratamiento de tus datos personales infringe la normativa aplicable, tienes derecho a presentar una reclamación ante ella.

SEGURIDAD
Implementamos medidas de seguridad técnicas y organizativas para proteger tu información, incluyendo cifrado en tránsito (TLS/SSL), autenticación segura y acceso restringido a datos personales. Sin embargo, ningún sistema es 100% seguro.

MENORES DE EDAD
TriciGo no está dirigido a menores de 18 años. No recopilamos intencionalmente información de menores. Si descubrimos que hemos recopilado datos de un menor, los eliminaremos de inmediato.

CAMBIOS A ESTA POLÍTICA
Podemos actualizar esta Política de Privacidad ocasionalmente. Te notificaremos sobre cambios significativos a través de la aplicación o por otros medios. El uso continuado del servicio después de los cambios constituye tu aceptación.

CONTACTO
Si tienes preguntas sobre esta Política de Privacidad o deseas ejercer tus derechos, contáctanos:
soporte@tricigo.com$privacy_es$,
  body_en = $privacy_en$Last updated: March 11, 2026

INTRODUCTION
TriciGo ("we", "our") operates the TriciGo mobile application and website. This Privacy Policy describes how we collect, use, store, and protect your personal information when you use our transportation services.

DATA CONTROLLER
The controller of your personal data is MACH DIGITAL TECH S.R.L., a company incorporated in Brașov, Romania. For any data protection inquiries, you may contact our data protection contact at soporte@tricigo.com.

LEGAL BASIS FOR PROCESSING
We process your personal data in accordance with Article 6 of the General Data Protection Regulation (GDPR). The applicable legal bases are: performance of the service contract between you and us; our legitimate interest in ensuring platform security and preventing fraud; and your consent, where it is required for a specific processing activity.

INFORMATION WE COLLECT
We collect the following information to provide you with the service:
- Full name and phone number (account registration)
- Real-time location (only during active app use to connect you with nearby drivers)
- Ride history (origin, destination, fare, date and time)
- Payment information (TriciCoin trip credit balance, transactions)
- Device information (model, operating system, push notification token)

HOW WE USE YOUR INFORMATION
We use your information exclusively to:
- Connect you with drivers and manage your rides
- Improve service quality and user experience
- Ensure the safety of passengers and drivers
- Send you notifications about your rides and service updates
- Comply with applicable legal obligations

INFORMATION SHARING
We share your name and location with the driver assigned to your ride so they can pick you up. We do not sell, rent, or share your personal information with third parties for commercial purposes. We may share anonymized data for statistical purposes.

DATA PROCESSORS
We rely on providers that process personal data on TriciGo's behalf, under contractual instructions: Supabase (backend and database), Stripe (payment processing), Mapbox (mapping services), Sentry (error logging), and PostHog (analytics, hosted in the EU region). Some of these providers may involve international data transfers, which are always subject to adequate safeguards under the GDPR.

DATA RETENTION
We retain your personal information as long as your account remains active. You may request deletion of your account and associated data at any time by contacting us. Ride history is retained for a minimum of 1 year for legal and safety requirements.

YOUR RIGHTS
You have the right to:
- Access your stored personal information
- Request correction of inaccurate data
- Request deletion of your account and data
- Request a copy of your data in a portable format

SUPERVISORY AUTHORITY
The competent supervisory authority is the ANSPDCP (Autoritatea Națională de Supraveghere a Prelucrării Datelor cu Caracter Personal), Romania's national data protection authority. If you believe the processing of your personal data infringes applicable law, you have the right to lodge a complaint with it.

SECURITY
We implement technical and organizational security measures to protect your information, including encryption in transit (TLS/SSL), secure authentication, and restricted access to personal data. However, no system is 100% secure.

CHILDREN
TriciGo is not directed at children under 18 years of age. We do not knowingly collect information from minors. If we discover we have collected data from a minor, we will promptly delete it.

CHANGES TO THIS POLICY
We may update this Privacy Policy from time to time. We will notify you of significant changes through the application or other means. Continued use of the service after changes constitutes your acceptance.

CONTACT
If you have questions about this Privacy Policy or wish to exercise your rights, contact us:
soporte@tricigo.com$privacy_en$,
  updated_at = NOW()
WHERE slug = 'privacy';
