# LGR СУПТО — Схема на базата данни

## СУПТО-релевантни колекции

### POSSession (POS смени)
| Поле | Тип | Описание |
|------|-----|----------|
| orgId | ObjectId | Организация (тенант) |
| warehouseId | ObjectId | Склад/обект |
| cashierId | ObjectId | Касиер (ref User) |
| sessionNumber | String | Номер на смяна (POS-YYYY-NNNNNN) |
| openedAt | Date | Дата/час на отваряне |
| closedAt | Date | Дата/час на затваряне |
| status | String | open / closed |
| openingBalance | Number | Начално салдо |
| closingBalance | Number | Крайно салдо |
| expectedBalance | Number | Очаквано салдо |
| difference | Number | Разлика |
| currency | String | Валута |
| totalSales | Number | Общо продажби, с боновете за плащане по фактура: това, което устройството е отчело |
| totalReturns | Number | Общо връщания |
| totalCash | Number | Общо в брой |
| totalCard | Number | Общо с карта |
| totalCashOnDelivery | Number | Общо с наложен платеж (при куриера, не е в касата) |
| transactionCount | Number | Брой транзакции |

### Касов документ — `Invoice` с тип `cash_sale` / `cash_storno` (FR-21)

Всяка продажба на касата е документ в колекция `invoices` с тип `cash_sale`, независимо дали е маркирана на касовия терминал, въведена в бек офиса или внесена като ден от PlusMinus. Сторнирането е отделен документ с тип `cash_storno`, който сочи продажбата (`relatedInvoiceId`). Сумите на сторното са положителни, а знакът се определя от типа. Сторнираната продажба остава с всички свои данни и статус `paid` и се отбелязва като сторнирана в `register.stornoState`.

| Поле | Тип | Описание |
|------|-----|----------|
| orgId | ObjectId | Организация |
| invoiceNumber | String | Номер: `CS-YYYY-NNNNN` (или префиксът, настроен за организацията, напр. `CSR`), общ за продажби и сторна. Копираните POS транзакции запазват своя номер `TXN-YYYY-NNNNNNN` |
| type | String | `cash_sale` (продажба) / `cash_storno` (сторно) |
| status | String | `paid`; `voided` — сторно, чийто фискален бон не е отпечатан и което не сторнира нищо |
| contactId | ObjectId | Клиент (ref Contact) |
| issueDate | Date | Дата и час на продажбата |
| currency | String | Валута (на смяната за касовия терминал) |
| exchangeRate | Number | Стойност на една единица от валутата в основната валута на организацията |
| lines[] | Array | Редове на документа |
| lines[].productId | ObjectId | Продукт |
| lines[].description | String | Наименование |
| lines[].quantity | Number | Количество |
| lines[].unit | String | Мярка |
| lines[].unitPrice | Number | Единична цена без ДДС |
| lines[].discount | Number | Отстъпка (%) |
| lines[].taxRate | Number | ДДС ставка (%) |
| lines[].taxAmount | Number | ДДС сума |
| lines[].lineTotal | Number | Сума на реда с ДДС |
| lines[].warehouseId | ObjectId | Склад (за касовия терминал — складът на смяната) |
| subtotal | Number | Сума без ДДС |
| discountTotal | Number | Общо отстъпка |
| taxTotal | Number | Общо ДДС |
| total | Number | Обща сума |
| payments[] | Array | Плащания |
| payments[].method | String | cash / card / bank_transfer / other (mobile и voucher — само в стари записи) |
| payments[].amount | Number | Задържана сума (сборът на плащанията е равен на общата сума) |
| payments[].tendered | Number | Подадена сума, когато се различава (ресто) |
| relatedInvoiceId | ObjectId | За сторно: сторнираната продажба |
| register.origin | String | Произход: `pos` (касов терминал), `backoffice` (бек офис), `import` (внесен ден от PlusMinus) |
| register.sessionId | ObjectId | Смяна (ref POSSession) |
| register.warehouseId | ObjectId | Склад/обект |
| register.cashierId | ObjectId | Касиер (ref User) |
| register.fiscalDeviceNumber | String | Номер на фискално устройство |
| register.operatorCode | String | Код на оператор |
| register.unp | String | УНП (XXXXXXXX-ZZZZ-0000001) |
| register.fiscalReceiptNumber | String | Номер на фискален бон |
| register.printedAt | Date | Дата/час на отпечатване |
| register.isFiscal | Boolean | Фискален бон |
| register.fiscal | Object | Състояние на отпечатването (`state`: pending / printed / failed / unknown / none; `mode`: fiscal / text) и номерът на последния документ на устройството преди отпечатването. По него се установява дали прекъснат бон е отпечатан, така че един бон никога не се отпечатва два пъти |
| register.changeDue | Number | Ресто |
| register.movementId | ObjectId | Складово движение (ref StockMovement); движението сочи документа чрез `invoiceId` |
| register.storno | Object | За сторно: оригинален документ, УНП, фискален бон, дата и причина |
| register.stornoState | String | За продажба: `none` / `full` (сторнирана) |
| register.stornoedBy[] | ObjectId[] | Сторната на продажбата |
| register.cancelledAt | Date | Кога е сторнирана продажбата (за таблица 18.5) |
| register.legacy | Object | За копирана POS транзакция: нейният тип и номер |
| createdBy | ObjectId | Създател (ref User) |
| createdAt | Date | Дата на създаване |

