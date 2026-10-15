# Acceptanskriterier: Vendora-first

Tillhör [flödesspecifikationen](vendora-first-workflow.md).

**Status:** Detta är specificerade testfall för kommande implementation, inte automatiserade tester och inte ett protokoll över genomförda tester. Inga testfall nedan påstås vara godkända genom denna dokumentations-PR.

## A. Huvudscenario: jämförelse före första utskicket

### Förutsättningar

- Ett sparat ärende med rätt avtalstyp, en fast standardversion och ett identifierbart arbetsutkast.
- Ett syntetiskt kundavtal med fem tydliga skillnader mot standarden. Använd testdata utan riktiga kunders uppgifter.
- Samtliga relevanta stycken och bilagor är läsbara.
- Mail och AI är ersatta med kontrollerade testdubblar under automatiserad testning; inget riktigt utskick och ingen modellkostnad behövs för grundfallen.

### Händelser

1. Skapa ärendet från Vendora-standarden och ladda upp kundavtalet i det första steget.
2. Kör jämförelsen. Den visar fem findings, med källreferenser och förslag mot våra klausuler/fält där en ändring behövs.
3. Godkänn två föreslagna formuleringar, behåll vår nuvarande lydelse för två punkter och godkänn advokatens alternativ för den femte.
4. Stäng ärendet och öppna det igen.
5. Granska och exportera vårt avtalsutkast.
6. Skicka vårt anpassade utkast till kunden för komplettering och granskning.

### Förväntat resultat

- Vårt avtal innehåller exakt de tre godkända anpassningarna. Två oförändrade punkter finns kvar med registrerade beslut.
- Övriga stycken, förbehåll, bilagor och affärsuppgifter är oförändrade, förutom uttryckligen godkända följdändringar som har visats i förhandsvisningen.
- Kundens originalfil och Vendora-standardversionen är oförändrade.
- Exporten har Vendora-avtalets struktur, inte kundavtalets layout eller numrering.
- Samma innehåll visas i förhandsvisning, ren Word-export och kundens utskickade version.
- Samtliga beslut och ändringar överlever omladdning och ny inloggning.
- Kunden får inte intern riskbedömning, mandat, chatthistorik eller avvisade alternativ.
- Ärendet väntar på kundens komplettering; det markeras inte som slutgodkänt eller signerat.

## B. Huvudscenario: kundens återkoppling och slutgodkännande

Utgå från det anpassade, utskickade avtalet i scenario A.

1. Kunden fyller i företagsadress, kontaktperson och signatär.
2. Kunden föreslår ytterligare villkorsändringar och skickar in formuläret.
3. Kontrollera att informationsfälten kompletterats men att villkorsförslagen fortfarande väntar på Vendora-beslut.
4. Godkänn ett kundförslag, avslå ett annat och använd advokatens alternativa lydelse för en tredje punkt.
5. Genomför eventuell ytterligare kundavstämning, sedan slutkontroll och begäran om internt godkännande/underskrift.
6. Låt den behöriga interna undertecknaren godkänna rätt version. Skicka därefter den versionen till motparten för underskrift.

Förväntat resultat:

- De tre anpassningarna från scenario A finns kvar om inget senare uttryckligt beslut ändrat dem.
- Nya förslag jämförs mot den version kunden fick, inte mot ett nygenererat standardavtal.
- Den rena slutversionen innehåller endast uttryckligen godkända villkorsändringar och granskade uppgifter.
- Avvikelsesammanställningen beräknas från sparat innehåll, inte enbart från webbläsarens inskickade påstående.
- Obehandlade förslag och olösta blockerande konflikter stoppar slutgodkännande på servern.
- Intern attest, Vendora-underskrift, motpartsutskick och motpartens underskrift hålls åtskilda.
- Underskrift/godkännande avser exakt dokumentversion; ändrad text kan inte ärva det gamla godkännandet.

## C. Obligatoriska kompletterande fall

