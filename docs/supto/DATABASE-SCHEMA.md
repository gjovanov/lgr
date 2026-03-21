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
| totalSales | Number | Общо продажби |
| totalReturns | Number | Общо връщания |
| totalCash | Number | Общо в брой |
| totalCard | Number | Общо с карта |
| transactionCount | Number | Брой транзакции |

### POSTransaction (POS транзакции)
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
| manufacturer | String | datecs / daisy / tremol / incotex |
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
| prefix | String | Префикс (UNP-{deviceNumber}-{operatorCode}) |
| year | Number | Година (0 за УНП — без годишно нулиране) |
| lastNumber | Number | Последен пореден номер |

Уникален индекс: `{orgId, prefix, year}`. Атомарно увеличаване чрез `findOneAndUpdate($inc)`.

### AuditLog (Одитен дневник)
| Поле | Тип | Описание |
|------|-----|----------|
| orgId | ObjectId | Организация |
| userId | ObjectId | Потребител |
| operatorCode | String | Код на оператор |
| action | String | Действие (login/logout/create/update/deactivate/storno/z_report) |
| module | String | Модул (auth/erp/warehouse/invoicing/fiscal) |
| entityType | String | Тип обект |
| entityId | ObjectId | Идентификатор на обект |
| entityName | String | Наименование на обект |
| unpNumber | String | УНП (за продажби) |
| correlationId | ObjectId | Корелационен ID (за групови операции) |
| changes[] | Array | Промени (field/oldValue/newValue) |
| ipAddress | String | IP адрес |
| userAgent | String | User Agent |
| timestamp | Date | Дата/час |
