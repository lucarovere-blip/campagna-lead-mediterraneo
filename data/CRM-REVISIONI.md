# CRM SeaInnova — Mappa Boe — Storico Revisioni

## Convenzione naming

```
crm_seainnova_mappa_boe_YYYY-MM-DD_REVN.xlsx
```

- **YYYY-MM-DD**: data del rilascio della revisione
- **REVN**: numero progressivo di revisione (REV1, REV2, REV3, …)

## Storico revisioni

| REV | Data | Commit | Email | Tel | Referenti | Ruoli | Note |
|---|---|---|---|---|---|---|---|
| **REV1** | 2026-05-06 | `1c3d7d3` | 12/68 (18%) | 14/68 (21%) | 0/68 | 0/68 | Export iniziale 68 contatti dal dataset Mappa Boe (ZMEL FR + AMP IT + Sardegna PRRPT) |
| **REV2** | 2026-05-06 | `20d44b5` | 26/68 (38%) | 31/68 (45%) | 5/68 (7%) | 5/68 (7%) | Round 1 contatti certificati: 9 nuovi gestori (PN Calanques, PNF Port-Cros, Plemmirio, Capo Carbonara, Punta Campanella, Asinara, Castellabate/Infreschi, Capo Rizzuto, Mare Azzurro) |
| **REV3** | 2026-05-06 | `55ac330` | 32/68 (47%) | 39/68 (57%) | 7/68 (10%) | 7/68 (10%) | Round 2: +9 voci certificate (Le Lavandou, Bergeggi, Capo Milazzo, Miramare, Tor Paterno, OEC Corse RNBB, Mandelieu, Beaulieu, Piana, Zonza) |
| **REV4** | 2026-05-07 | `f78d6ab` | 33/68 (48%) | 40/68 (58%) | 15/68 (22%) | 11/68 (16%) | Round 3: direttori AMP italiane (Tavolara: Augusto Navone, Egadi: Salvatore Livreri Console, Cinque Terre: Patrizio Scarpellini, Capo Caccia: Mariano Mariani, Tremiti: Vincenzo Totaro, Capo Testa diretto, Cannes Port Moure Rouge) |
| **REV5** | 2026-05-07 | `48a28a8` | 33/68 (48%) | 40/68 (58%) | 17/68 (25%) | 15/68 (22%) | **Round 4 — corrente**: Sophie-Dorothée DURON Direttrice PNF Port-Cros (lead caldissimo Porquerolles 354 boe) + email dedicata `mouillages.porquerolles@portcros-parcnational.fr` + Alberico Simeoli Direttore Punta Campanella + Massimo Marras Direttore Sinis + PNRC Corse contatti |

## File correnti

- **Versione corrente**: `data/crm_seainnova_mappa_boe_2026-05-07_REV5.xlsx`
- **Versioni precedenti**: `data/storico_revisioni/`

## Come generare una nuova revisione

```bash
# Da terminale (Mac/Linux con Python 3 + openpyxl):
python3 scripts/build-crm-excel.py
```

Lo script:
1. Legge i dati certificati da `data/zmel-fr-med.json` + `data/amp-it.json` + `data/sardegna-prrpt.json`
2. Auto-incrementa il numero REV in base a quelli esistenti
3. Sposta la versione corrente in `storico_revisioni/`
4. Crea il nuovo file con data odierna + REV nuovo

## Struttura colonne (compatibile CRM SeaInnova v2)

18 colonne identiche al CRM principale:
1. # — Numero progressivo
2. Ente
3. Referente — Nome persona
4. Ruolo — Direttore, Presidente, ecc.
5. Email
6. Telefono
7. Prodotti — Es. "Betty Buoys, Sentinel"
8. Zona — Località + regione
9. Score (0-10)
10. Stato — da_contattare, contattato, email_inviata, ecc.
11. Priorita — alta, media, bassa
12. Data Contatto
13. Fonte — `mappa_boe_app` o `mappa_boe_app_PRRPT2024`
14. Stato Bozza — nuovo, inviata, bozza_pronta, in_enrichment
15. Oggetto Email
16. Data Bozza
17. Data Invio
18. Note Followup

## Color coding score

| Colore | Score | Significato |
|---|---|---|
| 🔵 Blu | 10 | Cliente CRM esistente Betty Buoys |
| 🟠 Arancio | 9 | Lead caldissimo (PNRR / in progetto / capacità >=100) |
| 🟡 Giallo | 8 | Lead caldo (operativo con contatti) |
| 🩵 Azzurro | 7 | Tiepido |
| ⚪ Bianco | 6 | Info parziali |

## Lead top-10 da contattare per primi (REV5)

1. **Sophie-Dorothée DURON** — PNF Port-Cros et Porquerolles · `mouillages.porquerolles@portcros-parcnational.fr` (354 boe progetto 2028)
2. **Eloïse Faure** — PN Calanques · ☎ +33 4 20 10 50 00
3. **Augusto Navone** — AMP Tavolara cliente · `segreteria@amptavolara.it` ☎ +39 0789 203013
4. **Alberico Simeoli** — AMP Punta Campanella cliente · `info@puntacampanella.org` (PNRR €2,3M, +200 boe)
5. **Salvatore Livreri Console** — AMP Egadi cliente · `info@ampisoleegadi.it` (espansione PNRR)
6. **Mariano Mariani** — AMP Capo Caccia · `info@parcodiportoconte.it` (150 boe)
7. **Vittorio Gazale + Aldo Zanello** — AMP Asinara cliente (`zanello@asinara.org`)
8. **Florence MILLONI** — Capitainerie Le Lavandou · `capitainerie@le-lavandou.fr` (71 boe)
9. **Capitainerie Port Saint-Pierre Hyères** · `contact@portshyeres.fr` (49 boe nuove 2026)
10. **Comune Zonza** ☎ +33 4 95 71 40 16 (mega progetto 402 boe 5 siti)
