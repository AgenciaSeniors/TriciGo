-- ============================================================
-- Migration 00652: weekly check for voseo in the copy users see, outside git
--
-- TriciGo copy is tuteo (tú), never voseo. CI already checks the copy that lives
-- in git (packages/utils/src/__tests__/copyTuteo.test.ts: the apps, i18n, e-mail
-- templates and, since #1119, SQL migrations from 00639 on). It cannot see the
-- copy that admins edit in prod: on 2026-10-08 the published privacy policy
-- (cms_content 'privacy') said "ingresás" and "usás", and two unpublished blog
-- posts had voseo too. They were fixed by hand; nothing would have caught the
-- next one.
--
-- What this adds:
--   public.voseo_forms()          the voseo forms to look for: the 1,911 forms that
--                                 copyTuteo.test.ts generates from its verb lists.
--                                 The same test fails if this list and its own
--                                 differ, so both copies move together. When a verb
--                                 is added there, a new migration redefines this
--                                 function with the list the test prints.
--   public.voseo_hits(text)       the voseo forms in a text (lowercase, sorted). The
--                                 text is normalized to NFC and read with the
--                                 database's own collation ("default", en_US.UTF-8
--                                 in prod): with collation C, [[:alpha:]] does not
--                                 match accented letters and no accented form would
--                                 ever be found (this hid the privacy policy from
--                                 two earlier scans). "sos" counts only as the verb:
--                                 followed by a lowercase word ("si sos conductor"),
--                                 not the SOS button.
--   public.copy_voseo_findings()  one row per place that has voseo, with its forms.
--                                 It reads the copy edited from the admin (CMS pages,
--                                 blog, home announcements, promotions, driver
--                                 quests, review tags, trip insurance, service names,
--                                 platform_config values, campaigns not sent or sent
--                                 in the last 8 days) and what users received in the
--                                 last 8 days (push bodies by category, SMS by event
--                                 type), which also shows voseo coming from a
--                                 function. Text-free labels only: no user, phone or
--                                 message content goes into the result.
--   public.check_copy_voseo()     run weekly by pg_cron (check-copy-voseo, Mondays
--                                 13:00 UTC = 9:00 in Havana). Stores
--                                 copy_voseo_status / _signature / _at / _detail in
--                                 platform_config and e-mails every address in
--                                 business_notification_email when the list of
--                                 findings changes (new voseo, or a different set),
--                                 and once when it goes back to empty. The same list
--                                 is not e-mailed twice. The e-mail goes through
--                                 cron_http_post (label copy-voseo-alert), so a
--                                 rejected one shows in check_cron_http_failures;
--                                 there is no EXCEPTION handler, so a failing run
--                                 shows in check_cron_sql_failures (00640).
--
-- To see the findings now, without e-mail: SELECT * FROM public.copy_voseo_findings();
--
-- Not covered: voseo written without accents ("Abri la app y confirma") is spelled
-- like tuteo; and copy that only exists in the apps' bundles is CI's job.
--
-- Only service_role (and the owner) can execute these functions. No new table: no
-- GRANT rules apply (see CLAUDE.md, "Tablas nuevas en public").
-- The file ends with a self-test that aborts the migration if this database does
-- not find an accented voseo form, or flags tuteo, the preterite or the SOS button.
-- Rehearsal: supabase/tests/00652/run.sh
-- ============================================================

