# Vendora Agreement Generator — systemöversikt

Senast uppdaterad: 2026-10-30. Repo: `ts-droid/vendora-agreements`. Drift: Railway, projekt "Vendora agreements", tjänst `vendora-agreements`, med Postgres-tjänsten i samma projekt. Adress: https://vendora-agreements-production.up.railway.app. Varje merge till `main` deployas automatiskt.

Det här dokumentet beskriver hela bygget: vad appen gör, hur ett avtal rör sig genom den, vad som lagras, vilka gränssnitt som finns och vad som ändrats. Det är skrivet för att kunna läsas utan tillgång till koden, även av andra verktyg.

Dokumentet uppdateras i varje PR som ändrar beteendet (ändringsloggen i avsnitt 14 får en rad per PR). En kopia ligger i Google Drive som "Vendora Agreement Generator – systemöversikt.md" och ersätts efter varje merge.

## 1. Syfte

Internt verktyg för Vendora Nordic AB för att ta fram, förhandla, skicka ut och signera återförsäljar- och distributörsavtal. Personal loggar in med Google-konto på `@vendora.se`. Motparter behöver aldrig konto: de får länkar.

Tekniskt: en Node/Express-server (`server.js`) med Postgres, en enda stor klientsida (`index.html`) som bygger Word-dokumenten i webbläsaren med docx.js, och ett flödesbibliotek för granskning (`workflow-core.js`, `workflow-api.js`, `workflow-ui.js`). AI-funktionerna går mot Anthropic (`ai.js`).

## 2. Avtalstyper och dokument

| Kod | Avtal | Vem fyller i motpartens del |
| --- | --- | --- |
| `da` | Distributor Agreement (Vendora köper av leverantör) | Leverantören, via ifyllnadslänk. Endast admin får skapa. |
| `ra` | Reseller Agreement (Vendora säljer till återförsäljare) | Återförsäljaren |
| `rb` | Reseller Agreement — Simplified | Återförsäljaren |

Dokumentet byggs som `.docx` i webbläsaren från formulärets data plus klausulbiblioteket (`agreement-clauses.js`). Varje klausul har ett id (t.ex. `da.s3.p1`) och kan skrivas över, läggas till eller tas bort per avtal (`clauseOverrides`, `clauseInserts`, `clauseDeletes`, `annexOverrides`, `annexDeletes`, `redlines`). Word med ändringsmarkeringar kan också laddas ner. En motpart får aldrig se interna anteckningar eller AI-motiveringar: `publicData()` rensar bort dem.

Distributörsavtalets MDF-del: bas-MDF är det som används. Målbonus och co-op-fond är valfria och visas för motparten och i Appendix 1 bara om Vendora satt ett värde.

## 3. Två vägar för ett avtal

**Ifyllnadsflödet (äldre, enklare).** Vendora fyller i villkoren i formuläret och skickar en ifyllnadslänk. Motparten fyller i företagsuppgifter, kontakter och (för RA/RB) undertecknare, kan föreslå andra värden på de kommersiella villkoren, och kan skriva kommentarer om avtalstexten och bifoga sin kommenterade kopia (PDF, Word, Excel eller text). Bilagan hamnar bland avtalets filer, kommentarerna visas för Vendora i flödespanelen och på granskningssidan, och säljarens notismejl tar med båda. Inskicket uppdaterar samma arkivpost (status `submitted`). Vendora granskar på granskningssidan (`#review=`), beslutar per förslag (Accept / Keep mine), sparar och godkänner för underskrift.

**Granskningsflödet "Vendora-first" (nuvarande huvudflöde).** Startas från arkivposten (flödespanelen under formuläret). Steg:

1. Jämför kundavtal och anpassa vårt avtal: ladda upp motpartens dokument (PDF, Word, Excel, text), eller välj ett dokument som redan ligger på avtalet, till exempel det motparten bifogade via sin länk (förvalt). Avtalsadvokaten föreslår ändringar i vårt avtal, punkt för punkt, och importförslag av företagsuppgifter. Vendora godkänner eller avstår varje punkt. Riskvillkor ("hard no") kräver dokumenterat särskilt godkännande.
2. Kundens komplettering: "Skicka till kunden för granskning" skickar ifyllnadslänken (en version per utskick). Kundens svar kommer tillbaka som beslutspunkter; kundens villkorsförslag ändrar aldrig avtalet automatiskt. Ett inskick per utskickad version; senare försök sparas som `agreement_submission_conflicts` och motparten får besked om att uppgifterna redan är inne.
3. Granska återkoppling: alla punkter beslutade, "Kvar före slutgodkännande" tom.
4. Motpartens underskrift.
5. Vendoras underskrift.

