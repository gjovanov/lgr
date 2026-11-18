# NRA SUPTO Submission Guide

## Prerequisites

1. **Qualified Electronic Signature (КЕП)** — The legal entity (producer/distributor) must have a valid КЕП for the NRA e-services portal
2. **Legal entity registration** — The producing company must be registered in Bulgaria with a valid ЕИК
3. **Legal review** — Have a Bulgarian tax advisor review the implementation
4. **Physical fiscal device testing** — Test with at least one NRA-approved fiscal printer

## Documents Prepared

| Document | File | Purpose |
|----------|------|---------|
| Functional Description (BG) | `FUNCTIONAL-DESCRIPTION.md` | Complete description of SUPTO functionality for NRA review |
| Database Schema (BG) | `DATABASE-SCHEMA.md` | All SUPTO-relevant collections with field descriptions |
| Compliance Checklist | `COMPLIANCE-CHECKLIST.md` | 42-point mapping of Appendix 29 requirements to implementation |

## Submission Process

### Step 1: Producer Declaration (Наредба Н-18, чл. 52в; Приложение № 30/31)

Not Приложение № 32: that is each business's own declaration, in Step 3.

1. Go to https://portal.nra.bg
2. Login with КЕП
3. Navigate to: Фискални устройства, СУПТО и е-магазини → СУПТО → Декларация
4. Fill in:
   - **Наименование на софтуера:** LGR (Ledger) ERP — СУПТО модул
   - **Версия:** (current version from package.json)
   - **Описание:** (paste from FUNCTIONAL-DESCRIPTION.md sections 1-5)
   - **Производител:** (your company name + ЕИК)
5. Attach supporting documents (PDF versions of the docs above)
6. Sign with КЕП and submit

### Step 2: Wait for NRA Review

- NRA reviews the declaration and documentation
- If approved, the software is added to the public SUPTO register: https://inetdec.nra.bg
- Timeline: varies (weeks to months)

### Step 3: User Declarations (per business)

Each business deploying LGR SUPTO must submit their own declaration within **7 days** of installation:
- Declaration type: "Декларация за ползване на СУПТО" (Appendix №32 for users)
- Must reference the registered software name and version
- Must list all commercial locations where the software is used
- Must list all fiscal devices connected to the software

## Pre-Submission Testing Checklist

### Fiscal Device Testing
- [ ] Purchase/borrow a Datecs DP-25 or FP-700 (most common in Bulgaria)
- [ ] Connect via TCP and verify protocol communication
- [ ] Print a test fiscal receipt with УНП
- [ ] Print a test storno receipt
- [ ] Print a Z-report
- [ ] Verify time sync between server and device
- [ ] Test device disconnect/reconnect recovery
- [ ] Test concurrent sales on the same device

### Data Export Testing
- [ ] Generate all 9 Appendix 29 tables with real sales data
- [ ] Verify column content matches specification
- [ ] Test with the built-in NRA Auditor (Read Only) role (`nra_auditor`): it reads and exports, and writes nothing
- [ ] Verify period filters work correctly
- [ ] Verify warehouse/device/operator filters

### Audit Trail Testing
- [ ] Login produces audit entry with operatorCode
- [ ] Logout produces audit entry
- [ ] POS sale produces audit entry with УНП
- [ ] Storno produces audit entry with original УНП
- [ ] Product create/update/deactivate produces audit entries
- [ ] Giving a person another role closes their open `roleHistory` entry and adds one with the role's id and name (`roleId`, `roleName`), and writes an audit entry with the old and the new role
- [ ] Creating, editing or deleting a role writes an audit entry with its capabilities before and after

### Immutability Testing
- [ ] Completed POS transaction cannot be modified or deleted
- [ ] Storno creates new transaction, marks original as cancelled
- [ ] Double-storno of same transaction is rejected
- [ ] Sent invoices cannot be deleted (only voided)
- [ ] Nomenclature items are deactivated, not deleted

### Security Testing
- [ ] A role without `devices.edit` cannot manage fiscal devices, and one without `devices.z-report` cannot print a Z-report (403)
- [ ] A role without `cash-sales.storno` cannot perform a storno or a refund on a credit note (403)
- [ ] NRA Auditor can only read, not write (403 on mutations)
- [ ] A person with no role in the organization cannot sign in to it, and is refused on its routes (403 `no_role`)
- [ ] Server-side total validation rejects mismatched amounts
- [ ] Fiscal device IP validation blocks SSRF attempts

## Version Control

When submitting to NRA, record:
- Git commit hash: `git rev-parse HEAD`
- Software version: from root `package.json`
- Date of submission
- NRA reference number (received after submission)

Keep a copy of the exact code version that was submitted. NRA may request verification that the running software matches the declared version.
