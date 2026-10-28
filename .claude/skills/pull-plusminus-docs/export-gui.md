# Exporting from PlusMinus over Roomler remote desktop

The export is GUI-only: PlusMinus has no CLI, and its data files and logs are encrypted.
This is the procedure from the operator's recording of 2026-10-26, as replayed that night.
Every action here is **read-only in PlusMinus**: ОТВОРИ, Експорт/ЕКСПОРТ, ИЗВЕДИ, filters, tab ×.
The form buttons beside Експорт (Запиши, Изпрати, Анулиране, ИЗТРИЙ, ПРОМЕНИ) change documents.

## Before connecting

- **Someone may be using the PC**: staff during the day, family in the evening.
  A live remote session shows as fresh `DC pump heartbeat` lines:
  `roomler exec 6a61228270bf9a4044cd615c -- 'cmd /c "roomler logs --grep heartbeat -n 3"'`.
  One stamped in the last minute is someone else's session: ask the operator, never take over.
- **Browser**: Claude in Chrome, the browser signed in to roomler.ai (the operator picks it when
  several are connected). Work in a new tab.

## Connect

1. Navigate to `https://roomler.ai/`.
2. Run `fetch('/api/tenant')`; the tenant named `Grox` holds the device.
3. `document.querySelector('#app').__vue_app__.config.globalProperties.$router.push('/tenant/<grox id>/agent/6a61228270bf9a4044cd615c/remote')`.
4. Click the viewer's own button by DOM: `document.querySelector('[data-tour="viewer-connect"]').click()`.
   Text-matching "Connect" can hit another device's rail link.
5. The canvas is 1920×1080, letterboxed into the stage. Get the stage from the canvas rect.
   With a 1699×888 viewport (1512×790 screenshots), remote `(X, Y)` lands at screenshot
   `(315 + 0.595·X, 136 + 0.595·Y)`.
6. `zoom` on a target before clicking it, and again after, to read the result.

## How input behaves through the viewer

- **Only ASCII arrives as typed text.** The PC's active layout is EN-US, so Cyrillic typed through
  the viewer is dropped and only `-` of `-ФЕ` lands. Choose Cyrillic values from dropdowns with
  the keyboard (`Down`×N, `Return`).
- **Menus open on hover and stay open while the cursor is over them.** After a menu click,
  hover somewhere neutral (mid-grid) before the next screenshot.
- **The top-right corner holds close buttons**: PlusMinus's own −/□/× sit at the far right of its
  dark bar (remote x ≈ 1880–1905), and Excel's × sits in the same place. Move the cursor away
  after every click there.
- **The grid scrolls with the wheel** once the window has focus (click a row first). The arrow
  keys and PageDown do not scroll it.
- **The extension can drop mid-batch.** Re-read the screen before repeating anything. A repeated
  Export only rewrites the same file.

## The journal: what the day contains

Операции → **Журнал на документите** (usually already open as a tab). Set both date fields to the
day (calendar picker; today is preselected). Clear **Тип** (click it, `End`, `BackSpace`×6,
`Return`) to list every type, then read every row (scroll):

| Тип | what it is | PDF it exports |
|---|---|---|
| `-ФЕ` | sales invoice; credit notes too | `invoicem_<N>.pdf` |
| `СТ` | stock receipt, incl. `2000 КОРЕКЦИЯ` corrections | `stokrazp_<N>.pdf` |
| `СР` | transfer to the other РЕГАЛ store | `sklrazp_<N>.pdf` |
| `СИ` | write-off искане | `sklisk_<N>.pdf` (not yet exported this way, check the toast) |
| `-ПП`, `-ПС` | protocols created with an invoice (comment `-ФЕ N … от …`) | none needed |

Done when every `-ФЕ`/`СТ`/`СР`/`СИ` number of the day is written down: that list is the
completion criterion for the whole export.