Varje steg i flödet skriver en version (se avsnitt 6). Kortet längst ner i formuläret följer avtalets läge: ifyllnadslänk för nytt utkast, väntan medan kunden har länken, "Approve & send for signature" när uppgifterna är inne, signeringsvyn när avtalet är ute.

**Tillbaka till startsidan.** Loggan högst upp till vänster är en länk till startsidan: avtalstyperna (Distributor, Reseller, Reseller Simplified) med tomma formulär, som direkt efter inloggning. Osparade ändringar bekräftas först. Ett avtal öppnat från mejlets länk (`#workflow=id`) hålls öppet över omladdningar tills man lämnar det med loggan eller Cancel i redigeringsraden; Cancel tar bort avtalet ur adressfältet men lämnar formulärets värden kvar.

## 4. Livscykel och lås

Statusar: `draft` → `invited` → `submitted` → `generated` → `sent` → `pending_signature` → `signed`. Dessutom `imported` (post skapad från länk) och `vendora_signed` (kvar från den äldre ordningen där VD signerade först).

Låst innehåll: från `sent` till `signed`, och allt som bär Vendoras signatur. En sparning mot en låst post nekas (409) och visas tydligt i gränssnittet; inget dokument kan laddas ner som arkivet inte har. Återkalla ("withdraw") öppnar avtalet igen (`generated`), motpartens länk slutar fungera, eventuell Vendora-signatur upphävs och VD meddelas.

## 5. Signering

Ordning: motparten först, VD sist.

- Vendora godkänner versionen och skickar signeringslänken (`#agreementcopy=id.token`). Sidan är publik, kräver ingen inloggning och visar den frysta versionen, med undertecknarens namn och e-post förifyllda. För en distributör är undertecknaren kontakten under "General Management / Authorised Signatory".
- Motparten signerar elektroniskt (namn, titel, e-post, valfri ritad signatur, bekräftelse; tid, IP och exakt version stämplas i avtalet) eller skriver ut, signerar och laddar upp kopian. Vendora kan också ladda upp en kopia som kommit per mejl.
- VD (`SIGNER_EMAIL`, namn `SIGNER_NAME`) får mejl och kontrasignerar i appen (`#sign=id`), eller returnerar avtalet med kommentar. Då blir det `generated` igen och motpartens signatur är ogiltig.
- Fullt signerat: motparten mejlas en nedladdningslänk, säljaren ett besked.

Påminnelser kan skickas från arkivpanelen medan kunden har en länk (`invited` eller `sent`).

## 6. Arkivet

Listan visar alla avtal (admin ser allt, övriga sina egna) med status, datum, åtgärdsknappar. Arkivpanelen för ett öppnat avtal visar:

- stegremsan "Created → Customer details → Review & adjust → Counterparty signs → Vendora signs → Fully signed" med nästa steg i klartext,
- status (manuellt byte möjligt utanför låset), signaturläge, uppladdade filer, påminnelse,
- **versionshistorik**: varje ändring är en version med vem, när, åtgärd, status och hela innehållet. Varje version kan laddas ner som den var (`…_v3.docx`), jämföras med föregående (ändrade villkor, gammalt → nytt) och, medan avtalet är redigerbart, återställas. Återställning kastar aldrig något: det ersatta innehållet ligger kvar som egen version. Poster från före historiken får sitt senaste läge som "baseline" vid första ändringen. Flödesposter kan laddas ner men inte återställas från historiken; de ändras genom flödet.

Sparade avtalsgranskningar ("Contract reviews") listas också i arkivet och kan öppnas igen.

## 7. Avtalsadvokaten (AI)

- Jämförelse av motpartens dokument mot vårt avtal med förslag på ändrad lydelse, klassificerade (deal breaker, negotiate, red flag, acceptable). Körs som bakgrundsjobb med strömmad utdata.
- Import av motpartens företagsuppgifter från dokumentet, att godkänna fält för fält.
- "Hard no"-villkor: accepterande kräver dokumenterat särskilt godkännande (`counselApproval`).
- Chatt i formuläret med förslag som kan föras in i avtalet.
- Verifiering av ett uppladdat avtal mot planen (vad som är infört, saknas, avviker).
- Förslag till anteckning i spelboken (`playbook`) med vägledning och noteringar.

Alla AI-anrop sker på servern med `ANTHROPIC_API_KEY`; modell via `ANTHROPIC_MODEL`.

## 8. Mejl som skickas

Skickas via Gmail API med servicekonto (`GOOGLE_SERVICE_ACCOUNT_JSON`, `MAIL_FROM`) eller SMTP som reserv. Avsändarfel syns för Vendora och admin kan skicka testmejl.

