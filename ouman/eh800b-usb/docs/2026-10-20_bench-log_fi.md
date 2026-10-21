<!-- Bench log of the first EH-800B USB session (20.10.2026, Finnish), copied as background material.
     It describes the earlier prototype script; the current script and its behaviour are in ../README.md.
     Device address and id are masked. -->

# Ouman EH-800B ↔ Shelly Pill USB:n kautta (CH376S): penkkitulos 2026-10-20

Tila: **luku ja kirjoitus toimivat live-laitteella (penkki)**. Mittaukset (28 riviä) ja kaikki 220 asetusta (`GET PROPERTY`) luetaan, ja `SET PROPERTY` muuttaa säätöä (todennettu venttiilin liikkeellä).

## Laitteet
- Pill `shellypill-<mac>` (<pill-ip>), fw 2.0.1, `js_uart`, Serial 9600 8N1
- HW-252 CH376S -moduuli, IC-versio **0x41** (riittää host-siirtoihin)
- Ouman **EH-800B V3.0.0**, FreeRTOS V5.2.0, Actuator XHALOMO, USB VID:PID eb03:0920. Penkillä: ei antureita (paitsi kiinteä menovesi), ei venttiiliä.

## Kytkentä (todennettu)
| Pill | HW-252 |
|---|---|
| IO1 (TX) | H1-alarivi "S" **rxd** |
| IO2 (RX) | H1-alarivi "S" **txd** |
| GND | H1 **gnd** |
| — | H2 +5V / GND = moduulin syöttö ja USB-A:n VBUS |