To filter one type: clear Тип as above, then `Down`×N and `Return`, with N from the dropdown order:
`+ФЕ` 1 · `-П` 2 · `-ПП` 3 · `-ПС` 4 · `-ФЕ` 5 · `-ФЕА` 6 · `-ФП` 7 · `ББ` 8 · `БР` 9 · `ЗП` 10 ·
`КБ` 11 · `КП` 12 · `МО` 13 · `ОФ` 14 · `П` 15 · `П79` 16 · `ПА` 17 · `ПКО` 18 · `ПР` 19 · `РКО` 20 ·
`СИ` 21 · `СР` 22 · `СТ` 23. Typing `-` first narrows the list, and then `-ФЕ` is `Down`×4.
Zoom on the list to confirm the highlighted value before `Return`.

## Each document

1. Click the row, then **ОТВОРИ** (top-left). The form opens in a new tab (Фактура продажба,
   Стокова разписка, Складова разписка).
2. Zoom the form's header: the number must be the row's.
3. **Експорт**, bottom-right of the form's side panel (invoice: Запиши · Печат · **Експорт** ·
   Изпрати · Изчисти). A toast names the file:
   `Документът е записан във файл: exports/docs/РЕГАЛ ООД/<type>_<N>.pdf`. Zoom it and check the number.
4. Export also opens a **PDF** preview tab. Close it, then close the form tab. Each tab's × moves
   with its title width, so zoom the tab bar to find it. Back on the journal, the filter is kept.

## The till: salesAnalysis

Справки → **Анализ на продажбите** → **АРТИКУЛИ** (left list, under Обобщени данни). Check
ПЕРИОД `ДНЕС`, ОБЕКТ `СКЛАД - 1`, ИЗВЕЖДАНЕ `ДЪРВОВИДНО`, ПЪЛЕН ПЪТ `НЕ`. Then **ЕКСПОРТ** (top
right). The toast reads `exports/salesAnalysis_<yyyyMMdd_HHmmss>.xlsx`. `ДНЕС` is the PC's today:
for a past day, set the period instead (not yet done this way).

## The stock snapshot: storeAvailability

Справки → **Наличност**. In the side panel, keep `Подробна` · `Избрани складове` ·
`ОБЕКТИ:СКЛАД - 1` and **tick „Извеждане на стоките с нулеви количества"**. The tick does not
persist between runs. Then **ИЗВЕДИ**, wait for the spinner to clear, and click **ЕКСПОРТ** (top
bar). The toast reads `exports/storeAvailability_<stamp>.xlsx`.

Without the tick the file silently omits every zero-quantity product (2026-10-26: 15,954 rows
instead of 22,857), even though the screen still shows blank-quantity rows.
`check-snapshot.ts` catches it after the pull.

Export the snapshot **last**: it is the day's arbiter only if it postdates the day's last document.

## Excel opens every report export