| Händelse | Till | Ämne (ungefär) |
| --- | --- | --- |
| Ifyllnadslänk | motparten | "Granska och komplettera avtalet — Vendora Nordic AB" |
| Motparten har skickat in | säljaren | notis med granskningslänk |
| Skickat för underskrift | motparten | "Agreement ready for your signature: … — Vendora Nordic AB" |
| Motparten signerat | VD | "Ready for your signature: … — <motpart>" |
| Motparten signerat | säljaren | "Signed by <motpart>: …" |
| VD signerat | motparten och säljaren | "Fully signed: …" |
| VD returnerat | säljaren | "Returned for changes: …" |
| Återkallat efter VD-signatur | VD | "Signature voided: …" |
| Påminnelse | motparten | "Reminder …" |

## 9. Datamodell (Postgres)

- `users`: id, email, name, google_sub, onboarded_at.
- `agreements`: id, type, counterparty_name, counterparty_email, data (jsonb, hela avtalet), status, status_updated_at, update_token (ifyllnadslänk), signature_token (signeringslänk), signature_sent_at, signature_summary, signature_requested_by/_name/_at, signature_note, counterparty_signed_at/_by/_file, vendora_signed_by/_email/_at, last_reminder_at, created_by/_name, created_at, updated_at, workflow_state (jsonb, flödets tillstånd), workflow_revision (versionsräknare).
- `agreement_versions`: agreement_id, revision, data, workflow_state (null utanför flödet), actor, action, status, note, created_at. Primärnyckel (agreement_id, revision).
- `agreement_files`: uppladdade och signerade dokument (filnamn, mime, innehåll, uppladdad av).
- `agreement_submission_conflicts`: avvisade upprepade inskick från motparten (sent_version, submission, reason).
- `contract_reviews`: sparade AI-granskningar.
- `settings`, `ai_notes`: spelbokens vägledning och anteckningar.

Schemat skapas och migreras vid start (`db.init()`), i en transaktion bakom ett rådgivande lås så att flera samtidiga starter inte krockar. Tokens (`update_token`, `signature_token`) lämnar aldrig servern efter att de utfärdats.

## 10. API i grova drag

Inloggade (`/api/agreements…`): skapa, lista, hämta, spara (PUT, nekas låst), radera, statusbyte, filer (lista, ladda upp, hämta, radera), påminnelse, skicka för underskrift, VD-signering, retur, återkallande, versioner (`/versions`, `/versions/:revision`, `/versions/:revision/restore`).

Flödet (`/api/workflow/:id/…`): start, decisions, company-details, apply, rework, invite, counsel-approval, versions, plus `manualSave`, `submit`, `sendForSignature`, `withdraw`, `sign` som anropas via agreements-rutterna när posten är i flödet.

Publika (token-skyddade, hastighetsbegränsade): `/api/invite/:code`, `/api/public-invites/:id`, `/api/agreements/:id/submit`, `/api/agreements/:id/counterparty-files` (motpartens bilaga), `/api/public-agreements/:id` (hämta fryst version), `…/sign` (e-signatur), `…/signed-copy` (uppladdning), `/api/notify`.

AI: `/api/ai/review` (+ `/api/ai/review/:jobId`), `/api/reviews…`, `/api/ai/chat`, `/api/ai/verify-document`, `/api/ai/suggest-note`, `/api/playbook…`.

Övrigt: `/api/auth/google`, `/api/auth/me`, `/api/auth/logout`, `/api/config`, `/api/me/onboarded`, `/api/admin/mail-test`, `/api/export/agreements` (skrivskyddad export med API-nyckel, JSON/CSV), utgående webhook vid skapande och statusbyte (`AGREEMENT_WEBHOOK_URL`).

## 11. Konfiguration (variabelnamn, värden sätts i Railway)

`DATABASE_URL`, `JWT_SECRET`, `GOOGLE_CLIENT_ID`, `ALLOWED_EMAIL_DOMAIN` (standard vendora.se), `ADMIN_EMAILS`, `SIGNER_EMAIL`, `SIGNER_NAME`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `AI_FALLBACKS`, `EXPORT_API_KEY`, `AGREEMENT_WEBHOOK_URL`, `AGREEMENT_WEBHOOK_SECRET`, `AGREEMENT_WEBHOOK_SECRET_HEADER`, `PORT`, `NODE_ENV`.

Utan `DATABASE_URL` kör appen i läget utan arkiv (bara generator och ifyllnadslänk). Utan `GOOGLE_CLIENT_ID` finns ingen inloggning.

## 12. Behörighet och säkerhet

Google-inloggning begränsad till domänen. Admin (`ADMIN_EMAILS`) ser alla avtal och får skapa distributörsavtal; övriga ser sina egna. VD-signering bara för `SIGNER_EMAIL`. Publika sidor nås enbart med token i länken, jämförd i konstant tid, med hastighetsbegränsning. Uppladdningar har gemensam gräns på 50 MB och skydd mot uppblåsta zip-filer. Säkerhetshärdning (rate limiting, säkerhetsrubriker, prompt-injection-skydd) gjordes i PR 8–9.

