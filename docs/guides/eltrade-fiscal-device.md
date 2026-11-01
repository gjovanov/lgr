# Eltrade fiscal device (A3 KL and family)

How to run an Eltrade cash register (A1/A3/A6/B1/B3 KL) or Eltrade fiscal printer from the LGR
POS through the browser (USB → Web Serial). Driver: `packages/fiscal/src/eltrade.ts`.

## 1. On the device

1. Switch it on and leave it at its main menu. With USB connected the rear display shows
   „Връзка с PC“, which is normal. A non-fiscalized A3 KL answered the PC from its main menu in the
   2026-09-26 field test; „1. Регистрация“ was not needed. If a device stays silent, take it back
   to the main menu (out of any sub-menu) before anything else.
2. Plug a **data** cable into the device's **USB (micro-USB) socket**. The mini-USB-shaped socket
   next to it is **RS232**, not USB, and a charge-only cable produces no USB event at all. Both
   look like a dead device. Windows lists the A3 as *USB Serial Device (COMn)* (USB ID
   `03EB:6119`) under *Device Manager → Ports (COM & LPT)*. If it appears as an unknown device
   instead, install Eltrade's USB driver.
3. Speed is 115200 (the device default). Leave the POS baud selector on **115200**.

## 2. In LGR — Invoicing → Configuration → Devices → New Device

| Field | Value |
|---|---|
| Name | anything, e.g. `Каса 1 — Eltrade A3` |
| Device Number | the device's serial number (**ИН на ФУ**, printed on every receipt), e.g. `ED123456` |
| Manufacturer | `eltrade` |
| Connection Type | `browser` |
| Warehouse | the warehouse this till sells from |

The device number matters: every УНП starts with it, and the device refuses a receipt whose УНП
names another device. Each cashier also needs a 4-digit **operator code** on their LGR user — it
is the middle part of the УНП.

## 3. Connect (Chrome or Edge)

POS terminal → **Connect Printer** → pick the Eltrade's port. Every serial port is listed (the
picker used to show only a few USB chip vendors). If more than one browser device is set up for
the warehouse, LGR asks which one this port is.

Right after connecting, LGR reads the device and says one of:

- **Connected: *model* ED123456 (fiscalized / not fiscalized)** — ready.
- **The fiscal device does not answer** — wrong port picked, or the device is inside a sub-menu.
- **This device reports serial number X, but it is set up in LGR as Y** — correct the Device
  Number, otherwise every fiscal receipt is rejected.
- **Fiscal device problem: …** — out of paper, clock not set, fiscal memory errors.

The same reading is on demand under *Invoicing → Configuration → Devices → (device) → Reports → Device Status → Read
Status*.

## 4. Printing

- **"Non-fiscal" ON** (the default): the receipt prints as text on a *СЛУЖЕБЕН БОН*. Nothing is
  registered in the fiscal memory — use this while testing.
- **"Non-fiscal" OFF**: a real fiscal receipt — the УНП, each line at its VAT-inclusive price in
  its Н-18 group (20 % → **Б**, 9 % → **Г**, 0 % → **А**), the payment (cash `P`, card `L`), and the
  receipt number saved on the transaction.
- If a receipt does not print, the sale is still saved and the cashier sees why (out of paper, not
  in „Регистрация“, …) instead of "Sale completed".
- **A cash-on-delivery invoice** prints in slot R as it is issued, and stays due until the courier
  pays. If that print fails, the invoice's form offers „Print the receipt": it prints alone, and
  records no money.
- **A payment on an invoice** prints on the device of the session of whoever takes it (FR-23): an
  invoice issued in cash or by card its lines and „Фактура № …“, any other payment a line per VAT
  rate, „Плащане по фактура № …“. With no open session or no connected device the payment is
  refused, and the refusal says where the switch is: „A sale needs a connected fiscal printer“ in
  Settings → Organization → Cash register. A new organization starts with it off, and turns it on
  when its sales print here.
