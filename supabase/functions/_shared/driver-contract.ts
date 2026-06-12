// ============================================================
// TriciGo — driver T&C-acceptance contract copy (ES + RO).
//
// Used by generate-driver-contract to render the two PDF variants:
//   - Spanish:  sent to the driver + administration. The T&C annex
//     body comes from cms_content('terms').body_es AT RUNTIME so the
//     PDF captures exactly the version the driver accepted.
//   - Romanian: sent to administration only (the operating company
//     MACH DIGITAL TECH S.R.L. is Romanian). The annex body is the
//     static translation below, based on the live body_es as of
//     2026-05-30 (cms_content.updated_at). It carries a prevalence
//     note: the Spanish version governs.
//
// ⚠️ KEEP IN SYNC: if cms_content('terms').body_es changes through
// the admin /content editor, update TERMS_RO_BODY (and
// TERMS_RO_BASED_ON) here in the next deploy. The generated PDF
// stamps the live ES version date so drift is detectable.
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

// ── Contract cover copy, per language ────────────────────────────
// Placeholders are filled by the PDF builder; keeping the prose here
// (instead of inline in index.ts) makes legal review of the wording a
// single-file diff.

export interface ContractCopy {
  /** PDF metadata + page header */
  docTitle: string;
  docSubtitle: string;
  /** Intro paragraph naming the parties. */
  parties: string;
  driverSectionTitle: string;
  vehicleSectionTitle: string;
  declarationTitle: string;
  /** Paragraphs; {termsDate} {acceptedAt} {contractNo} get replaced. */
  declarationParagraphs: string[];
  annexTitle: string;
  /** Extra note shown only on the RO variant (translation prevalence). */
  translationNote?: string;
  footerLine: string;
  labels: {
    fullName: string;
    identityNumber: string;
    phone: string;
    email: string;
    address: string;
    provinceMunicipality: string;
    vehicleType: string;
    makeModel: string;
    year: string;
    color: string;
    plate: string;
    capacity: string;
    contractNo: string;
    acceptedAt: string;
    termsVersion: string;
    notProvided: string;
  };
  vehicleTypes: Record<string, string>;
}

export const CONTRACT_ES: ContractCopy = {
  docTitle: 'CONTRATO DE ACEPTACIÓN DE TÉRMINOS Y CONDICIONES',
  docSubtitle: 'Conductor independiente · Plataforma TriciGo',
  parties:
    'Entre MACH DIGITAL TECH S.R.L., sociedad que opera la plataforma tecnológica TriciGo ' +
    '(en adelante, «la Plataforma»), y el conductor independiente identificado a continuación ' +
    '(en adelante, «el Conductor»), se deja constancia de la aceptación de los Términos y ' +
    'Condiciones de Servicio de la Plataforma en los datos y condiciones siguientes:',
  driverSectionTitle: 'Datos del Conductor',
  vehicleSectionTitle: 'Datos del vehículo',
  declarationTitle: 'Declaración de aceptación',
  declarationParagraphs: [
    'El Conductor declara que ha leído y acepta íntegramente los Términos y Condiciones de ' +
      'Servicio de TriciGo (versión del {termsDate}), cuyo texto completo se adjunta como ' +
      'Anexo I y forma parte integrante del presente documento.',
    'La aceptación quedó registrada electrónicamente al completar el registro como conductor ' +
      'en la aplicación TriciGo el {acceptedAt}, bajo el número de contrato {contractNo}.',
    'El Conductor actúa como prestador de servicios independiente. Este documento no crea ' +
      'relación laboral alguna entre el Conductor y MACH DIGITAL TECH S.R.L.; la Plataforma ' +
      'actúa exclusivamente como intermediario tecnológico entre pasajeros y conductores.',
  ],
  annexTitle: 'ANEXO I — TÉRMINOS Y CONDICIONES DE SERVICIO',
  footerLine:
    'Documento generado electrónicamente por la plataforma TriciGo. No requiere firma ' +
    'manuscrita: la aceptación quedó registrada electrónicamente.',
  labels: {
    fullName: 'Nombre completo',
    identityNumber: 'Carné de identidad',
    phone: 'Teléfono',
    email: 'Email',
    address: 'Dirección',
    provinceMunicipality: 'Provincia / Municipio',
    vehicleType: 'Tipo de vehículo',
    makeModel: 'Marca y modelo',
    year: 'Año',
    color: 'Color',
    plate: 'Chapa',
    capacity: 'Capacidad (pasajeros)',
    contractNo: 'Nº de contrato',
    acceptedAt: 'Fecha de aceptación',
    termsVersion: 'Versión de los términos',
    notProvided: 'No informado',
  },
  vehicleTypes: {
    triciclo: 'Triciclo',
    moto: 'Moto',
    auto: 'Auto',
    cargo: 'Carga',
  },
};