Индекси: `{orgId, type, issueDate}`, `{orgId, register.sessionId}`, `{orgId, register.unp}`; уникални `{orgId, invoiceNumber}` и `{orgId, clientKey}`.

Документите на касовия терминал (`register.origin: pos`) и всяко сторно не могат да бъдат редактирани, изтрити или анулирани (HTTP 409). Коригират се единствено със сторно.

### Бон за плащане по фактура — `Invoice` с тип `payment_receipt` (FR-23)

Фискалният бон за плащане в брой или с карта по издадена фактура или дебитно известие. Продажбата е фактурата: тя изписва стоката и начислява прихода. Бонът е парите: документ на касата със същата структура като касовия документ по-горе, с номер от същата поредица (`CASH_SALE`), в смяната на потребителя, който приема плащането, и на устройството на тази смяна. Не движи стока и не начислява приход. Ако организацията е изключила „Продажба само със свързан фискален принтер“ (`settings.cashRegister.requireConnectedDevice: false`), такива бонове не се издават. Документ, внесен от друга система, не отпечатва бон.

Различното спрямо касовия документ:

| Поле | Тип | Описание |
|------|-----|----------|
| type | String | `payment_receipt` |
| status | String | `paid`; `voided` — бон, който не е отпечатан: номерът и УНП се запазват, плащане не се записва, а документът се показва в таблица 18.5 |
| issueDate | Date | Дата и час на плащането |
| lines[] | Array | Редовете на бона. Плащане на цялата фактура при издаването ѝ: редовете на фактурата. Всяко друго плащане: по един ред за ДДС ставка, „Плащане по фактура № …“, без `productId` |
| register.origin | String | `pos`: документ на касата на смяната |
| register.paidInvoiceId | ObjectId | Платената фактура или дебитно известие |
| register.paidInvoiceNumber | String | Нейният номер, както е отпечатан в бона |
| register.receiptText | String | Свободният текст в бона под редовете: „Фактура № …“ |
| register.fiscal.inDoubt | Boolean | Прекъснат бон, за който нищо не доказва дали е отпечатан: сумата не се записва и нищо не се печата, докато лице не го уреди |
| register.settled | Object | Кой е уредил такъв бон, кога и дали е отпечатан (`{ printed, by, at }`); записва се и в журнала на действията (`settle_receipt`) |

Плащането се записва върху фактурата (`payments[]`, `origin: payment_receipt`, `receiptId` сочи бона), едва след като бонът е отпечатан. Докато бонът се печата, сумата му е заделена във фактурата (`receiptHolds[]`), така че никое друго плащане не може да вземе същите пари. Индекс: `{orgId, register.paidInvoiceId}`.

След като за фактура е отпечатан бон, сумата ѝ не може да се променя и тя не може да се анулира (HTTP 409 `fiscally_paid`). Коригира се с кредитно или дебитно известие. Самият бон не може да бъде редактиран, изтрит или анулиран.

Таблици 18.1, 18.2 и 18.3 съдържат бона с тип `payment_receipt`, а 18.5 — неотпечатания бон. Фактурата не е в тези таблици, затова всяко плащане присъства в тях веднъж.

Устройство, което само съобщава, че не е фискализирано, отпечатва служебен бон: `register.isFiscal: false`, `register.fiscal.mode: text`, без УНП и без номер на фискален бон. В таблиците той стои като служебна продажба от касата: с празни полета за УНП и фискален бон.

### Сторно на връщане по кредитно известие — `Invoice` с тип `payment_storno` (FR-23)

Фискалният сторно бон при връщане в брой или с карта по кредитно известие: при издаването му или по-късно, изцяло или на части. Кредитното известие е връщането: то заприхождава стоката и сторнира прихода. Сторното е парите: документ на касата със същата структура като бона за плащане, с номер от същата поредица (`CASH_SALE`), в смяната на потребителя, който връща сумата, и на устройството на тази смяна. Не движи стока и не начислява приход. Ако организацията е изключила „Продажба само със свързан фискален принтер“, такива сторна не се издават, както и за кредитно известие, внесено от друга система.

