// ============================================================
// TriciGo — driver platform-licence contract copy (ES + RO).
//
// Used by generate-driver-contract to render the two PDF variants:
//   - Spanish:  sent to the driver + administration. The T&C annex
//     (Anexo A) body comes from cms_content('terms').body_es AT RUNTIME
//     so the PDF captures exactly the version the driver accepted.
//   - Romanian: sent to administration only (the operating company
//     MACH DIGITAL TECH S.R.L. is Romanian). The Anexo A body is the
//     static translation below (TERMS_RO_BODY), based on the live
//     body_es as of 2026-05-30.
//
// The contract body itself (sections I–XVI + declaration + signatures)
// is the formal "Contrato de Licencia de Uso de Plataforma Digital"
// authored by the company. It is transcribed verbatim per language
// below as structured blocks so the PDF builder can apply TriciGo's
// visual identity (logo, orange section headers, chip) while keeping
// the legal text a single-file diff for review.
//
// ⚠️ KEEP IN SYNC: if cms_content('terms').body_es changes through the
// admin /content editor, update TERMS_RO_BODY (and TERMS_RO_BASED_ON)
// here in the next deploy. The generated PDF stamps the live ES version
// date so drift is detectable.
// ============================================================

/** ES-version date this Romanian translation was made from. */
export const TERMS_RO_BASED_ON = '2026-05-30';

export const TERMS_RO_TITLE = 'Termeni și Condiții de Utilizare';

export const TERMS_RO_BODY = `Prin utilizarea TriciGo accepți acești Termeni și Condiții. TriciGo este o platformă operată de MACH DIGITAL TECH S.R.L. care conectează pasageri cu șoferi independenți în Cuba; nu suntem o companie de transport, doar facilităm conexiunea.

Ultima actualizare: 30 mai 2026

1. ACCEPTAREA TERMENILOR
Prin descărcarea, instalarea sau utilizarea aplicației TriciGo, accepți acești Termeni și Condiții de Utilizare. Dacă nu ești de acord, nu utiliza serviciul. TriciGo își rezervă dreptul de a modifica acești termeni cu notificare prealabilă.

2. DESCRIEREA SERVICIULUI
TriciGo este o platformă tehnologică ce conectează pasageri cu șoferi independenți de triciclete, motociclete și automobile în Cuba. TriciGo nu este o companie de transport; acționează ca intermediar tehnologic, facilitând conexiunea dintre utilizatori și șoferi.

3. ELIGIBILITATE
Pentru a folosi TriciGo trebuie să ai cel puțin 18 ani, să deții un număr de telefon mobil valid în Cuba și să furnizezi informații reale la înregistrare. Șoferii trebuie să îndeplinească cerințe suplimentare de documentație și verificare.

4. CONTURILE UTILIZATORILOR
Fiecare utilizator trebuie să își creeze un cont cu un număr de telefon valid. Ești responsabil de menținerea securității contului tău și de toate activitățile realizate prin intermediul acestuia. Nu trebuie să împarți contul cu terți. TriciGo poate suspenda sau anula conturile care încalcă acești termeni.

5. CURSE
La solicitarea unei curse vei primi o estimare a tarifului, care poate varia în funcție de distanța reală, timp și condițiile de cerere (tarif dinamic). Tariful final este cel convenit între pasager și șofer. TriciGo percepe un comision de serviciu pentru fiecare cursă finalizată.

6. PLĂȚI
Plățile pot fi efectuate în numerar (CUP) sau cu credite de călătorie TriciCoin. Creditele TriciCoin sunt credit de călătorie preplătit, valorificabil exclusiv pentru serviciile de transport TriciGo — vezi secțiunea «Natura creditelor TriciCoin». Tarifele sunt afișate în moneda locală (CUP).

7. NATURA CREDITELOR TRICICOIN
Creditele TriciCoin reprezintă sold intern preplătit, valorificabil exclusiv pentru servicii de transport în cadrul platformei TriciGo. Nu constituie bani, monedă, monedă electronică (e-money) și nici un instrument de plată; nu sunt convertibile în numerar și nu reprezintă un cont de plăți sau un cont bancar. Pot fi trimise cadou unei alte persoane utilizatoare înregistrate TriciGo prin funcția «Cadou», păstrându-și natura de credit de transport în circuit închis: soldul dăruit poate fi folosit doar pentru plata curselor în cadrul platformei și nu poate fi schimbat în bani. Creditele se achiziționează în avans și se consumă la plata curselor.

8. UTILIZAREA ACCEPTABILĂ A CREDITELOR
Creditele TriciCoin pot fi utilizate doar pentru plata curselor în cadrul platformei TriciGo. Fiecare reîncărcare este supusă unor limite: minimum 20 USD și maximum 500 USD per operațiune. Monitorizăm tiparele de utilizare anormale și ne rezervăm dreptul de a suspenda un cont la orice indiciu de utilizare abuzivă sau frauduloasă a creditelor.

9. SECURITATEA PLĂȚILOR CU CARDUL
Procesarea plăților cu cardul se realizează printr-un furnizor de plăți certificat conform standardului PCI-DSS Level 1. MACH DIGITAL TECH S.R.L. nu stochează date de card în sistemele sale; mediul său de plată se califică drept PCI-DSS SAQ-A.

10. IDENTIFICAREA TRANZACȚIEI
Sumele aferente reîncărcărilor tale vor apărea pe extrasul de cont al cardului cu descrierea "TRICIGO MOBILITY RO".

11. ANULĂRI
Poți anula o cursă înainte ca șoferul să ajungă la punctul de preluare. Anulările frecvente sau târzii pot duce la restricții temporare ale contului tău. Șoferii pot, de asemenea, anula curse în circumstanțe justificate.

12. CODUL DE CONDUITĂ
Toți utilizatorii trebuie:
- Să trateze șoferii și pasagerii cu respect și curtoazie
- Să respecte toate legile și reglementările locale aplicabile
- Să nu desfășoare activități frauduloase și să nu manipuleze sistemul de recomandări sau promoții
- Să nu provoace daune vehiculelor sau bunurilor altor utilizatori

13. LIMITAREA RĂSPUNDERII
TriciGo facilitează conexiunea dintre pasageri și șoferi, dar nu este direct responsabil pentru transport. Nu garantăm disponibilitatea permanentă a serviciului. Răspunderea noastră se limitează la suma plătită pentru serviciul în cauză. Nu suntem responsabili pentru obiectele pierdute, însă vom facilita comunicarea între părți.

14. PROPRIETATE INTELECTUALĂ
Aplicația TriciGo, designul, logo-ul, numele și conținutul său sunt proprietatea TriciGo. Nu poți copia, modifica, distribui sau crea opere derivate fără autorizație scrisă.

15. ÎNCETAREA
TriciGo poate suspenda sau înceta accesul tău la serviciu în orice moment dacă încalci acești termeni, desfășori activități frauduloase sau pui în pericol siguranța altor utilizatori. Îți poți șterge contul în orice moment din setările aplicației.

16. MODIFICĂRI ALE SERVICIULUI
TriciGo poate modifica, suspenda sau întrerupe orice aspect al serviciului în orice moment. Te vom notifica cu privire la schimbările semnificative cu un preaviz rezonabil.

17. LEGEA APLICABILĂ
Prezenții Termeni și Condiții sunt guvernați și interpretați în conformitate cu dreptul român. Orice litigiu care decurge din utilizarea platformei TriciGo va fi supus instanțelor competente din Brașov, România, fără a aduce atingere dreptului utilizatorului consumator de a se adresa instanțelor de la domiciliul său obișnuit, conform legislației aplicabile privind protecția consumatorului. Acești termeni nu afectează drepturile la care utilizatorul nu poate renunța potrivit legislației din țara sa de reședință. Serviciul de transport este prestat de șoferi independenți și se execută fizic în Cuba, unde este supus reglementărilor de transport și circulație aplicabile în Cuba. Relația contractuală dintre utilizator și MACH DIGITAL TECH S.R.L. — inclusiv platforma, creditele TriciCoin și acești Termeni — este guvernată de dreptul român conform celor de mai sus; legislația cubaneză de transport guvernează prestarea materială a cursei, nu relația contractuală cu platforma.

18. CONTACT
Pentru întrebări despre acești Termeni și Condiții: soporte@tricigo.com.`;