## 13. Tester och CI

`npm test` kör `node --test test/*.js`: enhetstester, API-tester mot en engångsdatabas (`TEST_DATABASE_URL`, måste heta `agreement_test`) och webbläsartester med Chrome/Edge via puppeteer (`CHROME_BIN`). GitHub Actions (`agreement-tests.yml`) kör samma svit med Postgres och Chrome; en separat workflow mäter AI-träffsäkerhet på företagsuppgifter. Läget 2026-10-30: 202 tester, 200 godkända, 2 överhoppade.

## 14. Ändringslogg (mergade PR:ar)

| Datum | PR | Ändring |
| --- | --- | --- |
| 2026-07-04 | 7–14 | AI-omskrivning av klausuler; säkerhetshärdning; enbart Google-inloggning; arkiv med status, filer, påminnelser |
| 2026-07-14 | 15 | Granskningsflöde med redigerbara uppgifter och Avtalsadvokat före generering |
| 2026-09-25 | 16–19 | VD-signeringsflöde, försättsblad, synlighet per säljare; onboarding och guide; DA endast admin |
| 2026-09-29 | 20–23 | Två spelböcker, granskning av motpartsavtal som bakgrundsjobb, guide |
| 2026-10-06 | 24–25 | Mejl via Gmail API med servicekonto; synliga mejlfel och testmejl |
| 2026-10-08 | 26–28 | Skrivskyddad export och webhooks; DA Appendix 2 fraktvillkor |
| 2026-10-12 | 29 | Sparade avtalsgranskningar |
| 2026-10-14 | 30–35 | Avtalsadvokatens förslag på hela avtalet; verifiering av uppladdat avtal; arkivknappar; Plaud-portalens utseende |
| 2026-10-15 | 36 | Obligatorisk avtalstyp, RA §13B/§13C, godkännande av nya klausuler |
| 2026-10-27 | 47 | Inbjudan bekräftas i modal, tillbaka till startsidan |
| 2026-10-27 | 48 | Signeringsordning: motparten först, VD sist |
| 2026-10-27 | 49 | Avtalet öppnas på nästa steg, stegremsa |
| 2026-10-27 | 50 | Motpartens signeringssida kräver aldrig Vendora-inloggning |
| 2026-10-28 | 51 | Rättelser på ett låst avtal går aldrig förlorade tyst |
| 2026-10-30 | 52 | Versionshistorik för alla avtal, nedladdning och återställning |
| 2026-10-30 | 53 | Distributörens undertecknare är General Management-kontakten; territoriet visas rätt; kortet längst ner följer avtalets läge |
| 2026-10-30 | 54 | Motparten får besked att uppgifterna är inne och kan inte skicka in två gånger |
| 2026-10-30 | 55 | Jämförelsesteget läser kalkylblad med kommentarer |
| 2026-10-30 | 56 | Schemat sätts upp bakom ett lås så att samtidiga starter inte krockar |
| 2026-10-30 | 57 | Valfria MDF-komponenter visas bara när de är satta |
| 2026-10-30 | 58 | Schemalåset blir ett sessionslås: varje sats committas för sig, inga dödlås mot pågående anrop |
| 2026-10-30 | 59 | Systemöversikten (detta dokument) |
| 2026-10-30 | 60 | Motparten kan kommentera avtalstexten och bifoga sitt dokument på ifyllnadssidan; jämförelsesteget tar dokument som redan ligger på avtalet |
| 2026-10-30 | 61 | Loggan leder till startsidan; Cancel släpper avtalet ur adressfältet |

Öppna, ej från detta arbete: PR 37 (import av återförsäljaruppgifter) och PR 41 (sparat advokatminne och bilagor, röd CI).

## 15. Kända luckor och förslag

- Avvisade upprepade inskick från motparten sparas men syns inte i gränssnittet. Förslag: lista dem i flödespanelen med "Ta in uppgifterna".
- VD får signeringsförfrågan automatiskt när motparten signerat. Vill man ha ett kontrollsteg hos säljaren först behöver det byggas.
- Tider i gränssnittet visas i UTC utom i versionshistoriken, som visar lokal tid.

## 16. Lärdomar från Troubadour (oktober 2026)

Ett avtal ute för underskrift är låst. Rättelser gjorda på granskningssidan medan det var låst laddades ner som dokument men sparades aldrig, och felet syntes inte. Det gav tre regler som nu gäller i koden: inget dokument laddas ner som arkivet inte har; låset visas och återkallande erbjuds där man står; varje ändring blir en version som kan hämtas tillbaka. Dessutom: formuläret visar exakt det som är sparat (territoriet), distributörens undertecknare behöver inga egna fält, och motparten får tydligt besked när inskicket är gjort.