Различното спрямо бона за плащане:

| Поле | Тип | Описание |
|------|-----|----------|
| type | String | `payment_storno` |
| status | String | `paid`; `voided` — сторно, което не е отпечатано: номерът и УНП се запазват, връщане не се записва, а документът се показва в таблица 18.5 |
| lines[] | Array | По един ред за ДДС ставка, „Връщане по кредитно известие № …“, без `productId` |
| register.refundOf | ObjectId | Кредитното известие |
| register.refundOfNumber | String | Неговият номер, както е отпечатан в сторното |
| register.storno | Object | Сторнираният бон: оригинален документ, УНП, номер на фискален бон, дата и причина (`customer_return` или `tax_base_reduction`) |
| register.receiptText | String | При служебен бон: „Сторно на бон № …“ |
| register.fiscal.inDoubt | Boolean | Прекъснато сторно, за което нищо не доказва дали е отпечатано: сумата не се записва и нищо не се печата, докато лице не го уреди |

Сторно цитира бон за плащане по фактурата на кредитното известие, а за фактура, издадена към продажба от касата, бона на самата продажба. Отпечатва се на устройството, отпечатало цитирания бон, защото посочва неговата фискална памет. Връщане, по-голямо от остатъка на един бон, отпечатва по едно сторно за всеки бон. За служебен бон сторното също е служебно, без УНП.

На цитирания документ (`payment_receipt` или `cash_sale`) поле `register.refundClaims[]` (`stornoId`, `rate`, `cents`) пази какво са взели сторната от отпечатаното по всяка ДДС ставка. Записва се с едно атомарно обновяване заедно с проверката, че сумата се побира, така че сторната никога не надхвърлят бона. Сторно, което не е отпечатано, връща своето. Продажба, сторнирана изцяло, не държи нищо, а продажба, от която е върната сума с кредитно известие, не може да се сторнира изцяло.

Връщането се записва върху кредитното известие (`payments[]`, `origin: payment_storno`, `receiptId` сочи сторното), едва след като сторното е отпечатано. Докато се печата, сумата му е заделена в кредитното известие (`receiptHolds[]`). Индекс: `{orgId, register.refundOf}`.

След като за кредитно известие е отпечатано сторно, сумата му не може да се променя и то не може да се анулира (HTTP 409 `fiscally_paid`). Самото сторно не може да бъде редактирано, изтрито или анулирано.

Таблици 18.2 и 18.4 съдържат сторното с тип `payment_storno` и данните на сторнирания бон, а 18.5 — неотпечатаното. Таблици 18.1 и 18.3 не го съдържат, както не съдържат и сторното на продажба. Прекъснато сторно, което чака уреждане, не е в нито една таблица, докато лице не го уреди.

### POSTransaction (POS транзакции) — архив

До версията с FR-21 касовият терминал записваше продажбите в колекция `postransactions`. Миграция `0008-cash-register-copy` копира всяка транзакция в касов документ със същия идентификатор (`_id`), номер, УНП, фискален бон и времена. Миграцията спира, преди да запише каквото и да е, ако открие несъответствие, и проверява, че отчетите (вкл. таблици 18.1–18.5) остават същите. Колекцията се пази и се чете за обратна съвместимост. В нея вече не се записва.

| Поле | Тип | Описание |
|------|-----|----------|
| orgId | ObjectId | Организация |
| sessionId | ObjectId | Смяна (ref POSSession) |
| transactionNumber | String | Номер на транзакция (TXN-YYYY-NNNNNNN) |
| type | String | sale / return / exchange / storno |
| status | String | completed / cancelled |
| customerId | ObjectId | Клиент (ref Contact) |
| lines[] | Array | Редове на транзакцията |
| lines[].productId | ObjectId | Продукт |
| lines[].name | String | Наименование |
| lines[].quantity | Number | Количество |
| lines[].unitPrice | Number | Единична цена |
| lines[].discount | Number | Отстъпка (%) |
| lines[].taxRate | Number | ДДС ставка (%) |
| lines[].taxAmount | Number | ДДС сума |
| lines[].lineTotal | Number | Сума на реда |
| subtotal | Number | Междинна сума |
| discountTotal | Number | Общо отстъпка |
| taxTotal | Number | Общо ДДС |
| total | Number | Обща сума |
| payments[] | Array | Плащания |
| payments[].method | String | cash / card / mobile / voucher |
| payments[].amount | Number | Сума |
| unpNumber | String | УНП (XXXXXXXX-ZZZZ-0000001) |
| fiscalReceiptNumber | String | Номер на фискален бон |
| fiscalDeviceNumber | String | Номер на фискално устройство |
| printedAt | Date | Дата/час на отпечатване |
| isFiscal | Boolean | Фискална транзакция |
| originalUNP | String | Оригинален УНП (за сторно) |
| originalFiscalReceiptNumber | String | Оригинален фискален бон (за сторно) |
| originalTransactionDate | Date | Дата на оригинална транзакция |
| originalTransactionId | ObjectId | Оригинална транзакция (ref POSTransaction) |
| stornoReason | String | Причина за сторно |
| movementId | ObjectId | Складово движение (ref StockMovement) |
| createdBy | ObjectId | Създател (ref User) |
| createdAt | Date | Дата на създаване |