// ── Formal licence contract copy, per language ───────────────────

export type ContractBlockType = 'h1' | 'h2' | 'p' | 'bullet';
export interface ContractBlock {
  type: ContractBlockType;
  text: string;
}

export interface ContractCopy {
  /** Small line under the brand wordmark on the cover. */
  brandTagline: string;
  docTitle: string;
  docSubtitle: string;
  /** Header metadata strip. */
  contractNoLabel: string;
  signDateLabel: string;
  signPlace: string;
  /** Section I — parties. The company data is fixed in the prose. */
  partiesTitle: string;
  partiesBlocks: ContractBlock[];
  /** Section II — driver identification (table filled with real data). */
  identTitle: string;
  identLabels: {
    fullName: string;
    idNumber: string;
    license: string;
    address: string;
    phone: string;
    email: string;
  };
  /** Sections III–XVI as flowing headings / paragraphs / bullets. */
  bodyBlocks: ContractBlock[];
  /** Driver declaration block. */
  declarationTitle: string;
  declarationLead: string;
  declarationItems: string[];
  /** Signature block. */
  signaturesTitle: string;
  platformLabel: string;
  platformName: string;
  platformRep: string;
  platformRepRole: string;
  conductorLabel: string;
  /** {date} replaced with the Havana-time acceptance label. */
  acceptedElectronicallyTpl: string;
  /** {no} replaced with the contract number. */
  contractRefTpl: string;
  /** Anexo A heading shown before the full T&C text. */
  annexTitle: string;
  annexLead: string;
  notProvided: string;
  footerLine: string;
}