- P_S-jumpperi tehtaan asennossa, H2:ssa ei baudijumpperia → 9600.
- **Virhe 1. kytkennässä:** H2:n RD- ja WR-pinnit ovat rinnakkaisväylän strobeja, eivät UART-pinnejä → nolla vastausta.
- Kun P_S-jumpperia tai kytkentää muutetaan, moduulin virta katkaistava (tila luetaan käynnistyksessä).
- D1-LED (ACT#) palaa, kun USB-laite on kiinni ja host-tila on päällä.

## CH376S-protokolla (todennetut tavujonot, jokainen komento `57 AB <cmd>`)
1. `05` RESET_ALL → `06 55` → `AA` → `15 06` → `51 15` (laite kiinni) → `15 07` / `15 06` (bus reset)
2. `4D` AUTO_CONFIG → `14`
3. `0B 25 00` SET_RETRY (NAK → ei uusintaa, skripti pollaa itse)
4. SET_LINE_CODING 115200 8N1: `2C 08 21 20 00 00 00 00 07 00`, `4E 00 0D` → 14; `2C 07 00 C2 01 00 00 00 08`, `4E 40 01` → 14; status `4E 80 09` → 14
5. **SET_CONTROL_LINE_STATE DTR+RTS (pakollinen):** `2C 08 21 22 03 00 00 00 00 00`, `4E 00 0D` → 14, `4E 80 09` → 14. Ilman tätä laite kuittaa OUTin mutta NAKkaa (`2A`) kaikki IN-pyynnöt.
6. DTR:n jälkeen laite lähettää bannerin `* OUMAN EH-800 * command prompt *`.
7. Bulk OUT EP1: `2C <len> <ascii>\n` + `4E <00|40> 11` → 14 (toggle bitti 6)
8. Bulk IN EP2: `4E <00|80> 29` → 14 = data (`27` RD_USB_DATA0 → len + data, toggle bitti 7), 2A = NAK. Vastaus on valmis, kun dataa on tullut ja sen jälkeen 4 peräkkäistä NAKia.
- Konfiguraatiodescriptorin luku `46 02` → `17` (BUF_OVER, 67 > 64 B); ei tarvita.

## Ouman-komentotulkki (V3.0.0)
- Rivinvaihto vastauksissa `\r\n`. Komennot ASCII + `\n`.
- `?`-lista kuten 2.2.2:ssa. **Dokumentoimattomat:** `GET` → `GET TIME`, `GET IPCNFIG`, `GET PROPERTY`; `SET` ilman argumentteja → `SET CLOCK/DATE/DAY/IP/NETMASK/GATEWAY/PORT/PROPERTY variable value`.
- **`GET PROPERTY <id>`** = sivuvaikutukseton luku. Numeerinen: `PROPERTY(134):'L1_HIENOSAATO_VESI'(65496-40) = 0` (min/max/arvo uint16, negatiivinen = x−65536). Teksti: `PROPERTY(131):'L1_SAATOPIIRIN_NIMI' = Patterilämmitys` (ei aluetta).
- **`SET PROPERTY <id> <raw>`** → sama vastausmuoto uudella arvolla. Todennettu: 134 = 5 (+0,5 °C) → venttiilitavoite 7 %, asento 7,4 %; 134 = 0 → takaisin 0 %.
- `SET PROPERTY <id>` ilman arvoa ei muuta mitään, tulostaa käyttöohjeen.
- `GET TIME` → `TIME: 1 20.10.2026 20:00:26`; `GET IPCNFIG` palauttaa B-mallissa vain ohjeen.
- Tuntematon komento → `Unknown command\r\nB:\`.
- Ominaisuuksia 220 kpl, id 1–257, aukkoja (0, 27, 78, 80, 104, 105, 165, 167, 191, 192, 227–229, 231–244, 246–256). Ethernet-mallissa todennäköisesti enemmän (artepe: 269).
- MEASUREMENTS = 28 riviä. objects.dat tällä laitteella **3182 B** (artepe 3192, mcgurk 3172) → firmiskohtainen; ei tarvita, koska GET PROPERTY kattaa asetukset.

## Pill fw 2.0.1 -havainto
UART RX toimii vain bootin jälkeen ensimmäisenä ajetussa UART-skriptissä. Kun toinen UART-skripti käynnistetään, se ei saa tavuja ennen kuin Pill käynnistetään uudelleen. Tuotannossa ei ongelma (yksi skripti), kehityksessä Pill on käynnistettävä uudelleen skriptien välissä.

## Skripti
`ouman_eh800_usb.shelly.js` (prototyyppi, ei repossa):
- alustus + CDC-kättely, automaattinen uudelleenyhdistys
- MEASUREMENTS 15 s välein + yksi `GET PROPERTY` CFG.PROPS-listalta per kierros (59, 127, 134, 102, 81, 54, 55, 130, 61, 63, 65, 91, 230)
- HTTP `/script/6/ouman` (tila: vals, named, props), `?cmd=` whitelist: MEASUREMENTS, DEVINFO, OSINFO, TIME, LIST, GET TIME, `GET PROPERTY n` (aina), `SET PROPERTY id raw` vain kun ALLOW_WRITE ja id ∈ WRITE_OK (54, 55, 67, 69, 71, 73, 75, 91, 126, 127, 134; ei PID 56–58, ei 92). `?dump=<off>` = viimeisimmän TYPE-vastauksen heksadumppi.
- `CFG.LAB=true` (vain penkki) sallii kaikki komennot paitsi FORMAT, DELETE, DOWNLOAD, RENAME, FIRMWARE, PTESTER, KEYECHO, UPLOAD.
- MQTT `ouman/state` (retained), `ouman/prop/<id>` (retained), `/diag`, `/set` {"cmd":...}; MQTT pois päältä → pelkkä HTTP
- Apuskriptit: `pill_upload.py`, `pill_eval.py`, `ouman_cmd.py`, `ouman_scan.py` (GET PROPERTY -skannaus → `props_scan.jsonl`, `props_eh800b_v300.tsv`)

## Avoimet
- MEASUREMENTS-rivit 2–6, 8, 14, 17–18, 19, 22–27 vielä osin tunnistamatta (ks. taulukko)
- Tekstiominaisuuksien kirjoitus (`SET PROPERTY 131 <teksti>`?) — ei kokeiltu
- Ohjaustila 59 / 133 / 132 merkitykset (0…6) ja kotona/poissa 230 — kartoitettava näyttöä vasten
- VC-roolit (`ouman`-domain) + HA discovery; WRITE_OK-listan laajennus
- Kello: `TIME` näytti 19:4x `2012-5-1 0:52`, `GET TIME` klo 20:00 `20.10.2026 20:00:26` → selvitettävä, eri kello vai asetettiinko välissä

## MEASUREMENTS-rivit (EH-800B V3.0.0, penkkikokeet 2026-10-20)
Todennettu = anturia lämmitetty/jäähdytetty ja rivin muutos havaittu.

| Rivi | Merkitys | Peruste |
|---:|---|---|
| 1 | Menovesi käyrän mukaan | nousee heti, kun hetkellinen ulkolämpö laskee (15,8 → 37,9) |
| 7 | Laskennallinen menoveden asetusarvo | seuraa käyrää nousunopeusrajoitettuna (~0,3 °C / 15 s) |
| 9 | **L1 menovesi** | todennettu: käsi 20,2 → 29,1 |
| 10 | **Ulkolämpötila** | todennettu: kylmä vesi 18,7 → 1,5 |
| 11 | Hidastettu ulkolämpötila | seuraa riviä 10 hitaasti |
| 12 | Huonelämpötila | −999,9 kun huonemittaus päällä ilman anturia (= anturivika) |
| 13 | Hidastettu huonelämpötila | 6,5 samassa tilanteessa |
| 14 | Huonekompensoinnin vaikutus? | −6 samassa tilanteessa |
| 15 / 16 | L1-venttiilin tavoite / asento % | 0/0 kun meno > asetus; 20/19,7 kun meno 21,7 < asetus 26,4 |
| 18 | ? | −999,9 huonemittaus päällä ilman anturia |
| 19, 27 | Käyrä viiveellä / ennakoitu? | seuraavat riviä 1 viiveellä; 39,3 kun ulko 1,5 |
| 20 | Menoveden asetusarvo (127) | vakio 15,0 |
| 21 | Ulko − hidastettu ulko | −0,6 → −15,8, täsmää r10 − r11 |
| 28 | Digitaalitulo | |

- **−999,9 = anturivika / puuttuva anturi.**
- Kesätoiminnon raja (91 = 4 °C) näyttää käyttävän hidastettua ulkolämpöä: venttiili pysyi kiinni, vaikka hetkellinen ulko < 4 °C ja r11 ~15 °C.
- Mittaus 3:n valinta valikosta ei näy ominaisuuksissa 6/7 (pysyivät 0) → kanavatyyppi tallennetaan muualle (objects.dat?).
- Ulkoanturin irrotus/kytkentä aiheuttaa hälytyspiippauksen. Hälytyksen aikana lukuskripti kaatui **out_of_memory**-virheeseen → RX-puskurit rajattu (2 kB, TYPE 4 kB) ja last_out 600 merkkiin. Skripti ei käynnisty itsestään OOM:n jälkeen → tuotantoon tarvitaan watchdog (esim. toinen skripti / KVS-lippu) tai luotettava muistiraja.
- HW-252: IO1-johdon irtoaminen → CH376S ei vastaa; moduulin virran katkaisu tarvitaan. Tuotantoon: moduulin 5 V Pillin ohjaaman kytkimen taakse, jotta skripti voi resetoida sen.

## Lisälöydökset 2026-10-20 ilta (id > 274, tjani8/mhumaloja-listat)
- **Numerointi on sama kuin EH-800:n Ethernet-rajapinnassa** (`S_<id>_85`, tjani8/ouman-eh-800-home-assistant `registers.md`). USB `GET PROPERTY` kattaa asetukset (1–257, 327–422), mutta **ei mittausobjekteja 258–326** (esim. 259 L1 meno, 261 huone, 272 venttiili, 275 pyyntö, 283 **paluuvesi**) → ne näkyvät USB:llä vain MEASUREMENTS-riveinä, ja paluuvesi puuttuu MEASUREMENTSista kokonaan. Id:t 1000–1010 (toimitilateksti) eivät myöskään vastaa.
- **Kanavan tyyppi = mittausobjektin id:** 44 `MITTAUKSEN_1_TYYPPI` = 227 (ulko), 346 `MITTAUKSEN_2_TYYPPI` = 259 (L1 meno), 6 `MITTAUKSEN_3_TYYPPI` = **261** (huone), 7 `MITTAUKSEN_4_TYYPPI` = **283** (paluuvesi) valikkomuutoksen jälkeen. Ensimmäinen luku heti muutoksen jälkeen antoi vielä 0.
- 24 `MITT4_TUNNISTUS_OK` = 1 kun anturi on kytketty, 23 = 0 (kanava 3) vaikka huone luetaan → merkitys epäselvä.
- **Ohjaustapa 59** (tjani8): 0 Automaatti, 1 Pakko lämmönpudotus, 2 Pakko suuri lämmönpudotus, 3 Pakko normaalilämpö, 5 Alasajo, 6 Käsiajo sähköinen (asento = 92). L2 vastaavasti 146 / 179.
- **Kotona/poissa 135** (`L1_PAIKALLINEN_KP`): 0 kotona, 1 poissa, 2 ei käytössä (mhumaloja). L2 = 222.
- **Lämmitystapa 130:** 0 kosteat tilat, 1 lattia normaali, 2 patteri normaali, 3 patteri jyrkkä, 4 vakiolämpötilasäädin (penkillä 3).
- Ethernet-rajapinta kirjoittaa näyttöyksiköissä (`21.0`), USB `SET PROPERTY` raaka-arvoina (`210`).
- Id:t 369–371: firmis palauttaa nimen tilalle alustamatonta muistia. 420 `VAYLA_MITT1_NIMI` sisältää virheilmoitustekstin. 401/402/405 = web-tunnus/salasana/portti selväkielisinä (B-mallissa tehdasarvot).
- Id-alueet: rele 329–345, 361–364; mittaus 5/6 351–360; huuhtelu 374–377; IP 389–405; hybridi 407–418.
- **Skriptin kestävyys:** kaksi kaatumista korjattu: (1) non-UTF-8-tavu → `JSON.stringify` heittää → `safeStr()`; (2) `Number()` liian pitkälle merkkijonolle heittää → pituusraja + try/catch.
- **Paluuvesikoe:** 112 = 15 (paluuvesi 10 °C) → r7 +9,9 °C (= 2,0 × 5) → kompensointi toimii, mutta sillä ei ole omaa MEASUREMENTS-riviä. Palautettu 112 = 7.
- **MEASUREMENTS-hypoteesi (tjani-objektien mukaan):** r1 = 260 L1 käyrä, r2 = 263 huonekomp., r3 = 264 aikakorjaus, r7 = 275 L1 pyyntö, r9 = 259, r10 = 227, r11 = 228, r12 = 261, r13 = 262, r15 = 272, r16 = 273, r19 = 294 **L2 käyrä**, r27 = 310 **L2 pyyntö** (L2-käyrä 58/41/18 → ulko 0,6 °C:ssa 40,3 ✓). Muut L2-rivit todennäköisesti 17–28.
- **Varaaja kanavassa 4:** 7 `MITTAUKSEN_4_TYYPPI` = 237 (= `S_237_85` Varaajanlämpö). Lukema (47,5 °C näytöllä) ei näy MEASUREMENTSissa eikä `GET PROPERTY 237`:llä. 20 kΩ (~10 °C) laukaisi varaajan alarajahälytyksen (36 = 40 °C).
- **trend.log:** `TYPE trend.log` katkeaa aina 200 tavuun (tekstikomento, katkeaa johonkin sisällön tavuun) → koko tiedosto vain `UPLOAD` + XModem-CRC:llä. Ensimmäiset tietueet vahvistavat rakenteen: `[ulko, meno, m3, m4, m5, ?, venttiili, ?]` int16/10, tyhjä kanava = −9999 (`F1D8`). → Lisäkanavat (paluuvesi, varaaja ym.) saatavissa trendistä; näytteenottoväli 26 (30…21600 s) kirjoitettavissa.
- **XModem-luku toimii (22:10–22:20):** `TREND`-komento → `UPLOAD trend.log` → 'C' → 226 × 133 B pakettia CRC-tarkistettuna, 0 virhettä, 28 928 B (= 226 × 128, loppu 0x1A-täytettä), ~2–2,7 s/paketti (pullonkaula CH376S:n 9600 baudin UART) → koko tiedosto ~8–10 min. Uusin tietue (max epoch):
  `D4E4D76A 0A00 D100 FC00 DB01 F1D8 0000 0200 0000` → `[1.0, 20.9, 25.2, 47.5, -999.9, 0, 2, 0]` = **ulko, L1 meno, mittaus 3 (huone 25,2), mittaus 4 (varaaja 47,5 ✓), mittaus 5 (ei EXU), ?, L1 venttiili % (2), ?**.
  → **Lisäkanavat luettavissa trendistä.** Epoch = säätimen paikallinen aika UTC-epochina (1792533716 = 20.10. 22:01:56 paikallista).
  Uusin tietue oli 22:01 vaikka luku päättyi 22:20 → tiedosto ei välttämättä päivity flashiin joka 10 min; selvitettävä (tai valitaan uusin epoch-ajan mukaan, kuten nyt).
- Nopeutus: CH376S `SET_BAUDRATE` (0x02) 115200:aan + Pillin Serial-baudin vaihto (vaatii UART-kahvan uudelleenhaun, ks. "Bad JsUart handle") → arviolta ~10× nopeampi.
- **Paluuvesi trendistä todennettu (22:51):** uusin tietue 22:41:56 → `[4.1, 20.8, 25.2, 9.9, -999.9, 0, 0, 0]` → mittaus 4 = paluuvesi 9,9 °C (20 kΩ, näyttö 10 °C) ✓. Kenttä 3 seuraa kanavan 4 tyyppiä (varaaja 47,5 → paluuvesi 9,9).
- **115200 baudia:** HW-252 H2-jumpperi GND:hen → 115200. **Moduulin reset vaatii sekä 5 V:n että Oumanin USB-kaapelin irrotuksen** (moduuli saa takasyöttöä USB:n kautta) → Pillin ohjaama reset vaatii myös VBUS-linjan katkaisun. Pill: `Serial.SetConfig` baud 115200 + `CFG.BAUD`.
- **Skriptin ajoitus:** kiinteät odotukset korvattu tavumäärään perustuvalla valmistumisella (`q(..., exp)`): status 1 B, RD_USB_DATA0 len+1. Aikakatkaisut 300–400 ms (eivät hidasta). Tyhjä status → uusi yritys eikä katkos. XModem 226 pakettia ~5 min (~1,3 s/paketti, rajoittaa Oumanin oma tahti). Pillin HTTP hidastuu siirron aikana (CPU kuormassa).
- **trend.log päivittyy viiveellä:** luku 22:20 → uusin 22:01; luku 22:51 → uusin 22:41.
- **Jäänne-XModem:** jos siirto katkeaa (Pill reboot kesken), Ouman lähettää myöhemmin EOT:n (0x04), joka päätyi seuraavan DEVINFOn vastaukseksi → initiin XModem-peruutus (CAN 0x18 ×3) + tyhjennys ennen ensimmäistä komentoa.
- **Paluuveden luku USB:llä:** ainoa ehdokas on `trend.log` (28 822 B, 20 B/tietue, tavut 8–15 tunnistamatta) → vaatii UPLOAD/XModem-toteutuksen tai suuremman TYPE-puskurin.

## Ominaisuuskartta (EH-800B V3.0.0, penkkiarvot)
Raaka-arvot: lämpötilat yleensä 0,1 °C (esim. 150 = 15,0 °C), poikkeuksena kokonaislukuasteet (hälytysrajat 0…95, kesäsulku).

| id | nimi | alue | arvo (penkki) |
|---:|---|---|---|
| 1 | PUDOTUKSEN_ESTO | -50…0 | -45 |
| 2 | KOTONA_POISSA_KYTKIN_KAYTOSSA | 0…1 | 0 |
| 3 | KIELI | 0…10 | 0 |
| 4 | HALYTYSLOKIN_TYHJENNYS | 0…1 | 0 |
| 5 | SMS_HALYTYSNRO_1 | teksti | (tyhjä) |
| 6 | MITTAUKSEN_3_TYYPPI | 0…0 | 0 |
| 7 | MITTAUKSEN_4_TYYPPI | 0…0 | 0 |
| 8 | MITTAUKSEN_5_TYYPPI | 0…0 | 0 |
| 9 | MITTAUS_3_NIMI | teksti | Mittaus 3 |
| 10 | MITTAUS_4_NIMI | teksti | Mittaus 4 |
| 11 | HALYTYKSEN_4_AKTIIVITILA | 0…0 | 0 |
| 12 | SANOMAKESKUS | 0…0 | 0 |
| 13 | OPERAATTORI_NRO | teksti | (tyhjä) |
| 14 | PIN_KOODI | teksti | (tyhjä) |
| 15 | LAITETUNNUS | teksti | (tyhjä) |
| 16 | SMS_HALYTYSNRO_2 | teksti | (tyhjä) |
| 17 | LUKITUSKOODI_TILA | 0…0 | 0 |
| 18 | LUKITUSKOODI | teksti | 0000 |
| 19 | KUIVAUSARVO | 0…0 | 0 |
| 20 | SMS_TILA | 0…4 | 0 |
| 21 | ENSIKAYNNISTYS | 0…1 | 0 |
| 22 | MODEEMIN_TILA | 0…1 | 0 |
| 23 | MITT3_TUNNISTUS_OK | 0…1 | 0 |
| 24 | MITT4_TUNNISTUS_OK | 0…1 | 0 |
| 25 | MITT5_TUNNISTUS_OK | 0…1 | 0 |
| 26 | TRENDI_PAIVITYS_JAKSO | 30…21600 | 600 |
| 28 | HALYTYS_4_NIMI | teksti | Hälytys 4 |
| 29 | KESKILAMPO_TUNTI | 0…0 | 19 |
| 30 | KESKILAMPO_PAIVA | 0…0 | 20 |
| 31 | KESKILAMPO_LASKURI | 0…0 | 1 |
| 32 | NYK_VUOROKAUDEN_KESKILAMPOTLA | 0…0 | 196 |
| 33 | ED_VUOROKAUDEN_KESKILAMPOTLA | 0…0 | 181 |
| 34 | PIN_TARKISTETTU | 0…0 | 0 |
| 35 | SYYSK_OFF_PAIVALASKURI | 0…20 | 94 |
| 36 | VARAAJA_ALARAJAHAL | 0…95 | 40 |
| 37 | VARAAJA_YLARAJAHAL | 0…95 | 95 |
| 38 | KATTILA_ALARAJAHAL | 0…95 | 30 |
| 39 | KATTILA_YLARAJAHAL | 0…95 | 70 |
| 40 | MITT3_ALARAJAHAL | 0…95 | 5 |
| 41 | MITT3_YLARAJAHAL | 0…95 | 95 |
| 42 | MITT4_ALARAJAHAL | 0…95 | 5 |
| 43 | MITT4_YLARAJAHAL | 0…95 | 95 |
| 44 | MITTAUKSEN_1_TYYPPI | 0…0 | 227 |
| 45 | ULKOL_TUNNISTUS_OK | 0…1 | 0 |
| 46 | MITT1_HAL_LASK | 0…0 | 0 |
| 47 | MITT2_HAL_LASK | 0…0 | 0 |
| 48 | MITT3_HAL_LASK | 0…0 | 0 |
| 49 | MITT4_HAL_LASK | 0…0 | 0 |
| 50 | CURRENT_DAY | 0…0 | 0 |
| 51 | SETTINGS_NIMI | teksti | Laiteasetukset |
| 52 | NAYTON_KAANTO | 0…0 | 0 |
| 53 | NAYTON_KONTRASTI | 50…100 | 75 |
| 54 | L1_SAATIMEN_MENOVEDEN_MINIMI | 50…950 | 120 |
| 55 | L1_SAATIMEN_MENOVEDEN_MAKSIMI | 50…950 | 600 |
| 56 | L1_SAATIMEN_P_ALUE | 2…600 | 250 |
| 57 | L1_SAATIMEN_I_AIKA | 5…300 | 50 |
| 58 | L1_SAATIMEN_D_AIKA | 0…100 | 0 |
| 59 | L1_SAATIMEN_OHJAUSTILA | 0…6 | 0 |
| 60 | L1_SAATIMEN_KAYRAN_TYYPPI | 0…1 | 0 |
| 61 | L1_KAYRAN_MENOVESI_3A | 0…1000 | 560 |
| 62 | L1_KAYRAN_ULKOLAMPO_3A | -500…500 | -200 |
| 63 | L1_KAYRAN_MENOVESI_3B | 0…1000 | 410 |
| 64 | L1_KAYRAN_ULKOLAMPO_3B | -500…500 | 0 |
| 65 | L1_KAYRAN_MENOVESI_3C | 0…1000 | 140 |
| 66 | L1_KAYRAN_ULKOLAMPO_3C | -500…500 | 200 |
| 67 | L1_KAYRAN_MENOVESI_5A | 0…1000 | 630 |
| 68 | L1_KAYRAN_ULKOLAMPO_5A | -500…500 | -200 |
| 69 | L1_KAYRAN_MENOVESI_5B | 0…1000 | 540 |
| 70 | L1_KAYRAN_ULKOLAMPO_5B | -500…500 | -100 |
| 71 | L1_KAYRAN_MENOVESI_5C | 0…1000 | 440 |
| 72 | L1_KAYRAN_ULKOLAMPO_5C | -500…500 | 0 |
| 73 | L1_KAYRAN_MENOVESI_5D | 0…1000 | 320 |
| 74 | L1_KAYRAN_ULKOLAMPO_5D | -500…500 | 100 |
| 75 | L1_KAYRAN_MENOVESI_5E | 0…1000 | 180 |
| 76 | L1_KAYRAN_ULKOLAMPO_5E | -500…500 | 200 |
| 77 | L1_ULKOLAMPOTILAMITTAUKSEN_AIKAVAKIO_NOUSEVALLE | 0…15 | 1 |
| 79 | L1_SISALAMPOTILAMITTAUKSEN_AIKAVAKIO_NOUSEVALLE | 0…20 | 20 |
| 81 | L1_HUONEASETUSARVO | 0…950 | 210 |
| 82 | L1_HUONEKOMPENSOINNIN_ASETUSARVO | 0…70 | 40 |
| 83 | L1_HUONEKOMPENSOINNIN_I_ASETUSARVO | 0…70 | 10 |
| 84 | L1_HUONEKOMPENSOINNIN_I_MAKSIMIRAJA | 1…150 | 60 |
| 85 | L1_SYYSKUIVAUS_HUONE | 1…50 | 10 |
| 86 | L1_SYYSKUIVAUS_MENOVESI | 1…150 | 30 |
| 87 | L1_HUONE_PUDOTUS_1 | 0…900 | 15 |
| 88 | L1_HUONE_PUDOTUS_2 | 0…900 | 50 |
| 89 | L1_MENOVESI_PUDOTUS_1 | 0…900 | 40 |
| 90 | L1_MENOVESI_PUDOTUS_2 | 0…900 | 150 |
| 91 | L1_SAATIMEN_KESASULUN_RAJA | 5…95 | 4 |
| 92 | L1_KASIAJO_ASENTO | 0…100 | 20 |
| 93 | L1_HIENOSAADON_KALIBR_VESI | 5…20 | 10 |
| 94 | L1_MOOTTORIN_TOIMISUUNTA | 0…1 | 1 |
| 95 | L1_ESIKOROTUSAS_AIKA | 1…10 | 1 |
| 96 | L1_ESIKOROTUSOPPIVUUS | 0…100 | 50 |
| 97 | L1_ESIKOROTUSAS_VESI | 1…250 | 0 |
| 98 | L1_MENOVEDEN_MAKS_POIKKEAMA | 1…20 | 10 |
| 99 | L1_HUONELAMPOTILAN_MAKS_POIKKEAMA | 0…100 | 30 |
| 100 | L1_MENOVEDEN_POIKKEAMAHAL_VIIVE | 0…120 | 60 |
| 101 | L1_HUONELAMPOTILAN_POIKKEAMAHAL_VIIVE | 0…120 | 60 |
| 102 | L1_HIENOSAATO_HUONE | -40…40 | 10 |
| 103 | L1_HIENOSAATO_VAIMENNUSPISTE | 0…170 | 70 |
| 106 | L1_HIENOSAADON_KALIBR_HUONE | 5…20 | 10 |
| 107 | L1_HUONEKOMPENSOINNIN_MAKSIMI_VAIKUTUS | 50…950 | 150 |
| 108 | L1_SAATIMEN_MENOVEDEN_MINIMI_20 | 0…50 | 15 |
| 109 | L1_VAPAA_PUDOTUS_0 | 0…50 | 10 |
| 110 | L1_VAPAA_PUDOTUS_20 | 0…50 | 15 |
| 111 | L1_VAPAA_PUDOTUS_HUONE | 0…40 | 7 |
| 112 | L1_PALUUVEDEN_MINIMIRAJA | 5…95 | 7 |
| 113 | L1_PALUUVEDEN_MINIMIRAJA_20 | 5…95 | 10 |
| 114 | L1_PALUUVEDEN_MAKSIMIRAJA | 5…95 | 95 |
| 115 | L1_PALUUVESIKOMPENSOINTI | 0…40 | 20 |
| 116 | L1_LATTIALAMMITYKSEN_ENNAKONTI | 0…6 | 2 |
| 117 | L1_KESASULUN_VIIVE | 0…20 | 10 |
| 118 | L1_SYYSKUIVAUS_ULKOL_RAJA | 0…15 | 8 |
| 119 | L1_HUONE_ALARAJAHAL | 0…950 | 80 |
| 120 | L1_HUONE_JAATYMISHAL | 0…950 | 50 |
| 121 | L1_HUONE_YLARAJHAL | 0…95 | 35 |
| 122 | L1_VESI_ALARAJAHAL | -10…95 | 16 |
| 123 | L1_VESI_JAATYMISHAL | 0…95 | 12 |
| 124 | L1_VESI_YLARAJHAL | 0…95 | 63 |
| 125 | L1_PALUUVESI_ALARAJAHAL | 0…95 | 4 |
| 126 | L1_MENOVEDEN_MAKS_MUUTOSNOPEUS | 1…50 | 40 |
| 127 | L1_MENOVEDEN_ASETUSARVO | 0…950 | 150 |
| 128 | L1_KUIVATUKSEN_NOSTONOPEUS | 0…500 | 10 |
| 129 | L1_KUIVATUKSEN_NOSTORAJA | 0…95 | 30 |
| 130 | L1_LAMMITYSTAPA | 0…5 | 3 |
| 131 | L1_SAATOPIIRIN_NIMI | teksti | Patterilämmitys |
| 132 | L1_TILAN_ASETTAJA | 0…0 | 2 |
| 133 | L1_OHJAUS | 0…0 | 3 |
| 134 | L1_HIENOSAATO_VESI | -40…40 | 0 |
| 135 | L1_PAIKALLINEN_KP | 0…2 | 0 |
| 136 | L1_VIIMEISIN_OHJAUS | 0…3 | 135 |
| 137 | L1_PALUUVESI_YLARAJAHAL | 0…95 | 95 |
| 138 | L1_ESIKOROTUSAS_AIKA_KORJAUS | 0…200 | 100 |
| 139 | L1_KOTONA_POISSA_MENOVESI | 0…200 | 40 |
| 140 | L2_KAYTOSSA | 0…0 | 0 |
| 141 | L2_SAATIMEN_MENOVEDEN_MINIMI | 50…950 | 120 |
| 142 | L2_SAATIMEN_MENOVEDEN_MAKSIMI | 50…950 | 750 |
| 143 | L2_SAATIMEN_P_ALUE | 2…600 | 250 |
| 144 | L2_SAATIMEN_I_AIKA | 5…300 | 50 |
| 145 | L2_SAATIMEN_D_AIKA | 0…100 | 0 |
| 146 | L2_SAATIMEN_OHJAUSTILA | 0…6 | 0 |
| 147 | L2_SAATIMEN_KAYRAN_TYYPPI | 0…1 | 0 |
| 148 | L2_KAYRAN_MENOVESI_3A | 0…1000 | 580 |
| 149 | L2_KAYRAN_ULKOLAMPO_3A | -500…500 | -200 |
| 150 | L2_KAYRAN_MENOVESI_3B | 0…1000 | 410 |
| 151 | L2_KAYRAN_ULKOLAMPO_3B | -500…500 | 0 |
| 152 | L2_KAYRAN_MENOVESI_3C | 0…1000 | 180 |
| 153 | L2_KAYRAN_ULKOLAMPO_3C | -500…500 | 200 |
| 154 | L2_KAYRAN_MENOVESI_5A | 0…1000 | 580 |
| 155 | L2_KAYRAN_ULKOLAMPO_5A | -500…500 | -200 |
| 156 | L2_KAYRAN_MENOVESI_5B | 0…1000 | 500 |
| 157 | L2_KAYRAN_ULKOLAMPO_5B | -500…500 | -100 |
| 158 | L2_KAYRAN_MENOVESI_5C | 0…1000 | 410 |
| 159 | L2_KAYRAN_ULKOLAMPO_5C | -500…500 | 0 |
| 160 | L2_KAYRAN_MENOVESI_5D | 0…1000 | 300 |
| 161 | L2_KAYRAN_ULKOLAMPO_5D | -500…500 | 100 |
| 162 | L2_KAYRAN_MENOVESI_5E | 0…1000 | 180 |
| 163 | L2_KAYRAN_ULKOLAMPO_5E | -500…500 | 200 |
| 164 | L2_ULKOLAMPOTILAMITTAUKSEN_AIKAVAKIO_NOUSEVALLE | 0…5 | 2 |
| 166 | L2_SISALAMPOTILAMITTAUKSEN_AIKAVAKIO_NOUSEVALLE | 0…20 | 20 |
| 168 | L2_HUONEASETUSARVO | 0…950 | 210 |
| 169 | L2_HUONEKOMPENSOINNIN_ASETUSARVO | 0…70 | 40 |
| 170 | L2_HUONEKOMPENSOINNIN_I_ASETUSARVO | 0…70 | 10 |
| 171 | L2_HUONEKOMPENSOINNIN_I_MAKSIMIRAJA | 1…150 | 60 |
| 172 | L2_SYYSKUIVAUS_HUONE | 1…50 | 10 |
| 173 | L2_SYYSKUIVAUS_MENOVESI | 1…150 | 30 |
| 174 | L2_HUONE_PUDOTUS_1 | 0…900 | 15 |
| 175 | L2_HUONE_PUDOTUS_2 | 0…900 | 50 |
| 176 | L2_MENOVESI_PUDOTUS_1 | 0…900 | 60 |
| 177 | L2_MENOVESI_PUDOTUS_2 | 0…900 | 160 |
| 178 | L2_SAATIMEN_KESASULUN_RAJA | 5…95 | 19 |
| 179 | L2_KASIAJO_ASENTO | 0…100 | 20 |
| 180 | L2_HIENOSAADON_KALIBR_VESI | 5…20 | 10 |
| 181 | L2_MOOTTORIN_TOIMISUUNTA | 0…1 | 1 |
| 182 | L2_ESIKOROTUSAS_AIKA | 1…10 | 1 |
| 183 | L2_ESIKOROTUSOPPIVUUS | 0…100 | 50 |
| 184 | L2_ESIKOROTUSAS_VESI | 1…250 | 40 |
| 185 | L2_MENOVEDEN_MAKS_POIKKEAMA | 1…20 | 0 |
| 186 | L2_HUONELAMPOTILAN_MAKS_POIKKEAMA | 0…100 | 30 |
| 187 | L2_MENOVEDEN_POIKKEAMAHAL_VIIVE | 0…120 | 60 |
| 188 | L2_HUONELAMPOTILAN_POIKKEAMAHAL_VIIVE | 0…120 | 60 |
| 189 | L2_HIENOSAATO_HUONE | -40…40 | 0 |
| 190 | L2_HIENOSAATO_VAIMENNUSPISTE | 0…170 | 70 |
| 193 | L2_HIENOSAADON_KALIBR_HUONE | 5…20 | 10 |
| 194 | L2_HUONEKOMPENSOINNIN_MAKSIMI_VAIKUTUS | 50…950 | 150 |
| 195 | L2_SAATIMEN_MENOVEDEN_MINIMI_20 | 0…50 | 15 |
| 196 | L2_VAPAA_PUDOTUS_0 | 0…50 | 10 |
| 197 | L2_VAPAA_PUDOTUS_20 | 0…50 | 15 |
| 198 | L2_VAPAA_PUDOTUS_HUONE | 0…40 | 7 |
| 199 | L2_PALUUVEDEN_MINIMIRAJA | 5…95 | 7 |
| 200 | L2_PALUUVEDEN_MINIMIRAJA_20 | 5…95 | 10 |
| 201 | L2_PALUUVEDEN_MAKSIMIRAJA | 5…95 | 95 |
| 202 | L2_PALUUVESIKOMPENSOINTI | 0…40 | 20 |
| 203 | L2_LATTIALAMMITYKSEN_ENNAKONTI | 0…6 | 2 |
| 204 | L2_KESASULUN_VIIVE | 0…20 | 10 |
| 205 | L2_SYYSKUIVAUS_ULKOL_RAJA | 0…15 | 7 |
| 206 | L2_HUONE_ALARAJAHAL | 0…950 | 80 |
| 207 | L2_HUONE_JAATYMISHAL | 0…950 | 50 |
| 208 | L2_HUONE_YLARAJHAL | 0…95 | 35 |
| 209 | L2_VESI_ALARAJAHAL | -10…95 | 8 |
| 210 | L2_VESI_JAATYMISHAL | 0…95 | 5 |
| 211 | L2_VESI_YLARAJHAL | 0…95 | 90 |
| 212 | L2_PALUUVESI_ALARAJAHAL | 0…95 | 4 |
| 213 | L2_MENOVEDEN_MAKS_MUUTOSNOPEUS | 1…50 | 40 |
| 214 | L2_MENOVEDEN_ASETUSARVO | 0…950 | 150 |
| 215 | L2_KUIVATUKSEN_NOSTONOPEUS | 0…500 | 10 |
| 216 | L2_KUIVATUKSEN_NOSTORAJA | 0…95 | 30 |
| 217 | L2_LAMMITYSTAPA | 0…5 | 2 |
| 218 | L2_SAATOPIIRIN_NIMI | teksti | Patterilämmitys |
| 219 | L2_TILAN_ASETTAJA | 0…0 | 2 |
| 220 | L2_OHJAUS | 0…0 | 3 |
| 221 | L2_HIENOSAATO_VESI | -40…40 | 0 |
| 222 | L2_PAIKALLINEN_KP | 0…2 | 0 |
| 223 | L2_VIIMEISIN_OHJAUS | 0…3 | 222 |
| 224 | L2_PALUUVESI_YLARAJAHAL | 0…95 | 95 |
| 225 | L2_ESIKOROTUSAS_AIKA_KORJAUS | 0…200 | 100 |
| 226 | L2_KOTONA_POISSA_MENOVESI | 0…200 | 40 |
| 230 | L1_KOTONA_POISSA_KYTKIMEN_TILA | 0…2 | 2 |
| 245 | L1_KP_KYTKIN_SMS_TILA | 0…2 | 2 |
| 257 | SYYSK_ON_PAIVALASKURI | 0…20 | 20 |