### FiscalDevice (Фискални устройства)
| Поле | Тип | Описание |
|------|-----|----------|
| orgId | ObjectId | Организация |
| deviceNumber | String | 8-знаков номер на устройството |
| name | String | Наименование |
| manufacturer | String | datecs / daisy / tremol / eltrade / incotex |
| connectionType | String | serial / tcp / usb |
| connectionParams | Object | Параметри на връзката |
| warehouseId | ObjectId | Склад (ref Warehouse) |
| status | String | online / offline / error |
| isActive | Boolean | Активно |
| deactivatedAt | Date | Дата на деактивиране |

### Workstation (Работни места)
| Поле | Тип | Описание |
|------|-----|----------|
| orgId | ObjectId | Организация |
| code | String | Код (уникален в организацията) |
| name | String | Наименование |
| warehouseId | ObjectId | Склад (ref Warehouse) |
| fiscalDeviceId | ObjectId | Фискално устройство (ref FiscalDevice) |
| isActive | Boolean | Активно |
| deactivatedAt | Date | Дата на деактивиране |

### User (Потребители / Оператори)
| Поле | Тип | Описание |
|------|-----|----------|
| orgId | ObjectId | Организация |
| email | String | Електронна поща |
| username | String | Потребителско име |
| firstName | String | Име |
| middleName | String | Презиме |
| lastName | String | Фамилия |
| operatorCode | String | 4-цифрен код на оператор (уникален) |
| position | String | Длъжност |
| role | String | Системна роля |
| roleHistory[] | Array | История на ролите |
| roleHistory[].role | String | Роля |
| roleHistory[].startDate | Date | Начална дата |
| roleHistory[].endDate | Date | Крайна дата |
| roleHistory[].assignedBy | ObjectId | Присвоена от |
| isActive | Boolean | Активен |
| deactivatedAt | Date | Дата на деактивиране |

### Sequence (Брояч за УНП)
| Поле | Тип | Описание |
|------|-----|----------|
| orgId | ObjectId | Организация |
| prefix | String | Префикс (UNP-{deviceNumber}) — един брояч за фискалното устройство, общ за всички оператори (Прил. 29, т. 9). Старите броячи `UNP-{deviceNumber}-{operatorCode}` се запазват една версия за обратна съвместимост и се поддържат не по-ниски от новия. |
| year | Number | Година (0 за УНП — без годишно нулиране) |
| lastNumber | Number | Последен пореден номер |

Уникален индекс: `{orgId, prefix, year}`. Атомарно увеличаване чрез `findOneAndUpdate($inc)`. Преходът към един брояч за устройство е миграция `0001-unp-per-device` (колекция `_migrations`).

Номерата на касовите документи се водят в същата колекция: брояч `CASH_SALE` (по години), общ за продажбите, сторната и боновете за плащане по фактура от всички входове — касов терминал, бек офис и внасяне. Броячът `TXN` на старите POS транзакции е закрит: не издава нови номера, а историята му остава проверима. Номерата на смените са от брояча `POS` (`POS-YYYY-NNNNNN`).

### AuditLog (Одитен дневник)
| Поле | Тип | Описание |
|------|-----|----------|
| orgId | ObjectId | Организация |
| userId | ObjectId | Потребител |
| operatorCode | String | Код на оператор |
| action | String | Действие (login/logout/create/update/deactivate/storno/z_report) |
| module | String | Модул (auth/erp/warehouse/invoicing/fiscal) |
| entityType | String | Тип обект (`pos_transaction` за документ на касовия терминал, `invoice` за документ от бек офиса или от внасяне) |
| entityId | ObjectId | Идентификатор на обект |
| entityName | String | Наименование на обект |
| unpNumber | String | УНП (за продажби) |
| correlationId | ObjectId | Корелационен ID (за групови операции) |
| changes[] | Array | Промени (field/oldValue/newValue) |
| ipAddress | String | IP адрес |
| userAgent | String | User Agent |
| timestamp | Date | Дата/час |