CREATE OR REPLACE FUNCTION public.voseo_forms()
 RETURNS SETOF text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$
  -- tuteo-exempt: the voseo forms this check looks for (copyTuteo.test.ts keeps this list equal to its own)
  SELECT jsonb_array_elements_text('["abrila","abrilas","abrile","abriles","abrilo","abrilos","abrime","abrimela","abrimelo","abrinos","abris","abrisela","abriselo","abrite","abritelo","abrís","aceptala","aceptalas","aceptale","aceptales","aceptalo","aceptalos","aceptame","aceptamela","aceptamelo","aceptanos","aceptasela","aceptaselo","aceptate","aceptatelo","aceptá","aceptás","acercala","acercalas","acercale","acercales","acercalo","acercalos","acercame","acercamela","acercamelo","acercanos","acercasela","acercaselo","acercate","acercatelo","acercá","acercás","acordala","acordalas","acordale","acordales","acordalo","acordalos","acordame","acordamela","acordamelo","acordanos","acordasela","acordaselo","acordate","acordatelo","acordá","acordás","activala","activalas","activale","activales","activalo","activalos","activame","activamela","activamelo","activanos","activasela","activaselo","activatelo","activá","activás","actualizala","actualizalas","actualizale","actualizales","actualizalo","actualizalos","actualizame","actualizamela","actualizamelo","actualizanos","actualizasela","actualizaselo","actualizate","actualizatelo","actualizá","actualizás","acá","agregala","agregalas","agregale","agregales","agregalo","agregalos","agregame","agregamela","agregamelo","agreganos","agregasela","agregaselo","agregate","agregatelo","agregá","agregás","ajustala","ajustalas","ajustale","ajustales","ajustalo","ajustalos","ajustame","ajustamela","ajustamelo","ajustanos","ajustasela","ajustaselo","ajustate","ajustatelo","ajustá","ajustás","andate","andá","anotala","anotalas","anotale","anotales","anotalo","anotalos","anotame","anotamela","anotamelo","anotanos","anotasela","anotaselo","anotate","anotatelo","anotá","anotás","aparecela","aparecelas","aparecele","apareceles","aparecelo","aparecelos","apareceme","aparecemela","aparecemelo","aparecenos","aparecesela","apareceselo","aparecete","aparecetelo","aparecé","aparecés","apretala","apretalas","apretale","apretales","apretalo","apretalos","apretame","apretamela","apretamelo","apretanos","apretasela","apretaselo","apretate","apretatelo","apretá","apretás","asegurala","aseguralas","asegurale","asegurales","aseguralo","aseguralos","asegurame","aseguramela","aseguramelo","aseguranos","asegurasela","aseguraselo","asegurate","aseguratelo","asegurá","asegurás","avisala","avisalas","avisale","avisales","avisalo","avisalos","avisame","avisamela","avisamelo","avisanos","avisasela","avisaselo","avisate","avisatelo","avisá","avisás","añadila","añadilas","añadile","añadiles","añadilo","añadilos","añadime","añadimela","añadimelo","añadinos","añadis","añadisela","añadiselo","añadite","añaditelo","añadís","borrala","borralas","borrale","borrales","borralo","borralos","borrame","borramela","borramelo","borranos","borrasela","borraselo","borrate","borratelo","borrá","borrás","buscala","buscalas","buscale","buscales","buscalo","buscalos","buscame","buscamela","buscamelo","buscanos","buscasela","buscaselo","buscate","buscatelo","buscá","buscás","calificala","calificalas","calificale","calificales","calificalo","calificalos","calificame","calificamela","calificamelo","calificanos","calificasela","calificaselo","calificate","calificatelo","calificá","calificás","cambiala","cambialas","cambiale","cambiales","cambialo","cambialos","cambiame","cambiamela","cambiamelo","cambianos","cambiasela","cambiaselo","cambiate","cambiatelo","cambiá","cambiás","cancelala","cancelalas","cancelale","cancelales","cancelalo","cancelalos","cancelame","cancelamela","cancelamelo","cancelanos","cancelasela","cancelaselo","cancelate","cancelatelo","cancelá","cancelás","cargala","cargalas","cargale","cargales","cargalo","cargalos","cargame","cargamela","cargamelo","carganos","cargasela","cargaselo","cargate","cargatelo","cargá","cargás","cerrala","cerralas","cerrale","cerrales","cerralo","cerralos","cerrame","cerramela","cerramelo","cerranos","cerrasela","cerraselo","cerrate","cerratelo","cerrá","cerrás","chequeala","chequealas","chequeale","chequeales","chequealo","chequealos","chequeame","chequeamela","chequeamelo","chequeanos","chequeasela","chequeaselo","chequeate","chequeatelo","chequeá","chequeás","compartila","compartilas","compartile","compartiles","compartilo","compartilos","compartime","compartimela","compartimelo","compartinos","compartis","compartisela","compartiselo","compartite","compartitelo","compartís","completala","completalas","completale","completales","completalo","completalos","completame","completamela","completamelo","completanos","completasela","completaselo","completate","completatelo","completá","completás","comprobala","comprobalas","comprobale","comprobales","comprobalo","comprobalos","comprobame","comprobamela","comprobamelo","comprobanos","comprobasela","comprobaselo","comprobate","comprobatelo","comprobá","comprobás","conectala","conectalas","conectale","conectales","conectalo","conectalos","conectame","conectamela","conectamelo","conectanos","conectasela","conectaselo","conectate","conectatelo","conectá","conectás","confirmala","confirmalas","confirmale","confirmales","confirmalo","confirmalos","confirmame","confirmamela","confirmamelo","confirmanos","confirmasela","confirmaselo","confirmate","confirmatelo","confirmá","confirmás","conocela","conocelas","conocele","conoceles","conocelo","conocelos","conoceme","conocemela","conocemelo","conocenos","conocesela","conoceselo","conocete","conocetelo","conocé","conocés","conservala","conservalas","conservale","conservales","conservalo","conservalos","conservame","conservamela","conservamelo","conservanos","conservasela","conservaselo","conservate","conservatelo","conservá","conservás","consultala","consultalas","consultale","consultales","consultalo","consultalos","consultame","consultamela","consultamelo","consultanos","consultasela","consultaselo","consultate","consultatelo","consultá","consultás","contactala","contactalas","contactale","contactales","contactalo","contactalos","contactame","contactamela","contactamelo","contactanos","contactasela","contactaselo","contactate","contactatelo","contactá","contactás","contala","contalas","contale","contales","contalo","contalos","contame","contamela","contamelo","contanos","contasela","contaselo","contate","contatelo","contá","contás","copiala","copialas","copiale","copiales","copialo","copialos","copiame","copiamela","copiamelo","copianos","copiasela","copiaselo","copiate","copiatelo","copiá","copiás","correla","correlas","correle","correles","correlo","correlos","correme","corremela","corremelo","correnos","corresela","correselo","correte","corretelo","corré","corrés","creela","creelas","creele","creeles","creelo","creelos","creeme","creemela","creemelo","creenos","creesela","creeselo","creete","creetelo","creés","cumplila","cumplilas","cumplile","cumpliles","cumplilo","cumplilos","cumplime","cumplimela","cumplimelo","cumplinos","cumplis","cumplisela","cumpliselo","cumplite","cumplitelo","cumplís","debela","debelas","debele","debeles","debelo","debelos","debeme","debemela","debemelo","debenos","debesela","debeselo","debete","debetelo","debé","debés","decila","decilas","decile","deciles","decilo","decilos","decime","decimela","decimelo","decinos","decis","decisela","deciselo","decite","decitelo","decí","decís","dejala","dejalas","dejale","dejales","dejalo","dejalos","dejame","dejamela","dejamelo","dejanos","dejasela","dejaselo","dejate","dejatelo","dejá","dejás","desactivala","desactivalas","desactivale","desactivales","desactivalo","desactivalos","desactivame","desactivamela","desactivamelo","desactivanos","desactivasela","desactivaselo","desactivate","desactivatelo","desactivá","desactivás","descargala","descargalas","descargale","descargales","descargalo","descargalos","descargame","descargamela","descargamelo","descarganos","descargasela","descargaselo","descargate","descargatelo","descargá","descargás","desconectala","desconectalas","desconectale","desconectales","desconectalo","desconectalos","desconectame","desconectamela","desconectamelo","desconectanos","desconectasela","desconectaselo","desconectate","desconectatelo","desconectá","desconectás","describila","describilas","describile","describiles","describilo","describilos","describime","describimela","describimelo","describinos","describis","describisela","describiselo","describite","describitelo","describís","devolvela","devolvelas","devolvele","devolveles","devolvelo","devolvelos","devolveme","devolvemela","devolvemelo","devolvenos","devolves","devolvesela","devolveselo","devolvete","devolvetelo","devolvé","devolvés","editala","editalas","editale","editales","editalo","editalos","editame","editamela","editamelo","editanos","editasela","editaselo","editate","editatelo","editá","editás","elegila","elegilas","elegile","elegiles","elegilo","elegilos","elegime","elegimela","elegimelo","eleginos","elegis","elegisela","elegiselo","elegite","elegitelo","elegís","encendela","encendelas","encendele","encendeles","encendelo","encendelos","encendeme","encendemela","encendemelo","encendenos","encendes","encendesela","encendeselo","encendete","encendetelo","encendé","encendés","encontrala","encontralas","encontrale","encontrales","encontralo","encontralos","encontrame","encontramela","encontramelo","encontranos","encontrasela","encontraselo","encontrate","encontratelo","encontrá","encontrás","entendela","entendelas","entendele","entendeles","entendelo","entendelos","entendeme","entendemela","entendemelo","entendenos","entendes","entendesela","entendeselo","entendete","entendetelo","entendé","entendés","enviala","envialas","enviale","enviales","envialo","envialos","enviame","enviamela","enviamelo","envianos","enviasela","enviaselo","enviate","enviatelo","enviá","enviás","escogela","escogelas","escogele","escogeles","escogelo","escogelos","escogeme","escogemela","escogemelo","escogenos","escogesela","escogeselo","escogete","escogetelo","escogé","escogés","escribila","escribilas","escribile","escribiles","escribilo","escribilos","escribime","escribimela","escribimelo","escribinos","escribis","escribisela","escribiselo","escribite","escribitelo","escribís","esperala","esperalas","esperale","esperales","esperalo","esperalos","esperame","esperamela","esperamelo","esperanos","esperasela","esperaselo","esperate","esperatelo","esperá","esperás","establecela","establecelas","establecele","estableceles","establecelo","establecelos","estableceme","establecemela","establecemelo","establecenos","establecesela","estableceselo","establecete","establecetelo","establecé","establecés","explicala","explicalas","explicale","explicales","explicalo","explicalos","explicame","explicamela","explicamelo","explicanos","explicasela","explicaselo","explicatelo","explicá","explicás","fijala","fijalas","fijale","fijales","fijalo","fijalos","fijame","fijamela","fijamelo","fijanos","fijasela","fijaselo","fijate","fijatelo","fijá","fijás","guardala","guardalas","guardale","guardales","guardalo","guardalos","guardame","guardamela","guardamelo","guardanos","guardasela","guardaselo","guardate","guardatelo","guardá","guardás","habilitala","habilitalas","habilitale","habilitales","habilitalo","habilitalos","habilitame","habilitamela","habilitamelo","habilitanos","habilitasela","habilitaselo","habilitatelo","habilitá","habilitás","hacela","hacelas","hacele","haceles","hacelo","hacelos","haceme","hacemela","hacemelo","hacenos","hacesela","haceselo","hacete","hacetelo","hacé","hacés","imprimila","imprimilas","imprimile","imprimiles","imprimilo","imprimilos","imprimime","imprimimela","imprimimelo","impriminos","imprimis","imprimisela","imprimiselo","imprimite","imprimitelo","imprimís","ingresala","ingresalas","ingresale","ingresales","ingresalo","ingresalos","ingresame","ingresamela","ingresamelo","ingresanos","ingresasela","ingresaselo","ingresate","ingresatelo","ingresá","ingresás","intentala","intentalas","intentale","intentales","intentalo","intentalos","intentame","intentamela","intentamelo","intentanos","intentasela","intentaselo","intentate","intentatelo","intentá","intentás","invitala","invitalas","invitale","invitales","invitalo","invitalos","invitame","invitamela","invitamelo","invitanos","invitasela","invitaselo","invitate","invitatelo","invitá","invitás","leela","leelas","leele","leeles","leelo","leelos","leeme","leemela","leemelo","leenos","leesela","leeselo","leete","leetelo","leé","leés","llamala","llamalas","llamale","llamales","llamalo","llamalos","llamame","llamamela","llamamelo","llamanos","llamasela","llamaselo","llamate","llamatelo","llamá","llamás","llenala","llenalas","llenale","llenales","llenalo","llenalos","llename","llenamela","llenamelo","llenanos","llenasela","llenaselo","llenate","llenatelo","llená","llenás","llevala","llevalas","llevale","llevales","llevalo","llevalos","llevame","llevamela","llevamelo","llevanos","llevasela","llevaselo","llevate","llevatelo","llevá","llevás","mandala","mandalas","mandale","mandales","mandalo","mandalos","mandame","mandamela","mandamelo","mandanos","mandasela","mandaselo","mandatelo","mandá","mandás","mantenela","mantenelas","mantenele","manteneles","mantenelo","mantenelos","manteneme","mantenemela","mantenemelo","mantenenos","mantenes","mantenesela","manteneselo","mantenete","mantenetelo","mantené","mantenés","marcala","marcalas","marcale","marcales","marcalo","marcalos","marcame","marcamela","marcamelo","marcanos","marcasela","marcaselo","marcate","marcatelo","marcá","marcás","mirala","miralas","mirale","mirales","miralo","miralos","mirame","miramela","miramelo","miranos","mirasela","miraselo","mirate","miratelo","mirá","mirás","movela","movelas","movele","moveles","movelo","movelos","moveme","movemela","movemelo","movenos","movesela","moveselo","movete","movetelo","mové","movés","necesitala","necesitalas","necesitale","necesitales","necesitalo","necesitalos","necesitame","necesitamela","necesitamelo","necesitanos","necesitasela","necesitaselo","necesitate","necesitatelo","necesitá","necesitás","obtenela","obtenelas","obtenele","obteneles","obtenelo","obtenelos","obteneme","obtenemela","obtenemelo","obtenenos","obtenes","obtenesela","obteneselo","obtenete","obtenetelo","obtené","obtenés","ofrecela","ofrecelas","ofrecele","ofreceles","ofrecelo","ofrecelos","ofreceme","ofrecemela","ofrecemelo","ofrecenos","ofrecesela","ofreceselo","ofrecete","ofrecetelo","ofrecé","ofrecés","olvidala","olvidalas","olvidale","olvidales","olvidalo","olvidalos","olvidame","olvidamela","olvidamelo","olvidanos","olvidasela","olvidaselo","olvidate","olvidatelo","olvidá","olvidás","pagala","pagalas","pagale","pagales","pagalo","pagalos","pagame","pagamela","pagamelo","paganos","pagasela","pagaselo","pagate","pagatelo","pagá","pagás","pasala","pasalas","pasale","pasales","pasalo","pasalos","pasame","pasamela","pasamelo","pasanos","pasasela","pasaselo","pasate","pasatelo","pasá","pasás","pedila","pedilas","pedile","pediles","pedilo","pedilos","pedime","pedimela","pedimelo","pedinos","pedis","pedisela","pediselo","pedite","peditelo","pedís","perdela","perdelas","perdele","perdeles","perdelo","perdelos","perdeme","perdemela","perdemelo","perdenos","perdes","perdesela","perdeselo","perdete","perdetelo","perdé","perdés","permitila","permitilas","permitile","permitiles","permitilo","permitilos","permitime","permitimela","permitimelo","permitinos","permitis","permitisela","permitiselo","permitite","permititelo","permitís","podela","podelas","podele","podeles","podelo","podelos","podeme","podemela","podemelo","podenos","podes","podesela","podeselo","podete","podetelo","podé","podés","ponela","ponelas","ponele","poneles","ponelo","ponelos","poneme","ponemela","ponemelo","ponenos","ponesela","poneselo","ponete","ponetelo","poné","ponés","presionala","presionalas","presionale","presionales","presionalo","presionalos","presioname","presionamela","presionamelo","presionanos","presionasela","presionaselo","presionate","presionatelo","presioná","presionás","probala","probalas","probale","probales","probalo","probalos","probame","probamela","probamelo","probanos","probasela","probaselo","probatelo","probá","probás","programala","programalas","programale","programales","programalo","programalos","programame","programamela","programamelo","programanos","programasela","programaselo","programate","programatelo","programá","programás","prometela","prometelas","prometele","prometeles","prometelo","prometelos","prometeme","prometemela","prometemelo","prometenos","prometesela","prometeselo","prometete","prometetelo","prometé","prometés","protegela","protegelas","protegele","protegeles","protegelo","protegelos","protegeme","protegemela","protegemelo","protegenos","protegesela","protegeselo","protegete","protegetelo","protegé","protegés","quedala","quedalas","quedale","quedales","quedalo","quedalos","quedame","quedamela","quedamelo","quedanos","quedasela","quedaselo","quedate","quedatelo","quedá","quedás","querela","querelas","querele","quereles","querelo","querelos","quereme","queremela","queremelo","querenos","queres","queresela","quereselo","querete","queretelo","queré","querés","recargala","recargalas","recargale","recargales","recargalo","recargalos","recargame","recargamela","recargamelo","recarganos","recargasela","recargaselo","recargate","recargatelo","recargá","recargás","recibila","recibilas","recibile","recibiles","recibilo","recibilos","recibime","recibimela","recibimelo","recibinos","recibis","recibisela","recibiselo","recibite","recibitelo","recibís","recogela","recogelas","recogele","recogeles","recogelo","recogelos","recogeme","recogemela","recogemelo","recogenos","recogesela","recogeselo","recogete","recogetelo","recogé","recogés","reconocela","reconocelas","reconocele","reconoceles","reconocelo","reconocelos","reconoceme","reconocemela","reconocemelo","reconocenos","reconocesela","reconoceselo","reconocete","reconocetelo","reconocé","reconocés","recordala","recordalas","recordale","recordales","recordalo","recordalos","recordame","recordamela","recordamelo","recordanos","recordasela","recordaselo","recordate","recordatelo","recordá","recordás","regalala","regalalas","regalale","regalales","regalalo","regalalos","regalame","regalamela","regalamelo","regalanos","regalasela","regalaselo","regalate","regalatelo","regalá","regalás","registrala","registralas","registrale","registrales","registralo","registralos","registrame","registramela","registramelo","registranos","registrasela","registraselo","registrate","registratelo","registrá","registrás","reintentala","reintentalas","reintentale","reintentales","reintentalo","reintentalos","reintentame","reintentamela","reintentamelo","reintentanos","reintentasela","reintentaselo","reintentate","reintentatelo","reintentá","reintentás","reportala","reportalas","reportale","reportales","reportalo","reportalos","reportame","reportamela","reportamelo","reportanos","reportasela","reportaselo","reportate","reportatelo","reportá","reportás","reservala","reservalas","reservale","reservales","reservalo","reservalos","reservame","reservamela","reservamelo","reservanos","reservasela","reservaselo","reservate","reservatelo","reservá","reservás","respondela","respondelas","respondele","respondeles","respondelo","respondelos","respondeme","respondemela","respondemelo","respondenos","respondesela","respondeselo","respondete","respondetelo","respondé","respondés","retirala","retiralas","retirale","retirales","retiralo","retiralos","retirame","retiramela","retiramelo","retiranos","retirasela","retiraselo","retirate","retiratelo","retirá","retirás","revisala","revisalas","revisale","revisales","revisalo","revisalos","revisame","revisamela","revisamelo","revisanos","revisasela","revisaselo","revisate","revisatelo","revisá","revisás","sabela","sabelas","sabele","sabeles","sabelo","sabelos","sabeme","sabemela","sabemelo","sabenos","sabesela","sabeselo","sabete","sabetelo","sabé","sabés","salila","salilas","salile","saliles","salilo","salilos","salime","salimela","salimelo","salinos","salis","salisela","saliselo","salite","salitelo","salís","seguila","seguilas","seguile","seguiles","seguilo","seguilos","seguime","seguimela","seguimelo","seguinos","seguis","seguisela","seguiselo","seguite","seguitelo","seguís","sentala","sentalas","sentale","sentales","sentalo","sentalos","sentame","sentamela","sentamelo","sentanos","sentasela","sentaselo","sentate","sentatelo","sentá","sentás","solicitala","solicitalas","solicitale","solicitales","solicitalo","solicitalos","solicitame","solicitamela","solicitamelo","solicitanos","solicitasela","solicitaselo","solicitate","solicitatelo","solicitá","solicitás","subila","subilas","subile","subiles","subilo","subilos","subime","subimela","subimelo","subinos","subis","subisela","subiselo","subite","subitelo","subís","sumala","sumalas","sumale","sumales","sumalo","sumalos","sumame","sumamela","sumamelo","sumanos","sumasela","sumaselo","sumate","sumatelo","sumá","sumás","tenela","tenelas","tenele","teneles","tenelo","tenelos","teneme","tenemela","tenemelo","tenenos","tenes","tenesela","teneselo","tenete","tenetelo","tené","tenés","tocala","tocalas","tocale","tocales","tocalo","tocalos","tocame","tocamela","tocamelo","tocanos","tocasela","tocaselo","tocate","tocatelo","tocá","tocás","tomala","tomalas","tomale","tomales","tomalo","tomalos","tomame","tomamela","tomamelo","tomanos","tomasela","tomaselo","tomatelo","tomá","ubicala","ubicalas","ubicale","ubicales","ubicalo","ubicalos","ubicame","ubicamela","ubicamelo","ubicanos","ubicasela","ubicaselo","ubicate","ubicatelo","ubicá","ubicás","usala","usalas","usale","usales","usalo","usalos","usame","usamela","usamelo","usanos","usasela","usaselo","usate","usatelo","usá","usás","validala","validalas","validale","validales","validalo","validalos","validame","validamela","validamelo","validanos","validasela","validaselo","validatelo","validá","validás","venila","venilas","venile","veniles","venilo","venilos","venime","venimela","venimelo","veninos","venis","venisela","veniselo","venite","venitelo","vení","venís","verificala","verificalas","verificale","verificales","verificalo","verificalos","verificame","verificamela","verificamelo","verificanos","verificasela","verificaselo","verificate","verificatelo","verificá","verificás","volvela","volvelas","volvele","volveles","volvelo","volvelos","volveme","volvemela","volvemelo","volvenos","volves","volvesela","volveselo","volvete","volvetelo","volvé","volvés","vos"]'::jsonb)