- **A receipt in doubt.** If the connection or LGR died during a print and nothing can prove what the
  device did, LGR books no money and prints nothing: the document says so, and payment, a change of its
  total and void wait. Look at the device's journal, then open the receipt in „Касови продажби“ and
  press „Отпечатан е“ or „Не е отпечатан“ (a manager or an admin). The session does not close until
  it is done.
- **The device does one thing at a time.** A second print waits its turn, and a report can make it wait
  for minutes; past five and a half it is refused with „device busy“, and nothing printed.
- Closing the POS session runs the **Z-report** on the device.

## 5. The device page (Invoicing → Configuration → Devices → the device)

What an Eltrade can do from here, and what its protocol (v1.1.7) does not have. The page asks the
server what the device's driver supports (`capabilities` on `GET /fiscal/device/:id`, from
`packages/fiscal/src/capabilities.ts`) and disables the rest with the reason.

| Control | Eltrade | Command |
|---|---|---|
| Device Status → Read Status | yes | 4Ah, 5Ah, 3Eh, 71h |
| Daily X-Report / Daily Z-Report | yes (Z: admin or manager) | 45h `2` / `0` |
| FM Report by Date (short / detailed) | yes | 4Fh / 5Eh `DDMMYY,DDMMYY` |
| FM Report by Number (short / detailed) | yes, numbers 1–9999 | 5Fh / 49h `NNNN,NNNN` |
| Operators → Program on Device | yes, operators 1–16 | 66h |
| Operators → Read from Device | **no** — the protocol cannot read an operator back | — |
| Operator Report | **no** — not in the protocol | — |
| Electronic Journal (KLEN) | **no** — not in the protocol | — |
| Payment types → Read from Device | yes, the 11 slots P N C D I J K L M Q R | 55h `<slot>` |
| Payment types → Name R „НАЛОЖЕН ПЛАТЕЖ“ | yes, admin only, audited | 55h `R,НАЛОЖЕН ПЛАТЕЖ` |
| Free text inside a fiscal receipt („Фактура № …“, FR-23) | yes, no control on the page | 36h, up to 46 characters |

The same reports print from **POS Sessions**, from a session's row: an X while the session is open,
the fiscal memory by date (prefilled with the session's days) or by Z number (prefilled with its
Z-report), short or detailed. A closed session prints on the device it closed on. There is no Z
there: a Z runs only through a session's close, and one printed outside it makes the next close
print zeros.

- **A report never touches a receipt that is still printing.** While a sale (or a service receipt)
  is printing, X, Z and every fiscal-memory report are refused with "A sale is printing on this
  device…" (HTTP 409 `receipt_open`): wait for it to finish, then try again. They used to void the
  sale's receipt, or complete it in cash once it was part-paid.
- **A receipt nothing will finish does not block a report.** When the server stopped, or the bridge
  or the connection dropped, in the middle of a sale, the receipt stays open on the device. The next
  report clears it the way the next sale would (voided, or completed in cash if a payment had gone
  through), then prints. Closing the POS session runs the same Z, so the close is not stuck behind
  it. ⚠ A part-paid receipt completed in cash adds cash the drawer never took: the API logs
  `…completing it with the remainder in cash` when that happens.
- **Program on Device**: the password authorises the change — it is the operator's password on the
  device (4–8 digits). Three wrong ones lock the device until it is switched off and on, so LGR
  checks the number, the password's form and the name before anything is sent.
- **Cash on delivery** prints in the reserve slot **R**. Name it „НАЛОЖЕН ПЛАТЕЖ“ once (Payment types
  card, one click) so the receipt says what it was. Every other driver refuses a cash-on-delivery
  payment rather than printing it as cash. The till offers it beside cash and card. The courier
  holds that money, so the session's close shows it as expected, nobody counts it, and it stays out
  of expected cash. A device without the slot refuses the sale before anything is numbered.
- An error says what happened: bad input 400, the device refusing (out of paper, wrong password) 409,
  no device connected 503, no answer 504.