Close it with its ×, top right. A report you only opened closes without a prompt. A prompt means
something changed: choose not to save. A file left open leaves a `~$…` lock in `exports\`,
which `pull.sh` reports.

## regal-sf (Sofia store) — differences from regal-pz

Confirmed 2026-10-27, combining a screen recording (no audio, 1366×768, captured locally on the
machine — not through the Chrome viewer), live API calls, and direct confirmation from the user
on the one point the data alone couldn't settle. Device: **Regal-Dechko-SO**, hex id
`6a687648c8141b25961ebde6` (`regal_ssh.txt`). `roomler ssh`/`exec` were already enabled there as
of that day (confirmed live — `regal_ssh.txt`'s note that they might need bootstrapping was
either stale or already done).

⚠ **Same company name, same EIK, genuinely different install.** The top bar reads "РЕГАЛ ООД"
and the invoice footer shows the same EIK 112500982 as regal-pz — but this is **not** the same
`pmserver.exe`. Proven live: an unfiltered `documents()` call against regal-pz's own server
(100.65.4.26:7000), for two full days, returns **zero** of regal-sf's known document numbers, and
the one object name the two happen to share by coincidence — `ОБЕКТИ:СКЛАД` (regal-pz's is
`ОБЕКТИ:СКЛАД - 1`, with the suffix) — is confirmed **empty** (0 products via `items()`) on
regal-pz's server.

⚠ **What `СТ` and `СР` mean here took three passes to get right — the short version is in
`pull-plusminus-api/orgs.ts`'s regal-sf entry; this is the fuller record, kept because the wrong
turns are as instructive as the answer.** First pass: read "СТ" off a web screenshot as
ambiguous/possibly Latin "CT." Second pass: read a *different*, zoomed Excel screenshot as "СР,"
and matched that family to the journal list's `2222036xxx` numbers shown earlier in the same
recording — wrong pairing, not a misread this time, just the wrong report matched to the wrong
number series. Third pass, after the user flagged a conflict between that reading and an
existing, production-validated memory note: fetched full `document()` JSON, found a numeric
`operations[].type` field (1 = stock in, 2 = stock out — confirmed against regal-pz's own
known-direction samples), read the actual printed PDF content directly, and asked the user to
settle what the data alone couldn't. The real mapping:
- **`СТ` (→ `stokrazp`) = goods receipts**, same meaning as regal-pz, direction given by the
  quantity's sign (same convention both stores, per the user). Printed title literally says
  "СТОКОВА РАЗПИСКА за получаване на стоки"; `operations[].type` was `1` on every sample checked.
  13-14 docs/day, numbered `2222036xxx` — these are the ones the journal-list screenshots showed.
- **`СР` (→ `storeOperations`) = cash-register sales**, a *different* real-world meaning than
  regal-pz's own "СР" (store-to-store transfer) — but the **same stock direction** (both are
  stock OUT), which is exactly what made the wrong pairing above look plausible for a while. Per
  the user directly: *"sklrazp in pz is used for movement out e.g. transfer from pz to sf, and
  sklrazp in sf is used for cash register sales (also movement out but via CRS)."* Much larger,
  smaller-ticket family: 42/35 docs/day, numbered ~`21427-21503`, most carrying a comment linking
  back to a same-sale `-ФЕ` invoice (e.g. `" -ФЕ 2000129222"` — till receipt + fiscal invoice for
  one purchase, a normal pairing). This is the family the Складови операции/Продажби GUI report
  and memory `lgr-regal-sf-org`'s "storeOperations-Продажби" note were both describing correctly
  the whole time. ⚠ Each record's `header.sum` is VAT-inclusive (what the customer paid);
  `lines[].sum` is net. The aggregate xlsx's own printed total is net and matches
  Σ(`lines[].sum`) to the cent — comparing against Σ(`header.sum`) instead looks ~20% off for no
  real reason (verified 2026-10-27: 410.29 computed vs 410.30 printed using lines, 492.34 using
  header, 35 records).

Don't carry regal-pz's type→meaning table to this store either way, and don't trust a screenshot
reading (however careful, however zoomed) over live `documents()` JSON or a structured field.

**The till register — regal-sf has no "Анализ на продажбите" step; use Складови операции
instead:** Справки → **Складови операции**. Период = the day, Операция = **Продажби**,
Справка за = Избрани складове, Склад = **ОБЕКТИ:СКЛАД** (no "- 1" suffix), Тип на док. = Всички.
**ИЗВЕДИ**, then **ЕКСПОРТ** (top bar). Toast: `exports/storeOperations_<yyyyMMdd_HHmmss>.xlsx`.

**The stock snapshot** — same screen and shape as regal-pz: Справки → **Наличност**, Склад =
**ОБЕКТИ:СКЛАД**, **ЕКСПОРТ**. Toast: `exports/storeAvailability_<yyyyMMdd_HHmmss>.xlsx`. The
result already showed blank-quantity rows for several products without an explicitly observed
zero-quantity tickbox click in the recording — **unconfirmed whether this store's Наличност panel
even has the regal-pz tickbox, or defaults to including zero-qty rows**; run `check-snapshot.ts`
against the pull before trusting it either way, same as for regal-pz.

**Invoices** (`-ФЕ`) are a disjoint number series from regal-pz's: `2000129xxx` here vs
`3000101xxx` there. `-ФЕА` (credit/debit notes) not yet observed for this store.

**No sklisk (write-off) type observed** in two full days — matches memory `lgr-regal-sf-org`'s
"no sklrazp/sklisk family at all" (that note predates today's `sklrazp`-is-actually-`storeOperations`
finding above; read together they mean: no write-offs here, and what reads as "sklrazp" in the
raw type code is the till register, not a transfer).

⚠ **Individual per-document PDF exports of a `СР`/cash-sale record would print as "СКЛАДОВА
РАЗПИСКА"** (the vendor client's fixed title for anything it treats as `sklrazp`, regardless of
what that type code means at a given store — see `_getTitle()`/`_generatePartnerData()` in the
embedded client JS) — misleading if read at face value, but **harmless for the existing import
pipeline**: `services/biz/doc-import/xlsx.ts`'s `parseStoreOperations` branches on the
`Операция:` label read straight from the aggregate xlsx's own header cell, never on a type code
or a per-document PDF title, specifically so this isn't a detail it has to get right per org.
Only matters if something is ever built to read individual PDFs or raw type codes directly
instead of the aggregate report.

**Server and credentials — resolved 2026-10-27, by asking rather than guessing further.**
`https://192.168.0.103:7000` — a private LAN address, confirmed unreachable directly from outside
that network (unlike regal-pz's Tailscale-range `100.65.4.26`). Reachable through
`roomler forward --agent 6a687648c8141b25961ebde6 --local <port> --remote 192.168.0.103:7000 --daemon`,
then point at `https://127.0.0.1:<port>` — proven live this way (company confirmed via
`companies()` as the same 3-space `"РЕГАЛ   ООД"` string regal-pz uses; stock snapshot via
`items("ОБЕКТИ:СКЛАД")`: 26,722 products, 9,129 with qty > 0; `document()` content-fetch
confirmed on a real `-ФЕ`, `СТ` and `СР` record). Credentials are the **same admin account as
regal-pz**, per the user directly — not a guess, not shared by assumption the way the earlier
same-server hypothesis was (and was wrong). Full detail: `pull-plusminus-api/orgs.ts`'s regal-sf
entry.

**The GUI client's own install path is NOT `C:\plusminusPOS 1` here — it's `C:\plusminus7`**
(confirmed via `where /r C:\ plusminus.exe` on the device, not guessed from the server's own
folder — those are two different, unrelated paths even on the SAME machine at regal-pz:
server=`C:\pmserver`, client=`C:\plusminusPOS 1`). `pull.sh` and `pull.ps1` were hardcoded to
regal-pz's path and have been generalized — pass **`--pm-root 'C:\plusminus7'`** for this store:

```bash
bash pull.sh --device 6a687648c8141b25961ebde6 --pm-root 'C:\plusminus7' --dest .../_docs/regal-sf --day 2026-10-27
```

Run end-to-end 2026-10-27: this device already had a real export history going back to 2025
sitting in `exports\` (nobody had pointed `pull.sh` at it before) — 2026-10-26 was a complete day
(36 invoicem + 14 stokrazp PDFs + both xlsx reports, byte-verified, zero gaps); 2026-10-27 only
had one of each PDF individually exported (a demo), though both xlsx reports for the full day
exist. There is no individual-PDF export of the `СР`/cash-sale family at all — `storeOperations_*.xlsx`
is its only form.

## Disconnect

DOM-click the viewer's DISCONNECT, then close the tab at once. Parallel sessions share the
browser, and an open remote page of an online device can be connected by any of them.
