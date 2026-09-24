# Eltrade fiscal device (A3 KL and family)

How to run an Eltrade cash register (A1/A3/A6/B1/B3 KL) or Eltrade fiscal printer from the LGR
POS through the browser (USB → Web Serial). Driver: `packages/fiscal/src/eltrade.ts`.

## 1. On the device

1. Switch it on. In the main menu choose **„1. Регистрация“** — press `1` (or move with `D2`/`D4`)
   and confirm with `TOTAL`. Log in with the operator password if the device asks for it.
   **The ECR only answers the PC in this mode.** In any other mode the USB port opens but nothing
   answers.
2. Plug the USB cable into the POS computer. Windows shows it under *Device Manager → Ports (COM &
   LPT)*. If it appears as an unknown device instead, install Eltrade's USB driver.
3. Speed is 115200 (the device default). Leave the POS baud selector on **115200**.

## 2. In LGR — POS → Devices → New Device

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
- **The fiscal device does not answer** — not in „1. Регистрация“, wrong port, or cable.
- **This device reports serial number X, but it is set up in LGR as Y** — correct the Device
  Number, otherwise every fiscal receipt is rejected.
- **Fiscal device problem: …** — out of paper, clock not set, fiscal memory errors.

The same reading is on demand under *POS → Devices → (device) → Reports → Device Status → Read
Status*.

## 4. Printing

- **"Non-fiscal" ON** (the default): the receipt prints as text on a *СЛУЖЕБЕН БОН*. Nothing is
  registered in the fiscal memory — use this while testing.
- **"Non-fiscal" OFF**: a real fiscal receipt — the УНП, each line at its VAT-inclusive price in
  its Н-18 group (20 % → **Б**, 9 % → **Г**, 0 % → **А**), the payment (cash `P`, card `L`), and the
  receipt number saved on the transaction.
- If a receipt does not print, the sale is still saved and the cashier sees why (out of paper, not
  in „Регистрация“, …) instead of "Sale completed".
- Closing the POS session runs the **Z-report** on the device.

## 5. First-time checklist

Run in this order — only step 5 creates a fiscal record.

1. *Device Status → Read Status*: serial and fiscal-memory numbers are right, the clock is close to
   real time, no errors.
2. Sell something with **Non-fiscal ON** → a service receipt prints.
3. *Reports → Daily X-Report* → prints and does not close the day.
4. Check the product you will sell has the VAT rate you expect (20 % for most goods).
5. Sell one small item with **Non-fiscal OFF** → fiscal receipt: the УНП starts with the device
   number, the line is in group Б, and the POS transaction shows the fiscal receipt number.

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Port not in the picker | Windows has no COM port for it | install Eltrade's USB driver; re-plug |
| "does not answer" / timeouts | not in „1. Регистрация“; wrong port | select the mode (main menu → 1 → TOTAL), pick the right port |
| "serial number … set up as …" | wrong Device Number in LGR | set it to the serial the device reports |
| "not allowed in the current state of the device" | a receipt left open, clock not set, day needs a Z-report, fiscal memory/КЛЕН full | read Device Status; LGR voids a receipt left open by an interrupted sale automatically |
| "No VAT group on the Eltrade is programmed at X %" | product rate matches no programmed group | fix the product's tax rate, or have service check the device rates |
| "Refusing to move the Eltrade clock back" | server time is behind the device by > 5 min | check the server/NTP time; a device clock that is ahead needs service |

Every frame is logged by the API (`Eltrade command SENT` / `Eltrade response received`, with hex) —
attach those lines when reporting a problem.

## 7. What is verified, and what is not

Built from Eltrade's own protocol document (v1.1.1) and cross-checked against ErpNet.FP's Eltrade
driver, which runs against real devices. Tested against `packages/tests/src/helpers/eltrade-simulator.ts`,
a device simulator built from the same document. **Not yet run on a physical A3.** Deliberately
handled both ways because the document is not specific:

- the field layout of the diagnostic answer (serial / fiscal memory are found by shape);
- whether amounts come back with a decimal point or in cents;
- the width of a service-receipt line on 58 mm paper (the POS formats it to 28 characters).