| ID | Fall | Förväntat resultat |
| --- | --- | --- |
| C01 | Starta utan kundavtal | Normalflödet från vår mall fungerar utan AI-jämförelse. |
| C02 | Distributionsavtal respektive RA/RB | Förslag, fält, bilagor och standard väljs från rätt mall och roll. Testa varje mall separat. |
| C03 | Kundens villkor klassas Hard no, men ett tillåtet alternativ finns | Godkännandeknappen inför endast det uttryckligt visade alternativet i vårt avtal. Kundens ursprungliga villkor accepteras inte. |
| C04 | Hard no utan acceptabel kompromiss | Behåll vår lydelse eller eskalera. Ingen påhittad eftergift och ingen falsk klar-markering. |
| C05 | Kundens formulering är likvärdig med vår | Ingen ändring krävs enbart för ordagrann likhet. Ett finding kan avslutas utan dokumentändring. |
| C06 | Kundens dokument saknar ett skydd som finns i vårt | Vårt skydd behålls. Systemet föreslår inte borttagning på grund av frånvaro i kundavtalet. |
| C07 | Ändra en mening i `ra.s4.title` | Fullständig klausul används. Den efterföljande meningen om insolvens/återtagande får inte försvinna. Kontrollera faktisk Word-text. |
| C08 | Ändra betalningstid som återges i huvudavtal och bilaga | Alla nödvändiga följdändringar visas och beslutas som en sammanhängande grupp. Dokumentet får inte innehålla två motstridiga betalningstider. |
| C09 | Förslaget matchar ingen eller flera platser | Godkännande stoppas med förklaring. Ingen tyst alternativ placering eller tillägg sist i dokumentet. |
| C10 | Två användare ändrar samma version | Den första giltiga transaktionen sparas. Den andra får versionskonflikt och måste granska nytt underlag. |
| C11 | Dubbelklick, timeout eller upprepat beslut | Idempotent resultat. Ingen dubblerad klausul, felaktig extra version eller falsk sparbekräftelse. |
| C12 | Växla mellan två kunder med samma avtalstyp | Inga förslag, godkännanden, uppladdningar eller formulärdata läcker mellan ärenden. |
| C13 | Kunden manipulerar interna fält i inlämningen | Servern accepterar endast tillåtna informationsfält och separata förslag. Mall, tidigare godkännanden, klausulanpassningar och signaturdata skyddas. |
| C14 | Kunden använder en äldre länk efter en ny utskicksomgång | Nyare innehåll skrivs inte över. Inlämningen hanteras som föråldrad/konflikt och kan granskas utan dataförlust. |
| C15 | Vanlig användare anropar administrativt signer- eller beslutsflöde | Behörigheten kontrolleras på servern. En dold knapp är inte den enda spärren. |
| C16 | Försök skicka för slutgodkännande med obehandlade förslag | Servern stoppar åtgärden även om webbläsarens validering kringgås. |
| C17 | Försök ändra innehåll under eller efter underskrift | Ändringen stoppas. Återgång skapar ny granskningsbar version och återanvänder inte tidigare godkännande. |
| C18 | Ny standard publiceras medan ett ärende pågår | Befintlig standardreferens och gamla exporter förblir oförändrade. Uppgradering kräver uttryckligt val och granskning. |
| C19 | Mailleverans misslyckas | Visa fel/ej levererat och möjliggör säkert återförsök. Ingen felaktig utskicks- eller signeringsstatus. |
| C20 | Filen är skadad, delvis läst, för lång eller innehåller AI-instruktioner | Bevara fel/begränsningar; inget besked om fullständig granskning utan underlag. Instruktioner inne i avtalet påverkar inte modellens mandat. |
| C21 | Öppna en äldre sparad review med wording avsedd för kundens dokument | Läsning fungerar, men texten tillämpas inte direkt. Ny matchning/generering mot rätt Vendora-version krävs. |
| C22 | Granska den kundsynliga sidan, dokumentet och API-svaren | Inget internt playbook-innehåll, riskresonemang, avvisade alternativ, godkännandemandat eller hemliga tokenvärden exponeras utöver kundlänkens nödvändiga behörighet. |
| C23 | Ett sammanhängande förslag har flera beroende ändringar och en av dem misslyckas | Gruppen sparas inte delvis. Visa konflikt och behåll tidigare arbetsversion. |
| C24 | Slutdokumentets mallkod ändras efter att versionen godkänts | Hämtning/utskick använder den låsta dokumentversionen, inte ett tyst ombyggt dokument från den nya koden. |

## D. Verifieringsnivåer för en kommande funktions-PR

**Enhetstester:** fullständig måltext, matchning, typkontroll, förslag/beroenden, versionsförvillkor och beslutstillstånd.

**API- och databastester:** transaktioner, idempotens, servervalidering, rollkontroller, kundinlämning utan överskrivning av godkända ändringar, versionsbundna utskick och signeringsspärrar.

**Webbläsartester:** valfri uppladdning i första steget, omedelbara beslut utan obligatorisk chatt, korrekt förhandsvisning, omladdning, två granskningsomgångar och tydlig felhantering.

**Dokumenttester:** läs exporterad DOCX och jämför mot förväntad fullständig text. Kontrollera att oförändrade skydd finns kvar och att ren version och accepterade ändringsmarkeringar ger samma slutlydelse. Gör visuell kontroll av tabeller, bilagor, numrering och sidbrytningar.

**Rapportering:** redovisa exakt vilka tester som körts, vilka som hoppats över och vilka integrationer som varit stubbar. En grön UI-indikator eller en lyckad modellrespons är inte ensam ett godkänt acceptanstest.