export const CONTRACT_ES: ContractCopy = {
  brandTagline: 'Plataforma Digital de Movilidad Urbana',
  docTitle: 'CONTRATO DE LICENCIA DE USO DE PLATAFORMA DIGITAL',
  docSubtitle: 'Conductor — Persona Física',
  contractNoLabel: 'N.º de Contrato',
  signDateLabel: 'Fecha de firma',
  signPlace: 'La Habana, Cuba',
  partiesTitle: 'I.  PARTES DEL CONTRATO',
  partiesBlocks: [
    {
      type: 'p',
      text:
        'De una parte, MACH DIGITAL TECH S.R.L., sociedad de responsabilidad limitada constituida conforme a la Ley n.º 31/1990 de Rumanía, con sede social en Str. Lungă nr. 149, Ap. P3, Municipiul Brașov, Jud. Brașov, România, inscrita en el Registro Mercantil bajo el número J2026027319006 con código único de identificación fiscal CUI 54552055, representada legalmente por Maria Loraime Gonzalez Carvajal Hernandez en calidad de Administrator, titular de la plataforma digital Trici-Go, en adelante «LA PLATAFORMA».',
    },
    {
      type: 'p',
      text:
        'De otra parte, la persona física que se identifica en la Sección II del presente contrato, titular de cédula de identidad o documento equivalente, debidamente registrada como usuario conductor en la aplicación Trici-Go, en adelante «EL CONDUCTOR».',
    },
  ],
  identTitle: 'II.  IDENTIFICACIÓN DEL CONDUCTOR',
  identLabels: {
    fullName: 'Nombre y apellidos',
    idNumber: 'CI / Pasaporte',
    license: 'Licencia de conducción (Nr. / Categoría)',
    address: 'Domicilio',
    phone: 'Teléfono',
    email: 'Correo electrónico',
  },
  bodyBlocks: [
    { type: 'h1', text: 'III.  OBJETO DEL CONTRATO' },
    {
      type: 'p',
      text:
        'El presente contrato tiene por objeto regular el acceso y uso por parte de EL CONDUCTOR de la plataforma digital Trici-Go, de titularidad de LA PLATAFORMA, mediante la concesión de una licencia de uso personal, intransferible y no exclusiva, conforme a las condiciones establecidas en el presente instrumento.',
    },
    { type: 'h1', text: 'IV.  DESCRIPCIÓN DE LA PLATAFORMA' },
    {
      type: 'p',
      text:
        'Trici-Go es una plataforma digital de intermediación de movilidad urbana operada en La Habana, República de Cuba, compuesta por: (i) una aplicación móvil para conductores disponible en iOS y Android; (ii) una aplicación móvil para usuarios/pasajeros disponible en iOS y Android; (iii) un panel de administración web (backoffice); y (iv) infraestructura backend con API, base de datos, tecnología de comunicación en tiempo real, geolocalización, cálculo de rutas y notificaciones push.',
    },
    {
      type: 'p',
      text:
        'La plataforma facilita el encuentro tecnológico entre conductores y pasajeros, incorporando un módulo de monetización basado en saldo de acceso, cuotas y/o suscripción, así como funcionalidades de seguridad, chat en tiempo real, registro de viajes y gestión operativa. LA PLATAFORMA no interviene en la ejecución material del transporte ni ostenta la condición de operador de transporte.',
    },
    { type: 'h1', text: 'V.  LICENCIA DE USO Y CONDICIONES DE ACCESO' },
    { type: 'h2', text: 'Artículo 5.1 — Concesión de Licencia' },
    {
      type: 'p',
      text:
        'LA PLATAFORMA concede a EL CONDUCTOR, en los términos del presente contrato, una licencia de uso personal, revocable, intransferible y no exclusiva para acceder y utilizar la aplicación Trici-Go en su versión para conductores, únicamente a los efectos previstos en el presente instrumento.',
    },
    { type: 'h2', text: 'Artículo 5.2 — Mecanismo de Acceso y Tarifas' },
    {
      type: 'p',
      text:
        'El acceso a las solicitudes de viaje disponibles en la plataforma está condicionado a que EL CONDUCTOR mantenga activo un saldo o crédito en su cuenta de la aplicación. Las tarifas de acceso, estructura de comisiones y condiciones económicas aplicables se rigen por los Términos y Condiciones de uso de la aplicación Trici-Go, que forman parte integrante del presente contrato en calidad de Anexo A y se encuentran publicados y actualizados en la propia aplicación. Dicho saldo constituye la contraprestación por el uso de la plataforma y no representa en ningún caso participación en los ingresos del servicio de transporte.',
    },
    { type: 'h2', text: 'Artículo 5.3 — Propiedad Intelectual' },
    {
      type: 'p',
      text:
        'La plataforma, su código fuente, diseño, marcas, denominaciones, logotipos y demás elementos que la integran son propiedad exclusiva de MACH DIGITAL TECH S.R.L. La licencia concedida no implica cesión, transferencia ni renuncia a ningún derecho de propiedad intelectual o industrial sobre la plataforma.',
    },
    { type: 'h1', text: 'VI.  NATURALEZA JURÍDICA DE LA RELACIÓN' },
    {
      type: 'p',
      text:
        'Las Partes reconocen y acuerdan expresamente que el presente contrato tiene naturaleza mercantil y regula exclusivamente una relación de licencia de uso de plataforma digital. EL CONDUCTOR actúa en calidad de persona física autónoma, sin que exista entre las Partes vínculo laboral, de subordinación, dependencia, mandato ni representación alguna, conforme a lo previsto en el Decreto-Ley n.º 14/2021 de Cuba sobre el trabajo por cuenta propia y demás normativa aplicable.',
    },
    {
      type: 'p',
      text:
        'EL CONDUCTOR presta el servicio de transporte directamente al pasajero, por su propia cuenta y riesgo, percibiendo íntegramente la tarifa pactada con este. LA PLATAFORMA no percibe contraprestación alguna derivada del transporte efectuado, siendo sus ingresos de naturaleza exclusivamente tecnológica y de intermediación digital, conforme al modelo operativo registrado ante las autoridades competentes de Rumanía.',
    },
    { type: 'h1', text: 'VII.  OBLIGACIONES DEL CONDUCTOR' },
    { type: 'p', text: 'EL CONDUCTOR se obliga a:' },
    { type: 'bullet', text: 'Mantener vigentes su licencia de conducción y la documentación del vehículo exigida por la normativa cubana aplicable.' },
    { type: 'bullet', text: 'Cumplir la normativa de tránsito, transporte de pasajeros y ejercicio del trabajo por cuenta propia vigente en la República de Cuba.' },
    { type: 'bullet', text: 'No ceder, compartir ni transferir a terceros el acceso a su cuenta en la aplicación.' },
    { type: 'bullet', text: 'Comunicar a LA PLATAFORMA, en un plazo de cinco (5) días hábiles, cualquier modificación en sus datos de identificación.' },
    { type: 'bullet', text: 'Mantener el vehículo en las condiciones de seguridad e higiene requeridas para la prestación del servicio.' },
    { type: 'bullet', text: 'Abstenerse de utilizar la plataforma para fines distintos de su objeto ni de manera contraria al presente contrato o a la normativa vigente.' },
    { type: 'h1', text: 'VIII.  OBLIGACIONES DE LA PLATAFORMA' },
    { type: 'p', text: 'LA PLATAFORMA se obliga a:' },
    { type: 'bullet', text: 'Mantener la plataforma operativa en condiciones razonables de disponibilidad y funcionamiento.' },
    { type: 'bullet', text: 'Notificar con un mínimo de siete (7) días de anticipación cualquier modificación en las tarifas de acceso o en los Términos y Condiciones (Anexo A), a través de la aplicación o por correo electrónico. Transcurrido dicho plazo sin que EL CONDUCTOR haya notificado su rechazo por escrito, las modificaciones se entenderán aceptadas tácitamente. En caso de rechazo expreso, EL CONDUCTOR podrá resolver el contrato sin penalización en el plazo de siete (7) días desde su notificación.' },
    { type: 'bullet', text: 'Tratar los datos personales de EL CONDUCTOR de conformidad con la normativa aplicable en materia de protección de datos.' },
    { type: 'bullet', text: 'Brindar soporte técnico básico ante incidencias de la plataforma dentro de un plazo razonable.' },
    { type: 'h1', text: 'IX.  LIMITACIÓN DE RESPONSABILIDAD' },
    {
      type: 'p',
      text:
        'LA PLATAFORMA actúa exclusivamente como intermediario tecnológico y no asume responsabilidad alguna por accidentes de tránsito, daños a terceros, reclamaciones de pasajeros, obligaciones tributarias del conductor, ni por cualquier incumplimiento normativo derivado de la actividad de transporte. EL CONDUCTOR responde en exclusiva frente a pasajeros, autoridades y terceros por los actos realizados en el ejercicio de su actividad.',
    },
    {
      type: 'p',
      text:
        'La responsabilidad total de LA PLATAFORMA derivada del presente contrato se limitará, en cualquier caso, al importe efectivamente abonado por EL CONDUCTOR en concepto de acceso a la plataforma durante los tres (3) meses anteriores al evento generador, salvo dolo o culpa grave imputable a LA PLATAFORMA.',
    },
    { type: 'h1', text: 'X.  PROTECCIÓN DE DATOS PERSONALES' },
    {
      type: 'p',
      text:
        'Los datos personales de EL CONDUCTOR (nombre, documento de identidad, licencia de conducción, domicilio, teléfono y correo electrónico) serán tratados por MACH DIGITAL TECH S.R.L. con la finalidad de gestionar la relación contractual, el acceso a la plataforma y el cumplimiento de obligaciones legales, conforme al Reglamento (UE) 2016/679 (RGPD) y la legislación rumana de protección de datos. EL CONDUCTOR consiente expresamente dicho tratamiento mediante la firma del presente contrato.',
    },
    { type: 'h1', text: 'XI.  VIGENCIA Y TERMINACIÓN' },
    { type: 'h2', text: 'Artículo 11.1 — Vigencia' },
    {
      type: 'p',
      text:
        'El presente contrato entrará en vigor en la fecha de su suscripción y tendrá duración indefinida, pudiendo ser resuelto por cualquiera de las Partes mediante notificación escrita con un preaviso mínimo de siete (7) días.',
    },
    { type: 'h2', text: 'Artículo 11.2 — Resolución Anticipada' },
    {
      type: 'p',
      text:
        'LA PLATAFORMA podrá resolver el presente contrato de forma inmediata y proceder a la suspensión o baja definitiva de la cuenta de EL CONDUCTOR en los siguientes supuestos: (a) incumplimiento grave o reiterado de las obligaciones contractuales; (b) falsedad en los datos de registro; (c) uso de la plataforma para fines ilícitos o contrarios al orden público; (d) retirada, suspensión o invalidez de la licencia de conducción; (e) conductas que atenten contra la seguridad o integridad de pasajeros.',
    },
    { type: 'h1', text: 'XII.  CONFIDENCIALIDAD' },
    {
      type: 'p',
      text:
        'Las Partes se obligan a mantener en estricta confidencialidad toda la información técnica, comercial, operativa y estratégica intercambiada en el marco del presente contrato durante su vigencia y por un período de tres (3) años posteriores a su terminación, salvo que dicha información sea de dominio público, deba ser divulgada por imperativo legal o cuente con autorización escrita de la parte titular.',
    },
    { type: 'h1', text: 'XIII.  LEY APLICABLE Y JURISDICCIÓN' },
    {
      type: 'p',
      text:
        'El presente contrato se rige, en lo relativo a la actividad del conductor y al servicio de transporte prestado en territorio cubano, por la legislación de la República de Cuba, en particular el Decreto-Ley n.º 14/2021 sobre el trabajo por cuenta propia, el Código Civil y demás normativa de transporte vigente. En lo relativo a la titularidad, operación y estructura jurídica de LA PLATAFORMA, resulta aplicable la legislación de Rumanía, en particular la Ley n.º 31/1990 sobre sociedades.',
    },
    {
      type: 'p',
      text:
        'Las Partes se comprometen a resolver cualquier controversia derivada del presente contrato de forma amistosa en primera instancia. En caso de no alcanzarse acuerdo en un plazo de quince (15) días hábiles desde la notificación escrita de la controversia, las Partes se someten a la jurisdicción de los tribunales competentes de La Habana, República de Cuba.',
    },
    { type: 'h1', text: 'XIV.  NOTIFICACIONES' },
    {
      type: 'p',
      text:
        'Las notificaciones previstas en el presente contrato deberán realizarse por escrito mediante correo electrónico u otro medio verificable acordado por las Partes. A los efectos del presente contrato: LA PLATAFORMA: machdigitaltechsrl@gmail.com. EL CONDUCTOR: el correo electrónico y/o número de teléfono indicados en la Sección II del presente instrumento.',
    },
    { type: 'h1', text: 'XV.  DISPOSICIONES FINALES' },
    {
      type: 'p',
      text:
        'El presente contrato, junto con sus eventuales anexos, constituye el acuerdo íntegro entre las Partes respecto a su objeto y deja sin efecto cualquier acuerdo, comunicación o negociación previa sobre la misma materia. Si alguna disposición del presente contrato fuera declarada nula o ineficaz, las restantes cláusulas conservarán plena validez. El presente contrato podrá suscribirse en versión española y en traducción rumana; en caso de discrepancia, prevalecerá la versión en español.',
    },
    { type: 'h1', text: 'XVI.  ANEXOS' },
    {
      type: 'p',
      text:
        'Forman parte integrante del presente contrato los siguientes anexos, cuyo contenido EL CONDUCTOR declara conocer y aceptar expresamente mediante la firma del presente instrumento:',
    },
    {
      type: 'bullet',
      text:
        'Anexo A — Términos y Condiciones de uso de la plataforma Trici-Go, incluyendo tarifas de acceso, estructura de comisiones, normas de conducta del conductor y política de suspensión de cuentas, en la versión vigente publicada en la aplicación a la fecha de firma del presente contrato.',
    },
  ],
  declarationTitle: 'DECLARACIÓN DEL CONDUCTOR',
  declarationLead: 'EL CONDUCTOR declara, bajo su personal responsabilidad:',
  declarationItems: [
    'Que ha leído íntegramente el presente contrato y comprende su contenido y alcance.',
    'Que los datos de identificación aportados en la Sección II son verídicos, completos y actualizados, asumiendo plena responsabilidad por cualquier inexactitud o falsedad en los mismos, sin perjuicio de las consecuencias legales que pudieran derivarse conforme a la normativa cubana aplicable.',
    'Que conoce y acepta los Términos y Condiciones de uso de la plataforma Trici-Go (Anexo A) vigentes a la fecha de firma.',
    'Que actúa en calidad de persona física autónoma, con plena capacidad jurídica para suscribir el presente contrato, sin que exista impedimento legal alguno para ello.',
  ],
  signaturesTitle: 'FIRMAS',
  platformLabel: 'LA PLATAFORMA',
  platformName: 'MACH DIGITAL TECH S.R.L.',
  platformRep: 'Maria Loraime Gonzalez Carvajal Hernandez',
  platformRepRole: 'Administrator · CUI 54552055',
  conductorLabel: 'EL CONDUCTOR',
  acceptedElectronicallyTpl: 'Aceptado electrónicamente el {date}',
  contractRefTpl: 'Contrato N.º {no}',
  annexTitle: 'ANEXO A — TÉRMINOS Y CONDICIONES DE USO',
  annexLead: 'Texto vigente de los Términos y Condiciones publicado en la aplicación a la fecha de firma:',
  notProvided: 'No informado',
  footerLine:
    'TRICI-GO  ·  MACH DIGITAL TECH S.R.L.  ·  CUI 54552055  ·  J2026027319006  ·  Str. Lungă 149, Ap. P3, Brașov, România  ·  marialoraimeg@gmail.com',
};