export const CONTRACT_RO: ContractCopy = {
  docTitle: 'CONTRACT DE ACCEPTARE A TERMENILOR ȘI CONDIȚIILOR',
  docSubtitle: 'Șofer independent · Platforma TriciGo',
  parties:
    'Între MACH DIGITAL TECH S.R.L., societatea care operează platforma tehnologică TriciGo ' +
    '(denumită în continuare «Platforma»), și șoferul independent identificat mai jos ' +
    '(denumit în continuare «Șoferul»), se consemnează acceptarea Termenilor și Condițiilor ' +
    'de Utilizare ale Platformei, conform datelor și condițiilor de mai jos:',
  driverSectionTitle: 'Datele Șoferului',
  vehicleSectionTitle: 'Datele vehiculului',
  declarationTitle: 'Declarație de acceptare',
  declarationParagraphs: [
    'Șoferul declară că a citit și acceptă integral Termenii și Condițiile de Utilizare ' +
      'TriciGo (versiunea din {termsDate}), al căror text complet este atașat ca Anexa I și ' +
      'face parte integrantă din prezentul document.',
    'Acceptarea a fost înregistrată electronic la finalizarea înregistrării ca șofer în ' +
      'aplicația TriciGo, la data de {acceptedAt}, sub numărul de contract {contractNo}.',
    'Șoferul acționează ca prestator de servicii independent. Prezentul document nu creează ' +
      'niciun raport de muncă între Șofer și MACH DIGITAL TECH S.R.L.; Platforma acționează ' +
      'exclusiv ca intermediar tehnologic între pasageri și șoferi.',
  ],
  annexTitle: 'ANEXA I — TERMENI ȘI CONDIȚII DE UTILIZARE',
  translationNote:
    'Prezentul document este o traducere în limba română a contractului și a Termenilor și ' +
    'Condițiilor acceptate în limba spaniolă. În caz de divergență, versiunea în limba ' +
    'spaniolă prevalează.',
  footerLine:
    'Document generat electronic de platforma TriciGo. Nu necesită semnătură olografă: ' +
    'acceptarea a fost înregistrată electronic.',
  labels: {
    fullName: 'Nume complet',
    identityNumber: 'Carte de identitate',
    phone: 'Telefon',
    email: 'Email',
    address: 'Adresă',
    provinceMunicipality: 'Provincie / Municipiu',
    vehicleType: 'Tip vehicul',
    makeModel: 'Marcă și model',
    year: 'An',
    color: 'Culoare',
    plate: 'Număr de înmatriculare',
    capacity: 'Capacitate (pasageri)',
    contractNo: 'Nr. contract',
    acceptedAt: 'Data acceptării',
    termsVersion: 'Versiunea termenilor',
    notProvided: 'Nedeclarat',
  },
  vehicleTypes: {
    triciclo: 'Tricicletă',
    moto: 'Motocicletă',
    auto: 'Automobil',
    cargo: 'Marfă',
  },
};
