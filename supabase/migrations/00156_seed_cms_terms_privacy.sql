-- ============================================================
-- BUG-090 prep: seed cms_content with default 'terms' and 'privacy'
-- rows so the admin /content page can surface them for editing and
-- the mobile apps (driver + client) can fetch them via
-- cmsService.getContent() instead of loading the hardcoded
-- https://tricigo.com/* URL in a WebView.
--
-- Idempotent: uses ON CONFLICT on the UNIQUE slug constraint.
-- Bodies are deliberately short placeholders; admin should edit them
-- in /content before publishing to end-users.
-- ============================================================

INSERT INTO cms_content (slug, title_es, title_en, body_es, body_en)
VALUES
  (
    'terms',
    'Términos y Condiciones',
    'Terms and Conditions',
    E'Bienvenido a TriciGo.\n\nAl usar nuestro servicio aceptás estos términos. TriciGo es una plataforma que conecta pasajeros con conductores independientes en Cuba. No somos una empresa de transporte — solo facilitamos la conexión.\n\n1. ACEPTACIÓN\nAl crear una cuenta o usar la app aceptás estos términos y nuestra Política de Privacidad.\n\n2. ELEGIBILIDAD\nDebés tener al menos 18 años y capacidad legal para contratar.\n\n3. CUENTAS\nSos responsable de mantener la confidencialidad de tu cuenta y todas las actividades que ocurran bajo ella.\n\n4. PAGOS\nLos viajes se pagan en efectivo (CUP) o con TriciCoin. Las comisiones de la plataforma se calculan al completar el viaje.\n\n5. CANCELACIONES\nCancelaciones tardías pueden generar un cargo de penalización para mantener el servicio viable.\n\n6. CONDUCTA\nEsperamos respeto entre conductores y pasajeros. Cualquier conducta inapropiada puede resultar en suspensión.\n\n7. CONTACTO\nPara dudas: soporte@tricigo.com\n\nÚltima actualización: diciembre 2026.',
    E'Welcome to TriciGo.\n\nBy using our service you accept these terms. TriciGo is a platform connecting riders with independent drivers in Cuba. We are not a transportation company — we only facilitate the connection.\n\n1. ACCEPTANCE\nCreating an account or using the app constitutes acceptance of these terms and our Privacy Policy.\n\n2. ELIGIBILITY\nYou must be at least 18 years old and have legal capacity to contract.\n\n3. ACCOUNTS\nYou are responsible for maintaining the confidentiality of your account and all activities under it.\n\n4. PAYMENTS\nRides are paid in cash (CUP) or with TriciCoin. Platform commissions are calculated on ride completion.\n\n5. CANCELLATIONS\nLate cancellations may incur a penalty fee to keep the service viable.\n\n6. CONDUCT\nWe expect mutual respect between drivers and riders. Inappropriate conduct may result in suspension.\n\n7. CONTACT\nQuestions: support@tricigo.com\n\nLast updated: December 2026.'
  ),
  (
    'privacy',
    'Política de Privacidad',
    'Privacy Policy',
    E'Tu privacidad nos importa.\n\nEsta política explica qué datos recolectamos y cómo los usamos.\n\n1. DATOS QUE RECOLECTAMOS\nPara ofrecer el servicio necesitamos: nombre, teléfono, ubicación durante el viaje, método de pago, historial de viajes y calificaciones.\n\n2. CÓMO LOS USAMOS\n- Para conectarte con conductores/pasajeros cerca tuyo\n- Para procesar pagos y calcular tarifas\n- Para mejorar la seguridad del servicio\n- Para análisis agregados (no individuales)\n\n3. COMPARTIR CON TERCEROS\nNo vendemos tus datos. Los compartimos solo con:\n- Conductores o pasajeros del viaje actual (nombre, foto, rating)\n- Procesadores de pago para procesar transacciones\n- Autoridades cuando la ley lo requiera\n\n4. SEGURIDAD\nUsamos cifrado en tránsito y en reposo para datos sensibles.\n\n5. TUS DERECHOS\nPodés solicitar acceso, rectificación o eliminación de tus datos escribiendo a soporte@tricigo.com.\n\n6. RETENCIÓN\nGuardamos tu historial de viajes por requisitos legales (típicamente 5 años).\n\n7. CONTACTO\nPrivacidad: privacy@tricigo.com\n\nÚltima actualización: diciembre 2026.',
    E'Your privacy matters.\n\nThis policy explains what data we collect and how we use it.\n\n1. DATA WE COLLECT\nTo provide the service we need: name, phone, location during rides, payment method, ride history, and ratings.\n\n2. HOW WE USE IT\n- To connect you with nearby drivers/riders\n- To process payments and calculate fares\n- To improve service safety\n- For aggregate analytics (not individual)\n\n3. SHARING WITH THIRD PARTIES\nWe do not sell your data. We share only with:\n- Drivers or riders on the current trip (name, photo, rating)\n- Payment processors to process transactions\n- Authorities when required by law\n\n4. SECURITY\nWe use encryption in transit and at rest for sensitive data.\n\n5. YOUR RIGHTS\nYou may request access, correction, or deletion of your data by emailing support@tricigo.com.\n\n6. RETENTION\nWe retain your ride history for legal requirements (typically 5 years).\n\n7. CONTACT\nPrivacy: privacy@tricigo.com\n\nLast updated: December 2026.'
  )
ON CONFLICT (slug) DO NOTHING;