## 6. First-time checklist

Run in this order — only step 5 creates a fiscal record.

1. *Device Status → Read Status*: serial and fiscal-memory numbers are right, the clock is close to
   real time, no errors.
2. Sell something with **Non-fiscal ON** → a service receipt prints.
3. *Reports → Daily X-Report* → prints and does not close the day.
4. Check the product you will sell has the VAT rate you expect (20 % for most goods).
5. Sell one small item with **Non-fiscal OFF** → fiscal receipt: the УНП starts with the device
   number, the line is in group Б, and the POS transaction shows the fiscal receipt number.

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Port not in the picker | charge-only cable, or the cable is in the RS232 socket; or Windows has no COM port for it | a data cable in the micro-USB socket, until Windows lists *USB Serial Device (COMn)*; else install Eltrade's USB driver |
| "The printer's port is in use" (Chrome: "Failed to open serial port") | another tab, window or program holds the COM port: Windows gives it to one at a time | nothing is broken. Keep using the tab that is connected (the others show "connected in another tab", and their sales print through it), or close it and connect here. A tab left open reconnects on its own when the device is switched on |
| "does not answer" / timeouts | wrong port picked; device inside a sub-menu | pick the right port; return the device to its main menu |
| "serial number … set up as …" | wrong Device Number in LGR | set it to the serial the device reports |
| "not allowed in the current state of the device" | a receipt left open, clock not set, day needs a Z-report, fiscal memory/КЛЕН full | read Device Status; LGR voids a receipt left open by an interrupted sale automatically |
| "A sale is printing on this device, so the X-report (or Z-report) was not printed" | a sale (or a service receipt) is printing on the device right now | wait for the sale to finish and try again. A receipt left by an interrupted sale does not cause this: the report clears it |
| "A sale is printing on this device. Wait for it to finish, then close again." | the POS close's Z-report met a sale still printing. Nothing failed: the session stays open and the device is not marked | wait for the sale to finish, then close again |
| Program on Device refused: "not allowed in the current state" | the password is not that operator's on the device | use the operator's own password — after three wrong ones the device must be switched off and on |
| "No VAT group on the Eltrade is programmed at X %" | product rate matches no programmed group | fix the product's tax rate, or have service check the device rates |
| "Refusing to move the Eltrade clock back" | server time is behind the device by > 5 min | check the server/NTP time; a device clock that is ahead needs service |

Every frame is logged by the API (`Eltrade command SENT` / `Eltrade response received`, with hex) —
attach those lines when reporting a problem.

## 8. What is verified, and what is not

Built from Eltrade's own protocol document (v1.1.1, re-checked against v1.1.7) and cross-checked
against ErpNet.FP's Eltrade driver, which runs against real devices. Tested against
`packages/tests/src/helpers/eltrade-simulator.ts`, a device simulator built from the same document.
Status, diagnostics, the clock and a non-fiscal sale were field-verified on a non-fiscalized A3
(2026-09-26); **the reports, operator programming, payment type names and the free text of a fiscal
receipt (36h) have not been run on a physical A3.** 36h is „PRINTING A FREE FISCAL TEXT“ in the
protocol v1.1.1 (up to 46 bytes, framed in `#`, refused with S1.1 when no fiscal receipt is open), and
ErpNet.FP's ISL drivers send comments with it, its Eltrade driver not overriding it. A check on the
device is still owed: where the line lands on the receipt, and that it prints between the sale lines
and the payment. Deliberately handled both ways because the document is not specific:

- the field layout of the diagnostic answer (serial / fiscal memory are found by shape);
- whether amounts come back with a decimal point or in cents;
- the width of a service-receipt line on 58 mm paper (the POS formats it to 28 characters);
- the 55h answer, written `Result\Name` in the document: a bare name, `P`/`F`, or both with a
  separator are all read;
- what an A3 answers to a wrong operator password (the simulator answers "not allowed").