$function$;

CREATE OR REPLACE FUNCTION public.voseo_hits(p_text text)
 RETURNS text[]
 LANGUAGE sql
 STABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT coalesce(array_agg(DISTINCT x.hit ORDER BY x.hit), '{}'::text[])
    FROM (
      SELECT lower(m[1]) AS hit
        FROM regexp_matches(normalize(p_text, NFC) COLLATE "default", '([[:alpha:]]+)', 'g') AS m
       WHERE lower(m[1]) IN (SELECT public.voseo_forms())
      UNION ALL
      SELECT 'sos <palabra>'
       WHERE normalize(p_text, NFC) COLLATE "default" ~ '(^|[^[:alpha:]])sos[[:space:]]+[[:lower:]]'
    ) AS x
$function$;

CREATE OR REPLACE FUNCTION public.copy_voseo_findings()
 RETURNS TABLE (source text, hits text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  WITH src (label, body) AS (
    SELECT 'cms:' || c.slug, concat_ws(' ', c.title_es, c.body_es) FROM cms_content c
    UNION ALL
    SELECT 'blog:' || b.slug || CASE WHEN b.is_published THEN '' ELSE ' (despublicado)' END,
           concat_ws(' ', b.title_es, b.excerpt_es, b.body_es)
      FROM blog_posts b
    UNION ALL
    SELECT 'anuncio:' || a.id::text, concat_ws(' ', a.title_es, a.body_es, a.cta_label_es) FROM home_announcements a
    UNION ALL
    SELECT 'promoción:' || coalesce(p.code, p.id::text), concat_ws(' ', p.title_es, p.body_es) FROM promotions p
    UNION ALL
    SELECT 'misión:' || q.id::text, concat_ws(' ', q.title_es, q.description_es) FROM driver_quests q
    UNION ALL
    SELECT 'etiqueta de reseña:' || t.tag_key, t.label_es FROM review_tag_definitions t
    UNION ALL
    SELECT 'seguro:' || i.service_type, i.coverage_description_es FROM trip_insurance_configs i
    UNION ALL
    SELECT 'servicio:' || s.slug, s.name_es FROM service_type_configs s
    UNION ALL
    SELECT 'platform_config:' || k.key, k.value #>> '{}'
      FROM platform_config k
     WHERE k.key NOT LIKE 'copy\_voseo\_%'
       AND k.key !~ '_(at|detail|status|signature)$'
    UNION ALL
    SELECT 'campaña:' || coalesce(g.name, g.id::text), concat_ws(' ', g.message_title, g.message_body)
      FROM campaigns g
     WHERE g.sent_at IS NULL OR g.sent_at > now() - interval '8 days'
    UNION ALL
    SELECT 'push (8 días):' || coalesce(n.type, '-'), concat_ws(' ', n.title, n.body)
      FROM notifications n
     WHERE n.created_at > now() - interval '8 days'
    UNION ALL
    SELECT 'sms (8 días):' || coalesce(l.event_type, '-'), l.message_body
      FROM sms_log l
     WHERE l.created_at > now() - interval '8 days'
  )
  SELECT s.label, string_agg(DISTINCT h.hit, ', ' ORDER BY h.hit)
    FROM src s
    CROSS JOIN LATERAL unnest(public.voseo_hits(s.body)) AS h(hit)
   WHERE s.body IS NOT NULL
   GROUP BY s.label
   ORDER BY s.label
$function$;

CREATE OR REPLACE FUNCTION public.check_copy_voseo()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_max_rows    constant int := 40;
  v_now         timestamptz := now();
  v_findings    jsonb;
  v_count       int;
  v_status      text;
  v_signature   text;
  v_prev_status text;
  v_prev_sig    text;
  v_detail      text;
  v_notify      boolean;
  v_rows_html   text;
  v_to_raw      text;
  v_rcpt        text;
  v_service_key text;
  v_headers     jsonb;
  v_subject     text;
  v_html        text;
  v_sent        int := 0;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object('source', f.source, 'hits', f.hits) ORDER BY f.source), '[]'::jsonb),
         count(*)
    INTO v_findings, v_count
    FROM public.copy_voseo_findings() AS f;

  v_status    := CASE WHEN v_count = 0 THEN 'ok' ELSE 'found' END;
  v_signature := md5(v_findings::text);

  SELECT value #>> '{}' INTO v_prev_status FROM platform_config WHERE key = 'copy_voseo_status';
  SELECT value #>> '{}' INTO v_prev_sig    FROM platform_config WHERE key = 'copy_voseo_signature';

  SELECT CASE WHEN v_count = 0 THEN 'sin voseo'
              ELSE v_count::text || ' con voseo: '
                   || left(string_agg(e ->> 'source' || ' (' || (e ->> 'hits') || ')', '; '), 900)
         END
    INTO v_detail
    FROM jsonb_array_elements(v_findings) AS e;

  -- Written every run; keys ending in _at / _detail are not audited (00606).
  INSERT INTO platform_config (key, value) VALUES
    ('copy_voseo_at',     to_jsonb(v_now::text)),
    ('copy_voseo_detail', to_jsonb(coalesce(v_detail, 'sin voseo')))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  -- Written only when they change, so a quiet week leaves no audit row.
  IF v_status IS DISTINCT FROM v_prev_status OR v_signature IS DISTINCT FROM v_prev_sig THEN
    INSERT INTO platform_config (key, value) VALUES
      ('copy_voseo_status',    to_jsonb(v_status)),
      ('copy_voseo_signature', to_jsonb(v_signature))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  END IF;

  -- E-mail a new or different list, and the first week it is empty again.
  v_notify := (v_count > 0 AND v_signature IS DISTINCT FROM v_prev_sig)
           OR (v_count = 0 AND coalesce(v_prev_status, '') = 'found');

  IF v_notify THEN
    SELECT value #>> '{}' INTO v_to_raw FROM platform_config WHERE key = 'business_notification_email';

    IF v_to_raw IS NOT NULL AND position('@' IN v_to_raw) > 0 THEN
      v_service_key := get_service_role_key();
      v_headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_service_key,
        'apikey', v_service_key);

      IF v_count > 0 THEN
        SELECT string_agg(
                 '<tr><td style="padding:6px;border-bottom:1px solid #eee">'
                 || replace(replace(replace(e ->> 'source', '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
                 || '</td><td style="padding:6px;border-bottom:1px solid #eee">'
                 || replace(replace(replace(e ->> 'hits', '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
                 || '</td></tr>', '' ORDER BY ord)
          INTO v_rows_html
          FROM jsonb_array_elements(v_findings) WITH ORDINALITY AS t(e, ord)
         WHERE ord <= c_max_rows;

        v_subject := '[TriciGo] Hay voseo en textos que ven los usuarios';
        v_html :=
             '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#b45309;border-bottom:2px solid #b45309;padding-bottom:8px">Voseo en textos para usuarios</h2>'
          || '<p>El chequeo semanal encontró voseo en <b>' || v_count::text || '</b> lugares. '
          || 'TriciGo escribe en tú, así que hay que corregirlos.</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
          || '<tr><th style="text-align:left;padding:6px;border-bottom:2px solid #ddd">Dónde</th>'
          || '<th style="text-align:left;padding:6px;border-bottom:2px solid #ddd">Formas encontradas</th></tr>'
          || coalesce(v_rows_html, '')
          || '</table>'
          || CASE WHEN v_count > c_max_rows
                  THEN '<p>Y ' || (v_count - c_max_rows)::text || ' lugares más: <code>SELECT * FROM public.copy_voseo_findings();</code></p>'
                  ELSE '' END
          || '<p><b>Cómo corregirlo:</b> las páginas legales, el blog, los anuncios, las promociones '
          || 'y las campañas se editan desde el panel admin. Un push o un SMS lo arma una función de la '
          || 'base o una campaña: corrige la fuente, no el mensaje ya enviado.</p>'
          || '<p>Este aviso se repite solo si la lista cambia.</p>'
          || '<p style="color:#777;font-size:12px">Chequeo automático semanal (check_copy_voseo). No respondas este correo.</p>'
          || '</body></html>';
      ELSE
        v_subject := '[TriciGo] Ya no hay voseo en los textos revisados';
        v_html :=
             '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#059669;border-bottom:2px solid #059669;padding-bottom:8px">Textos en tuteo</h2>'
          || '<p>El chequeo semanal ya no encuentra voseo en los textos que revisa.</p>'
          || '<p style="color:#777;font-size:12px">Chequeo automático semanal (check_copy_voseo). No respondas este correo.</p>'
          || '</body></html>';
      END IF;

      FOR v_rcpt IN
        SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x)
         WHERE position('@' IN x) > 0
      LOOP
        PERFORM public.cron_http_post('copy-voseo-alert',
          url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
          headers := v_headers,
          body    := jsonb_build_object(
                       'recipient_email', v_rcpt,
                       'subject', v_subject,
                       'template', v_html,
                       'data', '{}'::jsonb));
        v_sent := v_sent + 1;
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', v_status, 'prev_status', v_prev_status, 'findings', v_count,
    'notified', v_notify, 'emails_sent', v_sent);
END;
$function$;

REVOKE ALL ON FUNCTION public.voseo_forms()         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.voseo_hits(text)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.copy_voseo_findings() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_copy_voseo()    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voseo_forms()         TO service_role;
GRANT EXECUTE ON FUNCTION public.voseo_hits(text)      TO service_role;
GRANT EXECUTE ON FUNCTION public.copy_voseo_findings() TO service_role;
GRANT EXECUTE ON FUNCTION public.check_copy_voseo()    TO service_role;

SELECT cron.unschedule('check-copy-voseo') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'check-copy-voseo');
SELECT cron.schedule('check-copy-voseo', '0 13 * * 1', 'SELECT public.check_copy_voseo();');

-- Self-test: this database must find accented voseo and leave tuteo alone.
-- The accented letters are built with chr() so the test does not depend on how
-- this file's bytes reach the server.
DO $selftest$
DECLARE
  v_probe_1 constant text := 'pod' || chr(233) || 's';   -- podés
  v_probe_2 constant text := 'eleg' || chr(237) || 's';  -- elegís
  v_n       int;
BEGIN
  SELECT count(*) INTO v_n FROM public.voseo_forms();
  IF v_n < 1900 OR NOT EXISTS (SELECT 1 FROM public.voseo_forms() AS w WHERE w = v_probe_1)
     OR NOT EXISTS (SELECT 1 FROM public.voseo_forms() AS w WHERE w = v_probe_2) THEN
    RAISE EXCEPTION '00652: voseo_forms() is not the expected list (% forms)', v_n;
  END IF;

  IF public.voseo_hits('Ya ' || upper(v_probe_1) || ' ver tu viaje y ' || v_probe_2 || ' al chofer.')
     IS DISTINCT FROM ARRAY[v_probe_2, v_probe_1] THEN
    RAISE EXCEPTION '00652: voseo_hits() does not find accented voseo here (collation %); the weekly check would be blind',
      (SELECT datcollate FROM pg_database WHERE datname = current_database());
  END IF;

  -- tuteo-exempt: the verb "sos" that this test must find
  IF public.voseo_hits('si sos conductor') IS DISTINCT FROM ARRAY['sos <palabra>'] THEN
    RAISE EXCEPTION '00652: voseo_hits() misses the verb "sos"';
  END IF;

  IF cardinality(public.voseo_hits(
       'Ya puedes ver tu viaje. Ped' || chr(237) || ' por error. SOS activado. Escr' || chr(237) || 'benos.')) <> 0 THEN
    RAISE EXCEPTION '00652: voseo_hits() flags tuteo, the preterite or the SOS button';
  END IF;

  IF (SELECT count(*) FROM cron.job WHERE jobname = 'check-copy-voseo') <> 1 THEN
    RAISE EXCEPTION '00652: cron job check-copy-voseo is not scheduled exactly once';
  END IF;
END
$selftest$;