export const CONTRACT_RO: ContractCopy = {
  brandTagline: 'Platformă Digitală de Mobilitate Urbană',
  docTitle: 'CONTRACT DE LICENȚĂ DE UTILIZARE A PLATFORMEI DIGITALE',
  docSubtitle: 'Conductor — Persoană Fizică',
  contractNoLabel: 'Nr. Contract',
  signDateLabel: 'Data semnării',
  signPlace: 'Havana, Cuba',
  partiesTitle: 'I.  PĂRȚILE CONTRACTULUI',
  partiesBlocks: [
    {
      type: 'p',
      text:
        'Pe de o parte, MACH DIGITAL TECH S.R.L., societate cu răspundere limitată constituită în conformitate cu Legea nr. 31/1990 privind societățile din România, cu sediul social în Str. Lungă nr. 149, Ap. P3, Municipiul Brașov, Jud. Brașov, România, înregistrată în Registrul Comerțului sub numărul J2026027319006, cu cod unic de înregistrare fiscală CUI 54552055, reprezentată legal de Maria Loraime Gonzalez Carvajal Hernandez în calitate de Administrator, titulară a platformei digitale Trici-Go, denumită în continuare «PLATFORMA».',
    },
    {
      type: 'p',
      text:
        'Pe de altă parte, persoana fizică identificată în Secțiunea II a prezentului contract, titulară a unui act de identitate sau document echivalent, înregistrată corespunzător ca utilizator șofer în aplicația Trici-Go, denumită în continuare «ȘOFERUL».',
    },
  ],
  identTitle: 'II.  IDENTIFICAREA ȘOFERULUI',
  identLabels: {
    fullName: 'Nume și prenume',
    idNumber: 'Buletin / Pașaport — Nr.',
    license: 'Permis de conducere (Nr. / Categoría)',
    address: 'Adresă domiciliu',
    phone: 'Număr de telefon',
    email: 'Adresă e-mail',
  },
  bodyBlocks: [
    { type: 'h1', text: 'III.  OBIECTUL CONTRACTULUI' },
    {
      type: 'p',
      text:
        'Prezentul contract are ca obiect reglementarea accesului și utilizării de către ȘOFER a platformei digitale Trici-Go, aflată în proprietatea PLATFORMEI, prin acordarea unei licențe de utilizare personale, netransferabile și neexclusive, în conformitate cu condițiile stabilite în prezentul instrument.',
    },
    { type: 'h1', text: 'IV.  DESCRIEREA PLATFORMEI' },
    {
      type: 'p',
      text:
        'Trici-Go este o platformă digitală de intermediere a mobilității urbane, operată în Havana, Republica Cuba, compusă din: (i) o aplicație mobilă pentru șoferi disponibilă pe iOS și Android; (ii) o aplicație mobilă pentru utilizatori/pasageri disponibilă pe iOS și Android; (iii) un panou de administrare web (backoffice); și (iv) infrastructură backend cu API, baze de date, tehnologie de comunicare în timp real, geolocalizare, calculul rutelor și notificări push.',
    },
    {
      type: 'p',
      text:
        'Platforma facilitează întâlnirea tehnologică dintre șoferi și pasageri, incorporând un modul de monetizare bazat pe sold de acces, cote și/sau abonament, precum și funcționalități de securitate, chat în timp real, înregistrarea curselor și gestiune operativă. PLATFORMA nu intervine în executarea materială a transportului și nu deține calitatea de operator de transport.',
    },
    { type: 'h1', text: 'V.  LICENȚĂ DE UTILIZARE ȘI CONDIȚII DE ACCES' },
    { type: 'h2', text: 'Art. 5.1 — Acordarea Licenței' },
    {
      type: 'p',
      text:
        'PLATFORMA acordă ȘOFERULUI, în condițiile prezentului contract, o licență de utilizare personală, revocabilă, netransferabilă și neexclusivă pentru a accesa și utiliza aplicația Trici-Go în versiunea sa pentru șoferi, exclusiv în scopurile prevăzute în prezentul instrument.',
    },
    { type: 'h2', text: 'Art. 5.2 — Mecanismul de Acces și Tarife' },
    {
      type: 'p',
      text:
        'Accesul la solicitările de cursă disponibile pe platformă este condiționat de menținerea de către ȘOFER a unui sold sau credit activ în contul aplicației. Tarifele de acces, structura comisioanelor și condițiile economice aplicabile sunt reglementate de Termenii și Condițiile de utilizare a aplicației Trici-Go, care fac parte integrantă din prezentul contract în calitate de Anexă A și sunt publicate și actualizate în aplicație. Soldul respectiv constituie contrapartida pentru utilizarea platformei și nu reprezintă în niciun caz participare la veniturile serviciului de transport.',
    },
    { type: 'h2', text: 'Art. 5.3 — Proprietate Intelectuală' },
    {
      type: 'p',
      text:
        'Platforma, codul sursă, designul, mărcile, denumirile, logotipurile și celelalte elemente componente sunt proprietatea exclusivă a MACH DIGITAL TECH S.R.L. Licența acordată nu implică cedarea, transferul sau renunțarea la niciun drept de proprietate intelectuală sau industrială asupra platformei.',
    },
    { type: 'h1', text: 'VI.  NATURA JURIDICĂ A RELAȚIEI' },
    {
      type: 'p',
      text:
        'Părțile recunosc și convin expres că prezentul contract are natură comercială și reglementează exclusiv o relație de licență de utilizare a platformei digitale. ȘOFERUL acționează în calitate de persoană fizică autonomă, fără a exista între Părți niciun raport de muncă, de subordonare, dependență, mandat sau reprezentare, în conformitate cu prevederile Decretului-Lege nr. 14/2021 din Cuba privind munca pe cont propriu și alte reglementări aplicabile.',
    },
    {
      type: 'p',
      text:
        'ȘOFERUL prestează serviciul de transport direct pasagerului, pe cont propriu și pe propriul risc, percepând integral tariful convenit cu acesta. PLATFORMA nu percepe nicio contrapartidă derivată din transportul efectuat, veniturile sale fiind de natură exclusiv tehnologică și de intermediere digitală, conform modelului operativ înregistrat la autoritățile competente din România.',
    },
    { type: 'h1', text: 'VII.  OBLIGAȚIILE ȘOFERULUI' },
    { type: 'p', text: 'ȘOFERUL se obligă să:' },
    { type: 'bullet', text: 'Mențină valabile permisul de conducere și documentele vehiculului cerute de reglementările cubaneze aplicabile.' },
    { type: 'bullet', text: 'Respecte normele de circulație, transport de pasageri și exercitarea muncii pe cont propriu în vigoare în Republica Cuba.' },
    { type: 'bullet', text: 'Nu cedeze, nu partajeze și nu transfere terților accesul la contul său în aplicație.' },
    { type: 'bullet', text: 'Comunice PLATFORMEI, în termen de cinci (5) zile lucrătoare, orice modificare a datelor sale de identificare.' },
    { type: 'bullet', text: 'Mențină vehiculul în condițiile de siguranță și igienă necesare prestării serviciului.' },
    { type: 'bullet', text: 'Se abțină să utilizeze platforma în scopuri diferite de obiectul său ori contrar prezentului contract sau reglementărilor în vigoare.' },
    { type: 'h1', text: 'VIII.  OBLIGAȚIILE PLATFORMEI' },
    { type: 'p', text: 'PLATFORMA se obligă să:' },
    { type: 'bullet', text: 'Mențină platforma operațională în condiții rezonabile de disponibilitate și funcționare.' },
    { type: 'bullet', text: 'Notifice cu minimum șapte (7) zile înainte orice modificare a tarifelor de acces sau a Termenilor și Condițiilor (Anexa A), prin intermediul aplicației sau prin e-mail. La expirarea acestui termen fără ca ȘOFERUL să fi notificat în scris respingerea, modificările vor fi considerate acceptate tacit. În caz de respingere expresă, ȘOFERUL poate rezilia contractul fără penalitate în termen de șapte (7) zile de la notificare.' },
    { type: 'bullet', text: 'Prelucreze datele personale ale ȘOFERULUI în conformitate cu reglementările aplicabile în materia protecției datelor.' },
    { type: 'bullet', text: 'Ofere suport tehnic de bază în caz de incidente ale platformei într-un termen rezonabil.' },
    { type: 'h1', text: 'IX.  LIMITAREA RĂSPUNDERII' },
    {
      type: 'p',
      text:
        'PLATFORMA acționează exclusiv ca intermediar tehnologic și nu își asumă nicio răspundere pentru accidentele de circulație, daunele cauzate terților, reclamațiile pasagerilor, obligațiile fiscale ale șoferului, nici pentru niciun nerespectare normativă derivată din activitatea de transport. ȘOFERUL răspunde în mod exclusiv față de pasageri, autorități și terți pentru actele săvârșite în exercitarea activității sale.',
    },
    {
      type: 'p',
      text:
        'Răspunderea totală a PLATFORMEI derivată din prezentul contract va fi limitată, în orice caz, la suma efectiv plătită de ȘOFER cu titlu de acces la platformă în cursul celor trei (3) luni anterioare evenimentului generator, cu excepția dolului sau culpei grave imputabile PLATFORMEI.',
    },
    { type: 'h1', text: 'X.  PROTECȚIA DATELOR CU CARACTER PERSONAL' },
    {
      type: 'p',
      text:
        'Datele cu caracter personal ale ȘOFERULUI (nume, document de identitate, permis de conducere, domiciliu, telefon și e-mail) vor fi prelucrate de MACH DIGITAL TECH S.R.L. în scopul gestionării relației contractuale, accesului la platformă și îndeplinirii obligațiilor legale, în conformitate cu Regulamentul (UE) 2016/679 (RGPD) și legislația română în materia protecției datelor. ȘOFERUL consimte expres această prelucrare prin semnarea prezentului contract.',
    },
    { type: 'h1', text: 'XI.  DURATĂ ȘI REZILIERE' },
    { type: 'h2', text: 'Art. 11.1 — Durată' },
    {
      type: 'p',
      text:
        'Prezentul contract intră în vigoare la data semnării și are durată nedeterminată, putând fi reziliat de oricare dintre Părți prin notificare scrisă cu un preaviz minim de șapte (7) zile.',
    },
    { type: 'h2', text: 'Art. 11.2 — Reziliere Anticipată' },
    {
      type: 'p',
      text:
        'PLATFORMA poate rezilia prezentul contract imediat și poate proceda la suspendarea sau dezactivarea definitivă a contului ȘOFERULUI în următoarele cazuri: (a) nerespectare gravă sau repetată a obligațiilor contractuale; (b) falsitate în datele de înregistrare; (c) utilizarea platformei în scopuri ilicite sau contrare ordinii publice; (d) retragerea, suspendarea sau invalidarea permisului de conducere; (e) comportamente care periclitează siguranța sau integritatea pasagerilor.',
    },
    { type: 'h1', text: 'XII.  CONFIDENȚIALITATE' },
    {
      type: 'p',
      text:
        'Părțile se obligă să mențină în strictă confidențialitate toate informațiile tehnice, comerciale, operaționale și strategice schimbate în cadrul prezentului contract pe toată durata sa și pentru o perioadă de trei (3) ani de la încetarea acestuia, cu excepția cazului în care informațiile respective sunt de domeniu public, trebuie divulgate din obligație legală sau sunt autorizate în scris de partea titulară.',
    },
    { type: 'h1', text: 'XIII.  LEGEA APLICABILĂ ȘI JURISDICȚIE' },
    {
      type: 'p',
      text:
        'Prezentul contract este reglementat, în ceea ce privește activitatea șoferului și serviciul de transport prestat pe teritoriul cubanez, de legislația Republicii Cuba, în special Decretul-Lege nr. 14/2021 privind munca pe cont propriu, Codul Civil și alte norme de transport în vigoare. În ceea ce privește titularitatea, operarea și structura juridică a PLATFORMEI, se aplică legislația României, în special Legea nr. 31/1990 privind societățile.',
    },
    {
      type: 'p',
      text:
        'Părțile se angajează să soluționeze orice litigiu derivat din prezentul contract pe cale amiabilă în primă instanță. În cazul în care nu se ajunge la un acord în termen de cincisprezece (15) zile lucrătoare de la notificarea scrisă a litigiului, Părțile se supun jurisdicției instanțelor competente din Havana, Republica Cuba.',
    },
    { type: 'h1', text: 'XIV.  NOTIFICĂRI' },
    {
      type: 'p',
      text:
        'Notificările prevăzute în prezentul contract trebuie efectuate în scris prin e-mail sau alt mijloc verificabil convenit de Părți. În sensul prezentului contract: PLATFORMA: marialoraimeg@gmail.com. ȘOFERUL: adresa de e-mail și/sau numărul de telefon indicate în Secțiunea II a prezentului instrument.',
    },
    { type: 'h1', text: 'XV.  DISPOZIȚII FINALE' },
    {
      type: 'p',
      text:
        'Prezentul contract, împreună cu eventualele sale anexe, constituie acordul integral dintre Părți cu privire la obiectul său și desființează orice acord, comunicare sau negociere anterioară privind același obiect. Dacă vreo dispoziție a prezentului contract ar fi declarată nulă sau ineficientă, celelalte clauze își vor păstra deplina valabilitate. Prezentul contract poate fi semnat în versiune spaniolă și în traducere română; în caz de divergență, va prevala versiunea în spaniolă.',
    },
    { type: 'h1', text: 'XVI.  ANEXE' },
    {
      type: 'p',
      text:
        'Fac parte integrantă din prezentul contract următoarele anexe, al căror conținut ȘOFERUL declară că îl cunoaște și îl acceptă expres prin semnarea prezentului instrument:',
    },
    {
      type: 'bullet',
      text:
        'Anexa A — Termenii și Condițiile de utilizare a platformei Trici-Go, inclusiv tarifele de acces, structura comisioanelor, normele de conduită ale șoferului și politica de suspendare a conturilor, în versiunea în vigoare publicată în aplicație la data semnării prezentului contract.',
    },
  ],
  declarationTitle: 'DECLARAȚIA ȘOFERULUI',
  declarationLead: 'ȘOFERUL declară, sub propria răspundere personală:',
  declarationItems: [
    'Că a citit integral prezentul contract și înțelege conținutul și domeniul de aplicare al acestuia.',
    'Că datele de identificare furnizate în Secțiunea II sunt autentice, complete și actualizate, asumându-și deplina răspundere pentru orice inexactitate sau falsitate a acestora, fără a aduce atingere consecințelor legale care ar putea decurge conform reglementărilor cubaneze aplicabile.',
    'Că cunoaște și acceptă Termenii și Condițiile de utilizare a platformei Trici-Go (Anexa A) în vigoare la data semnării.',
    'Că acționează în calitate de persoană fizică autonomă, cu deplină capacitate juridică pentru a semna prezentul contract, fără niciun impediment legal în acest sens.',
  ],
  signaturesTitle: 'SEMNĂTURI',
  platformLabel: 'PLATFORMA',
  platformName: 'MACH DIGITAL TECH S.R.L.',
  platformRep: 'Maria Loraime Gonzalez Carvajal Hernandez',
  platformRepRole: 'Administrator · CUI 54552055',
  conductorLabel: 'ȘOFERUL',
  acceptedElectronicallyTpl: 'Acceptat electronic la {date}',
  contractRefTpl: 'Contract Nr. {no}',
  annexTitle: 'ANEXA A — TERMENI ȘI CONDIȚII DE UTILIZARE',
  annexLead: 'Textul în vigoare al Termenilor și Condițiilor publicat în aplicație la data semnării:',
  notProvided: 'Nedeclarat',
  footerLine:
    'TRICI-GO  ·  MACH DIGITAL TECH S.R.L.  ·  CUI 54552055  ·  J2026027319006  ·  Str. Lungă 149, Ap. P3, Brașov, România  ·  marialoraimeg@gmail.com',
};
