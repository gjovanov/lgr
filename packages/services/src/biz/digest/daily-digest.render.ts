/**
 * FR-11.14 (#21) — the digest as HTML.
 *
 * House rule, inherited from `buildEmailHtml`: **inline-styled strings, no templating
 * engine**. Mail clients ignore stylesheets and half of modern CSS anyway, so a template
 * engine would buy nothing but a dependency. Tables and inline styles are the medium.
 *
 * Import-pure — it takes the data shape and a locale, touches no database — so the tests can
 * assert the markup without seeding anything.
 */

import {
  isSectionError,
  type DailyDigestData,
  type DigestBackups,
  type DigestDocumentFamily,
  type DigestMaterialBlock,
  type DigestSequenceLine,
  type DigestServer,
  type Section,
} from './daily-digest.types.js'

// ── i18n ×4 (FR-11.17) ──────────────────────────────────────────────────────

export interface DigestStrings {
  subject: string
  heading: string
  forDate: string
  allClear: string
  sectionFailed: string
  none: string
  andMore: string
  generated: string

  kpis: string
  sales: string
  cashRegister: string
  purchases: string
  payments: string
  documents: string
  count: string
  total: string
  number: string
  contact: string
  status: string
  method: string

  sequence: string
  sequenceRange: string
  sequenceEmpty: string
  missingNumbers: string
  lastNumberMismatch: string

  materials: string
  sold: string
  transferred: string
  loaded: string
  product: string
  quantity: string
  value: string
  rows: string

  stock: string
  stockEmpty: string
  warehouse: string

  corrections: string
  correction: string
  writeOff: string
  manualCorrection: string
  lines: string

  undocumented: string
  undocumentedHint: string
  importedNote: string

  duplicates: string
  duplicatesHint: string
  occurrences: string

  edited: string
  action: string
  changes: string
  user: string

  ops: string
  imports: string
  completed: string
  failed: string
  created: string
  failedEmails: string

  backups: string
  backupsOk: string
  backupsNeverReported: string
  backupsStale: string
  backupsUnreadable: string
  backupLatestFull: string
  backupGenerations: string
  backupUploads: string
  backupDelta: string
  backupOffsite: string
  backupOffsiteNone: string
  backupRestore: string
  backupRestoreNever: string
  backupRestoreFailed: string
  backupOrgBundle: string
  backupOrgBundleFailed: string
  backupOrgBundleRunning: string
  backupOrgBundleAttempts: string
  backupOffsiteCopy: string
  backupOrgOffsiteNone: string
  backupOffsiteReconsent: string
  backupOffsiteFailed: string
  backupOffsiteVerified: string
  backupOrgBundleEmail: string
  backupRestoreInspected: string
  backupRestoreMerged: string
  backupRestoreReplaced: string
  backupRestoreRolledBack: string
  backupRestoreFailedRun: string
  backupRestoreRunning: string
  backupRestoreRemapped: string
  backupRestoreClamped: string
  backupRestoreDangling: string
  /** FR-13.47 — the label, plus one short name per threshold that can be crossed. */
  backupArchiveTrigger: string
  backupTrigger_db_size: string
  backupTrigger_org_size: string
  backupTrigger_tenants: string
  backupTrigger_restore_time: string
  backupDocuments: string
  hoursAgo: string

  /** FR-20.100 — the org's own server. */
  server: string
  serverMirror: string
  serverMirrorCurrent: string
  serverMirrorBehind: string
  serverUnheard: string
  serverNotYetHeard: string
  serverBackup: string
  serverBackupNone: string
  serverBackupAge: string
  serverQueued: string
  serverQueuedText: string
}

export const DIGEST_I18N: Record<string, DigestStrings> = {
  en: {
    subject: 'Daily report', heading: 'Daily report', forDate: 'for', allClear: 'Nothing to report — the day looks clean.',
    sectionFailed: 'This section could not be built', none: 'none', andMore: 'and {n} more', generated: 'Generated',
    kpis: 'Sales', sales: 'Invoices', cashRegister: 'Cash register', purchases: 'Purchases', payments: 'Payments',
    documents: 'Documents', count: 'Count', total: 'Total', number: 'No.', contact: 'Counterparty', status: 'Status', method: 'Payment',
    sequence: 'Numbering', sequenceRange: '{prefix} {min} → {max}, {n} document(s)',
    sequenceEmpty: 'no documents issued (last number: {last})',
    missingNumbers: 'absent numbers in range', lastNumberMismatch: 'counter says {counter}, the day ends at {dayMax}',
    materials: 'Materials', sold: 'Sold', transferred: 'Transferred', loaded: 'Received',
    product: 'Product', quantity: 'Qty', value: 'Value', rows: 'rows',
    stock: 'Stock at or below zero', stockEmpty: 'no products at or below zero', warehouse: 'Warehouse',
    corrections: 'Corrections and write-offs', correction: 'Correction', writeOff: 'Write-off', manualCorrection: 'Manual correction', lines: 'lines',
    undocumented: 'Sales without a stock document', undocumentedHint: 'Issued sales whose lines name a product and warehouse but moved no stock.',
    importedNote: 'imported (intentionally without a movement)',
    duplicates: 'Possible duplicates', duplicatesHint: 'Same product and quantity sold more than once — for review.', occurrences: 'times',
    edited: 'Edited after issue', action: 'Action', changes: 'Changed fields', user: 'User',
    ops: 'Imports and emails', imports: 'Imports', completed: 'completed', failed: 'failed', created: 'created',
    failedEmails: 'Failed emails',
    backups: 'Backups', backupsOk: 'Verified — all checks passed.',
    backupsNeverReported: 'NO BACKUP HAS EVER BEEN REPORTED. Nothing is known about the state of the backups.',
    backupsStale: 'The last backup report is {n} h old — verification has stopped running.',
    backupsUnreadable: 'The backup report could not be read.',
    backupLatestFull: 'Latest full', backupGenerations: 'Retained',
    backupUploads: 'Uploads', backupDelta: 'Hourly deltas', backupOffsite: 'Off-site',
    backupOffsiteNone: 'no off-site copy — one host holds every backup',
    backupRestore: 'Last restore test', backupRestoreNever: 'never run — these backups have not been proven restorable',
    backupRestoreFailed: 'FAILED',
    backupOrgBundle: 'This organisation’s bundle',
    backupOrgBundleFailed: 'THIS ORGANISATION’S OWN BACKUP FAILED',
    backupOrgBundleRunning: 'still running',
    backupOrgBundleAttempts: 'attempt {n} of {max}',
    backupOffsiteCopy: 'Off-site copy',
    backupOrgOffsiteNone: 'This backup exists only on the cluster volume — it has NO off-site copy.',
    backupOffsiteReconsent: 'needs re-consent — no off-site copy was made',
    backupOffsiteFailed: 'the off-site copy FAILED',
    backupOffsiteVerified: 'read back and verified',
    backupOrgBundleEmail: 'Bundle not emailed',
    backupRestoreInspected: 'A backup bundle was inspected (nothing was written)',
    backupRestoreMerged: 'DATA WAS RESTORED into this organisation (merge)',
    backupRestoreReplaced: 'THIS ORGANISATION’S DATA WAS REPLACED from a backup',
    backupRestoreRolledBack: 'A restore failed and was rolled back from the safety backup',
    backupRestoreFailedRun: 'A restore failed',
    backupRestoreRunning: 'A restore is running',
    backupRestoreRemapped: 'from another organisation’s bundle',
    backupRestoreClamped: '{n} sequences held at their live value',
    backupRestoreDangling: '{n} documents without their files',
    backupArchiveTrigger: 'Archive policy — time to revisit (FR-13.47)',
    backupTrigger_db_size: 'the database',
    backupTrigger_org_size: 'this organisation',
    backupTrigger_tenants: 'real tenants',
    backupTrigger_restore_time: 'restore time',
    backupDocuments: 'documents',
    hoursAgo: '{n} h ago',
    server: 'This organisation’s server',
    serverMirror: 'lgrai.app’s copy',
    serverMirrorCurrent: 'up to date',
    serverMirrorBehind: '{n} changes behind; the last arrived {h} h ago',
    serverUnheard: 'lgrai.app has not answered the server for {h} h — it may be offline',
    serverNotYetHeard: 'not heard from lgrai.app since the server started',
    serverBackup: 'Last backup on the server',
    serverBackupNone: 'NO BACKUP of this organisation on the server',
    serverBackupAge: '{h} h ago',
    serverQueued: 'Waiting for the internet',
    serverQueuedText: '{n}, the oldest {h} h old',
  },
  bg: {
    subject: 'Дневен отчет', heading: 'Дневен отчет', forDate: 'за', allClear: 'Няма отклонения — денят изглежда чист.',
    sectionFailed: 'Тази секция не можа да бъде изготвена', none: 'няма', andMore: 'и още {n}', generated: 'Генериран',
    kpis: 'Продажби', sales: 'Фактури', cashRegister: 'Каса', purchases: 'Покупки', payments: 'Плащания',
    documents: 'Документи', count: 'Брой', total: 'Общо', number: '№', contact: 'Контрагент', status: 'Статус', method: 'Плащане',
    sequence: 'Номерация', sequenceRange: '{prefix} {min} → {max}, {n} документа',
    sequenceEmpty: 'без издадени документи (последен номер: {last})',
    missingNumbers: 'липсващи номера в диапазона', lastNumberMismatch: 'броячът е на {counter}, а денят завършва на {dayMax}',
    materials: 'Материали', sold: 'Продадени', transferred: 'Прехвърлени', loaded: 'Заредени',
    product: 'Артикул', quantity: 'Кол.', value: 'Стойност', rows: 'реда',
    stock: 'Наличности на или под нула', stockEmpty: 'няма артикули на или под нула', warehouse: 'Склад',
    corrections: 'Корекции и отписвания', correction: 'Корекция', writeOff: 'Отписване', manualCorrection: 'Ръчна корекция', lines: 'реда',
    undocumented: 'Продажби без складов документ', undocumentedHint: 'Издадени продажби с артикул и склад по редовете, но без движение на стока.',
    importedNote: 'импортирана (умишлено без движение)',
    duplicates: 'Съмнителни дублирания', duplicatesHint: 'Един и същ артикул с едно и също количество, продаден повече от веднъж — за преглед.', occurrences: 'пъти',
    edited: 'Редактирани след издаване', action: 'Действие', changes: 'Променени полета', user: 'Потребител',
    ops: 'Импорти и имейли', imports: 'Импорти', completed: 'успешни', failed: 'неуспешни', created: 'създадени',
    failedEmails: 'Неуспешни имейли',
    backups: 'Резервни копия', backupsOk: 'Проверени — всички проверки са успешни.',
    backupsNeverReported: 'НИКОГА НЕ Е ДОКЛАДВАНО РЕЗЕРВНО КОПИЕ. Нищо не се знае за състоянието на копията.',
    backupsStale: 'Последният отчет е отпреди {n} ч. — проверката е спряла да се изпълнява.',
    backupsUnreadable: 'Отчетът за резервните копия не може да бъде прочетен.',
    backupLatestFull: 'Последно пълно', backupGenerations: 'Запазени',
    backupUploads: 'Файлове', backupDelta: 'Часови делти', backupOffsite: 'Извън обекта',
    backupOffsiteNone: 'няма копие извън обекта — всички копия са на един хост',
    backupRestore: 'Последен тест за възстановяване', backupRestoreNever: 'никога не е изпълняван — не е доказано, че копията се възстановяват',
    backupRestoreFailed: 'НЕУСПЕШЕН',
    backupOrgBundle: 'Архив на тази организация',
    backupOrgBundleFailed: 'АРХИВЪТ НА ТАЗИ ОРГАНИЗАЦИЯ НЕ УСПЯ',
    backupOrgBundleRunning: 'все още се изпълнява',
    backupOrgBundleAttempts: 'опит {n} от {max}',
    backupOffsiteCopy: 'Копие извън клъстера',
    backupOrgOffsiteNone: 'Този архив съществува само върху тома на клъстера — НЯМА копие извън него.',
    backupOffsiteReconsent: 'изисква ново разрешение — копие извън клъстера не беше направено',
    backupOffsiteFailed: 'копието извън клъстера НЕ УСПЯ',
    backupOffsiteVerified: 'изтеглено обратно и проверено',
    backupOrgBundleEmail: 'Архивът не е изпратен по имейл',
    backupRestoreInspected: 'Разгледан е архив (нищо не е записано)',
    backupRestoreMerged: 'ВЪЗСТАНОВЕНИ СА ДАННИ в тази организация (сливане)',
    backupRestoreReplaced: 'ДАННИТЕ НА ТАЗИ ОРГАНИЗАЦИЯ СА ЗАМЕНЕНИ от архив',
    backupRestoreRolledBack: 'Възстановяване се провали и беше върнато от предпазния архив',
    backupRestoreFailedRun: 'Възстановяване се провали',
    backupRestoreRunning: 'Тече възстановяване',
    backupRestoreRemapped: 'от архив на друга организация',
    backupRestoreClamped: '{n} номерации са запазени на текущата си стойност',
    backupRestoreDangling: '{n} документа без файловете си',
    backupArchiveTrigger: 'Политика за архивиране — време е за преразглеждане (FR-13.47)',
    backupTrigger_db_size: 'базата данни',
    backupTrigger_org_size: 'тази организация',
    backupTrigger_tenants: 'реални организации',
    backupTrigger_restore_time: 'време за възстановяване',
    backupDocuments: 'документа',
    hoursAgo: 'преди {n} ч.',
    server: 'Сървърът на организацията',
    serverMirror: 'Копието в lgrai.app',
    serverMirrorCurrent: 'актуално',
    serverMirrorBehind: 'изостава с {n} промени; последната пристигна преди {h} ч.',
    serverUnheard: 'lgrai.app не е отговарял на сървъра {h} ч. — възможно е сървърът да е без интернет',
    serverNotYetHeard: 'няма вест от lgrai.app от стартирането на сървъра',
    serverBackup: 'Последен архив на сървъра',
    serverBackupNone: 'НЯМА архив на организацията на сървъра',
    serverBackupAge: 'преди {h} ч.',
    serverQueued: 'Чака интернет',
    serverQueuedText: '{n}, най-старото чака от {h} ч.',
  },
  de: {
    subject: 'Tagesbericht', heading: 'Tagesbericht', forDate: 'für', allClear: 'Keine Auffälligkeiten — der Tag sieht sauber aus.',
    sectionFailed: 'Dieser Abschnitt konnte nicht erstellt werden', none: 'keine', andMore: 'und {n} weitere', generated: 'Erstellt',
    kpis: 'Verkäufe', sales: 'Rechnungen', cashRegister: 'Kasse', purchases: 'Einkäufe', payments: 'Zahlungen',
    documents: 'Belege', count: 'Anzahl', total: 'Gesamt', number: 'Nr.', contact: 'Geschäftspartner', status: 'Status', method: 'Zahlung',
    sequence: 'Nummernkreis', sequenceRange: '{prefix} {min} → {max}, {n} Beleg(e)',
    sequenceEmpty: 'keine Belege ausgestellt (letzte Nummer: {last})',
    missingNumbers: 'fehlende Nummern im Bereich', lastNumberMismatch: 'Zähler steht auf {counter}, der Tag endet bei {dayMax}',
    materials: 'Material', sold: 'Verkauft', transferred: 'Umgelagert', loaded: 'Zugang',
    product: 'Artikel', quantity: 'Menge', value: 'Wert', rows: 'Zeilen',
    stock: 'Bestand auf oder unter null', stockEmpty: 'keine Artikel auf oder unter null', warehouse: 'Lager',
    corrections: 'Korrekturen und Abschreibungen', correction: 'Korrektur', writeOff: 'Abschreibung', manualCorrection: 'Manuelle Korrektur', lines: 'Zeilen',
    undocumented: 'Verkäufe ohne Lagerbeleg', undocumentedHint: 'Ausgestellte Verkäufe mit Artikel und Lager in den Positionen, aber ohne Lagerbewegung.',
    importedNote: 'importiert (bewusst ohne Bewegung)',
    duplicates: 'Mögliche Dubletten', duplicatesHint: 'Gleicher Artikel und gleiche Menge mehrfach verkauft — zur Prüfung.', occurrences: 'mal',
    edited: 'Nach Ausstellung geändert', action: 'Aktion', changes: 'Geänderte Felder', user: 'Benutzer',
    ops: 'Importe und E-Mails', imports: 'Importe', completed: 'erfolgreich', failed: 'fehlgeschlagen', created: 'erstellt',
    failedEmails: 'Fehlgeschlagene E-Mails',
    backups: 'Datensicherung', backupsOk: 'Geprüft — alle Kontrollen bestanden.',
    backupsNeverReported: 'ES WURDE NIE EINE SICHERUNG GEMELDET. Über den Zustand der Sicherungen ist nichts bekannt.',
    backupsStale: 'Der letzte Sicherungsbericht ist {n} h alt — die Prüfung läuft nicht mehr.',
    backupsUnreadable: 'Der Sicherungsbericht konnte nicht gelesen werden.',
    backupLatestFull: 'Letzte Vollsicherung', backupGenerations: 'Aufbewahrt',
    backupUploads: 'Dateien', backupDelta: 'Stündliche Deltas', backupOffsite: 'Auslagerung',
    backupOffsiteNone: 'keine ausgelagerte Kopie — alle Sicherungen liegen auf einem Host',
    backupRestore: 'Letzter Wiederherstellungstest', backupRestoreNever: 'nie ausgeführt — die Wiederherstellbarkeit ist unbewiesen',
    backupRestoreFailed: 'FEHLGESCHLAGEN',
    backupOrgBundle: 'Sicherung dieser Organisation',
    backupOrgBundleFailed: 'DIE SICHERUNG DIESER ORGANISATION IST FEHLGESCHLAGEN',
    backupOrgBundleRunning: 'läuft noch',
    backupOrgBundleAttempts: 'Versuch {n} von {max}',
    backupOffsiteCopy: 'Externe Kopie',
    backupOrgOffsiteNone: 'Dieses Backup liegt nur auf dem Cluster-Volume — es gibt KEINE externe Kopie.',
    backupOffsiteReconsent: 'erfordert eine neue Zustimmung — es wurde keine externe Kopie erstellt',
    backupOffsiteFailed: 'die externe Kopie ist FEHLGESCHLAGEN',
    backupOffsiteVerified: 'zurückgelesen und verifiziert',
    backupOrgBundleEmail: 'Sicherung nicht per E-Mail versandt',
    backupRestoreInspected: 'Ein Sicherungspaket wurde geprüft (nichts wurde geschrieben)',
    backupRestoreMerged: 'DATEN WURDEN in diese Organisation ZURÜCKGESPIELT (Zusammenführen)',
    backupRestoreReplaced: 'DIE DATEN DIESER ORGANISATION WURDEN aus einer Sicherung ERSETZT',
    backupRestoreRolledBack: 'Eine Wiederherstellung schlug fehl und wurde aus der Sicherheitskopie zurückgenommen',
    backupRestoreFailedRun: 'Eine Wiederherstellung schlug fehl',
    backupRestoreRunning: 'Eine Wiederherstellung läuft',
    backupRestoreRemapped: 'aus dem Paket einer anderen Organisation',
    backupRestoreClamped: '{n} Nummernkreise auf ihrem aktuellen Wert belassen',
    backupRestoreDangling: '{n} Dokumente ohne ihre Dateien',
    backupArchiveTrigger: 'Archivierungsrichtlinie — erneut zu prüfen (FR-13.47)',
    backupTrigger_db_size: 'die Datenbank',
    backupTrigger_org_size: 'diese Organisation',
    backupTrigger_tenants: 'echte Mandanten',
    backupTrigger_restore_time: 'Wiederherstellungsdauer',
    backupDocuments: 'Dokumente',
    hoursAgo: 'vor {n} h',
    server: 'Server der Organisation',
    serverMirror: 'Kopie auf lgrai.app',
    serverMirrorCurrent: 'aktuell',
    serverMirrorBehind: '{n} Änderungen zurück; die letzte kam vor {h} h',
    serverUnheard: 'lgrai.app hat dem Server seit {h} h nicht geantwortet — er ist womöglich offline',
    serverNotYetHeard: 'seit dem Start des Servers nichts von lgrai.app gehört',
    serverBackup: 'Letzte Sicherung auf dem Server',
    serverBackupNone: 'KEINE Sicherung der Organisation auf dem Server',
    serverBackupAge: 'vor {h} h',
    serverQueued: 'Wartet auf das Internet',
    serverQueuedText: '{n}, das älteste seit {h} h',
  },
  mk: {
    subject: 'Дневен извештај', heading: 'Дневен извештај', forDate: 'за', allClear: 'Нема отстапувања — денот изгледа чист.',
    sectionFailed: 'Оваа секција не можеше да се изготви', none: 'нема', andMore: 'и уште {n}', generated: 'Генериран',
    kpis: 'Продажби', sales: 'Фактури', cashRegister: 'Каса', purchases: 'Набавки', payments: 'Плаќања',
    documents: 'Документи', count: 'Број', total: 'Вкупно', number: 'Бр.', contact: 'Партнер', status: 'Статус', method: 'Плаќање',
    sequence: 'Нумерација', sequenceRange: '{prefix} {min} → {max}, {n} документи',
    sequenceEmpty: 'без издадени документи (последен број: {last})',
    missingNumbers: 'недостасуваат броеви во опсегот', lastNumberMismatch: 'бројачот е на {counter}, а денот завршува на {dayMax}',
    materials: 'Материјали', sold: 'Продадени', transferred: 'Пренесени', loaded: 'Примени',
    product: 'Артикл', quantity: 'Кол.', value: 'Вредност', rows: 'редови',
    stock: 'Залихи на или под нула', stockEmpty: 'нема артикли на или под нула', warehouse: 'Склад',
    corrections: 'Корекции и отписи', correction: 'Корекција', writeOff: 'Отпис', manualCorrection: 'Рачна корекција', lines: 'редови',
    undocumented: 'Продажби без складишен документ', undocumentedHint: 'Издадени продажби со артикл и склад во ставките, но без движење на стока.',
    importedNote: 'импортирана (намерно без движење)',
    duplicates: 'Можни дупликати', duplicatesHint: 'Ист артикл со иста количина продаден повеќе од еднаш — за проверка.', occurrences: 'пати',
    edited: 'Изменети по издавање', action: 'Дејство', changes: 'Изменети полиња', user: 'Корисник',
    ops: 'Импорти и е-пошта', imports: 'Импорти', completed: 'успешни', failed: 'неуспешни', created: 'создадени',
    failedEmails: 'Неуспешни е-пораки',
    backups: 'Резервни копии', backupsOk: 'Проверени — сите проверки поминаа.',
    backupsNeverReported: 'НИКОГАШ НЕ Е ПРИЈАВЕНО РЕЗЕРВНО КОПИЕ. Не се знае ништо за состојбата на копиите.',
    backupsStale: 'Последниот извештај е стар {n} ч. — проверката престана да се извршува.',
    backupsUnreadable: 'Извештајот за резервните копии не може да се прочита.',
    backupLatestFull: 'Последно целосно', backupGenerations: 'Зачувани',
    backupUploads: 'Датотеки', backupDelta: 'Часовни делти', backupOffsite: 'Надвор од локацијата',
    backupOffsiteNone: 'нема копија надвор од локацијата — сите копии се на еден хост',
    backupRestore: 'Последен тест за враќање', backupRestoreNever: 'никогаш не е извршен — не е докажано дека копиите се вратливи',
    backupRestoreFailed: 'НЕУСПЕШЕН',
    backupOrgBundle: 'Архив на оваа организација',
    backupOrgBundleFailed: 'АРХИВОТ НА ОВАА ОРГАНИЗАЦИЈА НЕ УСПЕА',
    backupOrgBundleRunning: 'сè уште се извршува',
    backupOrgBundleAttempts: 'обид {n} од {max}',
    backupOffsiteCopy: 'Копија надвор од кластерот',
    backupOrgOffsiteNone: 'Овој бекап постои само на волуменот на кластерот — НЕМА копија надвор од него.',
    backupOffsiteReconsent: 'бара нова согласност — копија надвор од кластерот не е направена',
    backupOffsiteFailed: 'копијата надвор од кластерот НЕ УСПЕА',
    backupOffsiteVerified: 'превземена назад и проверена',
    backupOrgBundleEmail: 'Архивот не е испратен по е-пошта',
    backupRestoreInspected: 'Прегледан е бекап пакет (ништо не е запишано)',
    backupRestoreMerged: 'ВРАТЕНИ СЕ ПОДАТОЦИ во оваа организација (спојување)',
    backupRestoreReplaced: 'ПОДАТОЦИТЕ НА ОВАА ОРГАНИЗАЦИЈА СЕ ЗАМЕНЕТИ од бекап',
    backupRestoreRolledBack: 'Враќањето не успеа и беше вратено од безбедносниот бекап',
    backupRestoreFailedRun: 'Враќањето не успеа',
    backupRestoreRunning: 'Во тек е враќање',
    backupRestoreRemapped: 'од пакет на друга организација',
    backupRestoreClamped: '{n} нумерации задржани на моменталната вредност',
    backupRestoreDangling: '{n} документи без своите датотеки',
    backupArchiveTrigger: 'Политика за архивирање — време е за преиспитување (FR-13.47)',
    backupTrigger_db_size: 'базата на податоци',
    backupTrigger_org_size: 'оваа организација',
    backupTrigger_tenants: 'реални организации',
    backupTrigger_restore_time: 'време за враќање',
    backupDocuments: 'документи',
    hoursAgo: 'пред {n} ч.',
    server: 'Серверот на организацијата',
    serverMirror: 'Копијата на lgrai.app',
    serverMirrorCurrent: 'ажурна',
    serverMirrorBehind: 'заостанува {n} промени; последната пристигна пред {h} ч.',
    serverUnheard: 'lgrai.app не му одговорил на серверот {h} ч. — можеби е без интернет',
    serverNotYetHeard: 'нема вест од lgrai.app од стартувањето на серверот',
    serverBackup: 'Последна резервна копија на серверот',
    serverBackupNone: 'НЕМА резервна копија на организацијата на серверот',
    serverBackupAge: 'пред {h} ч.',
    serverQueued: 'Чека интернет',
    serverQueuedText: '{n}, најстарото чека {h} ч.',
  },
}

export function digestStrings(locale?: string): DigestStrings {
  return DIGEST_I18N[(locale || 'en').slice(0, 2)] || DIGEST_I18N.en
}

// ── Markup helpers ──────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function fmt(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''))
}
function num(n: number, digits = 2): string {
  return (n ?? 0).toFixed(digits)
}
/** DD.MM.YYYY — the format every printed form in this system uses. */
function humanDate(iso: string): string {
  const [y, m, d] = (iso || '').split('-')
  return y ? `${d}.${m}.${y}` : iso
}

const S = {
  body: 'font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:760px',
  h2: 'font-size:15px;margin:22px 0 6px;padding-bottom:4px;border-bottom:2px solid #8e24aa;color:#111',
  table: 'border-collapse:collapse;width:100%;margin:6px 0 10px',
  th: 'text-align:left;padding:4px 8px;background:#f4f4f6;border-bottom:1px solid #ddd;font-size:12px;color:#555',
  thR: 'text-align:right;padding:4px 8px;background:#f4f4f6;border-bottom:1px solid #ddd;font-size:12px;color:#555',
  td: 'padding:4px 8px;border-bottom:1px solid #eee;font-size:13px',
  tdR: 'padding:4px 8px;border-bottom:1px solid #eee;font-size:13px;text-align:right;white-space:nowrap',
  muted: 'color:#888;font-size:12px',
  note: 'color:#666;font-size:12px;margin:2px 0 8px',
  warn: 'color:#b26a00',
  bad: 'color:#c62828',
  totalRow: 'font-weight:bold;background:#fafafa',
}

function h2(text: string): string {
  return `<h2 style="${S.h2}">${esc(text)}</h2>`
}
function moreLine(more: number, L: DigestStrings): string {
  return more > 0 ? `<div style="${S.muted}">${esc(fmt(L.andMore, { n: more }))}</div>` : ''
}
function noneLine(L: DigestStrings): string {
  return `<div style="${S.muted}">${esc(L.none)}</div>`
}

/** A section that failed renders its failure inline instead of vanishing. */
function guard<T>(s: Section<T> | undefined, L: DigestStrings, render: (v: T) => string): string {
  if (s === undefined) return ''
  if (isSectionError(s)) return `<div style="${S.bad};font-size:12px">${esc(L.sectionFailed)}: ${esc(s.message)}</div>`
  return render(s as T)
}

// ── Section renderers ───────────────────────────────────────────────────────

function renderSequence(seq: DigestSequenceLine | undefined, L: DigestStrings): string {
  if (!seq) return ''
  const parts: string[] = []
  if (seq.count && seq.min && seq.max) {
    parts.push(esc(fmt(L.sequenceRange, { prefix: seq.prefix, min: seq.min, max: seq.max, n: seq.count })))
  } else {
    parts.push(esc(fmt(L.sequenceEmpty, { last: seq.lastNumber ?? '—' })))
  }
  if (seq.missing.length) {
    parts.push(`<span style="${S.bad}">${esc(L.missingNumbers)}: ${esc(seq.missing.join(', '))}</span>`)
  }
  if (seq.lastNumberMismatch) {
    parts.push(`<span style="${S.warn}">${esc(fmt(L.lastNumberMismatch, seq.lastNumberMismatch))}</span>`)
  }
  return `<div style="${S.note}">${L.sequence}: ${parts.join(' · ')}</div>`
}

function renderFamily(f: DigestDocumentFamily, title: string, L: DigestStrings): string {
  const head = `<div style="font-weight:bold;margin-top:10px">${esc(title)}</div>`
  const sequences = renderSequence(f.sequence, L) + (f.closedSequences || []).map(s => renderSequence(s, L)).join('')
  if (!f.count) return head + sequences + noneLine(L)

  const rows = f.rows.map(r => `
    <tr>
      <td style="${S.td}">${esc(r.number)}</td>
      <td style="${S.td}">${esc(r.contactName)}</td>
      <td style="${S.td}">${esc(r.status)}</td>
      <td style="${S.td}">${esc(r.paymentMethod || '')}</td>
      <td style="${S.tdR}">${num(r.total)} ${esc(r.currency)}</td>
    </tr>`).join('')

  return [
    head,
    sequences,
    `<table style="${S.table}">`,
    `<tr><th style="${S.th}">${esc(L.number)}</th><th style="${S.th}">${esc(L.contact)}</th>`,
    `<th style="${S.th}">${esc(L.status)}</th><th style="${S.th}">${esc(L.method)}</th>`,
    `<th style="${S.thR}">${esc(L.total)}</th></tr>`,
    rows,
    `<tr style="${S.totalRow}"><td style="${S.td}" colspan="4">${esc(L.total)} (${f.count})</td>`,
    `<td style="${S.tdR}">${num(f.total)}</td></tr>`,
    '</table>',
    moreLine(f.more, L),
  ].join('\n')
}

function renderMaterialBlock(b: DigestMaterialBlock, title: string, L: DigestStrings): string {
  const head = `<div style="font-weight:bold;margin-top:10px">${esc(title)}</div>`
  if (!b.rowCount) return head + noneLine(L)

  const rows = b.rows.map(r => `
    <tr>
      <td style="${S.td}">${esc(r.sku)}</td>
      <td style="${S.td}">${esc(r.name)}</td>
      <td style="${S.tdR}">${num(r.quantity, 3)} ${esc(r.unit)}</td>
      <td style="${S.tdR}">${num(r.value)}</td>
    </tr>`).join('')

  return [
    head,
    `<table style="${S.table}">`,
    `<tr><th style="${S.th}">SKU</th><th style="${S.th}">${esc(L.product)}</th>`,
    `<th style="${S.thR}">${esc(L.quantity)}</th><th style="${S.thR}">${esc(L.value)}</th></tr>`,
    rows,
    // Σ quantity across products is meaningless — row count is the honest companion to Σ value.
    `<tr style="${S.totalRow}"><td style="${S.td}" colspan="2">${b.rowCount} ${esc(L.rows)}</td>`,
    `<td style="${S.tdR}"></td><td style="${S.tdR}">${num(b.totalValue)}</td></tr>`,
    '</table>',
    moreLine(b.more, L),
  ].join('\n')
}

/** 3,355,443 → "3.2 MB". Two significant places is all a size line is worth here. */
function bytes(n: number): string {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`
}

/**
 * FR-13.6 — backups, rendered so that a failure is impossible to mistake for an absence.
 *
 * A red banner for every unhealthy state, including "no report has ever arrived": the whole
 * reason this section exists is that roomler's zero-snapshot uploads backup looked exactly
 * like a quiet, healthy one.
 */
/** FR-20.100 — three lines, each red when it crossed its threshold. */
function renderServer(v: DigestServer, L: DigestStrings): string {
  const has = (a: string) => v.alarms.includes(a as any)
  const line = (label: string, text: string, alarm: boolean) =>
    `<div style="${S.note}${alarm ? `;${S.bad}` : ''}">${esc(label)}: ${esc(text)}</div>`
  const mirror = has('unheard')
    ? (v.heardHours === undefined ? L.serverNotYetHeard : fmt(L.serverUnheard, { h: v.heardHours }))
    : v.heardHours === undefined
      ? L.serverNotYetHeard
      : !v.mirror
        ? L.none
        : v.mirror.behind > 0
          ? fmt(L.serverMirrorBehind, { n: v.mirror.behind, h: v.mirror.lastPageHours ?? '?' })
          : L.serverMirrorCurrent
  const backup = v.backupHours === undefined
    ? (has('backup_none') ? L.serverBackupNone : L.none)
    : fmt(L.serverBackupAge, { h: v.backupHours })
  const queued = v.queued ? fmt(L.serverQueuedText, { n: v.queued, h: v.oldestQueuedHours ?? 0 }) : L.none
  return [
    h2(L.server),
    line(L.serverMirror, mirror, has('unheard') || has('mirror_lag')),
    line(L.serverBackup, backup, has('backup_stale') || has('backup_none')),
    line(L.serverQueued, queued, has('queued_old')),
  ].join('\n')
}

function renderBackups(b: DigestBackups, L: DigestStrings): string {
  const banner = (text: string, bad: boolean) =>
    `<p style="margin:6px 0 10px;padding:10px 12px;${bad
      ? 'background:#fdecea;border-left:4px solid #c62828;color:#8e1b1b;font-weight:bold'
      : 'background:#f1f8e9;border-left:4px solid #7cb342'}">${esc(text)}</p>`

  const out: string[] = [h2(L.backups)]

  if (b.gap === 'never_reported') return out.concat(banner(L.backupsNeverReported, true)).join('\n')
  if (b.gap === 'unreadable') return out.concat(banner(L.backupsUnreadable, true)).join('\n')
  if (b.gap === 'stale') out.push(banner(fmt(L.backupsStale, { n: b.reportAgeHours ?? '?' }), true))
  else if (b.healthy) out.push(banner(L.backupsOk, false))

  // Every check that did not pass, verbatim from the verification run.
  if (b.failures.length) {
    out.push(b.failures.map(f =>
      `<div style="${S.note};${f.result === 'fail' ? S.bad : S.warn}">${esc(f.check)}: ${esc(f.detail)}</div>`,
    ).join(''))
  }

  const line = (label: string, value: string, style = S.note) =>
    `<div style="${style}">${esc(label)}: ${value}</div>`

  if (b.latestFull) {
    out.push(line(L.backupLatestFull,
      `${esc(b.latestFull.artifact)} · ${bytes(b.latestFull.bytes)} · ${esc(fmt(L.hoursAgo, { n: b.latestFull.ageHours }))}`))
  }
  if (b.generations) {
    const g = b.generations
    out.push(line(L.backupGenerations, `${g.daily} daily · ${g.weekly} weekly · ${g.monthly} monthly · ${g.yearly} yearly`))
  }
  if (b.delta) {
    out.push(line(L.backupDelta, `${b.delta.slices} · ${esc(fmt(L.hoursAgo, { n: b.delta.ageHours }))}`))
  }
  if (b.uploads) {
    out.push(line(L.backupUploads,
      `${b.uploads.snapshots} × ${b.uploads.files} · ${esc(fmt(L.hoursAgo, { n: b.uploads.ageHours }))}`))
  }

  // An empty `reached` list is the 3-2-1 failure: copies exist, but all on one host.
  if (b.offsite && b.offsite.reached.length) {
    out.push(line(L.backupOffsite,
      `${esc(b.offsite.reached.join(' + '))} · ${esc(fmt(L.hoursAgo, { n: b.offsite.ageHours }))}`))
  } else {
    out.push(line(L.backupOffsite, esc(L.backupOffsiteNone), `${S.note};${S.warn}`))
  }

  if (!b.lastRestore) {
    out.push(line(L.backupRestore, esc(L.backupRestoreNever), `${S.note};${S.warn}`))
  } else if (b.lastRestore.result === 'pass') {
    const extra = b.lastRestore.collections ? ` · ${b.lastRestore.collections} collections` : ''
    const secs = b.lastRestore.seconds ? ` · ${b.lastRestore.seconds}s` : ''
    out.push(line(L.backupRestore, `${esc(humanDate(b.lastRestore.at.slice(0, 10)))}${extra}${secs}`))
  } else {
    out.push(line(L.backupRestore,
      `<b>${esc(L.backupRestoreFailed)}</b> · ${esc(humanDate(b.lastRestore.at.slice(0, 10)))}`, `${S.note};${S.bad}`))
  }

  // ── This org's own Layer-2 bundle ────────────────────────────────────────
  //
  // Everything above is the cluster's Layer-1 dump. A failing per-org bundle must be visible
  // on its own line and must not be able to hide behind a green Layer-1 banner.
  if (b.orgRun) {
    const r = b.orgRun
    const detail = [
      r.date,
      r.documentCount ? `${r.documentCount} ${L.backupDocuments}` : '',
      r.bytes ? bytes(r.bytes) : '',
      r.ageHours !== undefined ? fmt(L.hoursAgo, { n: r.ageHours }) : '',
    ].filter(Boolean).join(' · ')

    if (r.status === 'completed') {
      out.push(line(L.backupOrgBundle, esc(detail)))
      // Not a failure — the artifact is on the PV and checksummed — but the operator should
      // know the mail did not carry it, and why.
      if (r.emailSkippedReason) {
        out.push(line(L.backupOrgBundleEmail, esc(r.emailSkippedReason), `${S.note};${S.warn}`))
      }
    } else if (r.status === 'failed') {
      const attempts = r.attempts && r.maxAttempts
        ? ` · ${fmt(L.backupOrgBundleAttempts, { n: r.attempts, max: r.maxAttempts })}`
        : ''
      out.push(banner(
        `${L.backupOrgBundleFailed}: ${detail}${attempts}${r.reason ? ` — ${r.reason}` : ''}`,
        true,
      ))
    } else {
      out.push(line(L.backupOrgBundle, `${esc(detail)} · ${esc(L.backupOrgBundleRunning)}`, `${S.note};${S.warn}`))
    }

    // ── Where the bundle actually went (FR-13.59) ─────────────────────────
    //
    // ⚠ A completed run with no reached destination is reported as a FAILURE BANNER, not as a
    // quiet line. The artifact is on `<UPLOAD_DIR>/<orgId>/backups/` — a node-local hostPath
    // on `k8s-worker-2`, the same node the live database is pinned to. A backup sharing a
    // disk with what it protects is the exact state FR-13 exists to end, and until this line
    // existed the only trace of it was a log entry.
    if (r.status === 'completed' && r.destinations) {
      const reached = r.destinations.filter(d => d.status === 'reached')
      if (!reached.length) {
        out.push(banner(L.backupOrgOffsiteNone, true))
      }
      for (const d of r.destinations) {
        if (d.status === 'reached') {
          const extra = [
            d.bytes ? bytes(d.bytes) : '',
            d.verified ? L.backupOffsiteVerified : '',
            d.ageHours !== undefined ? fmt(L.hoursAgo, { n: d.ageHours }) : '',
            d.reason || '',
          ].filter(Boolean).join(' · ')
          out.push(line(`${L.backupOffsiteCopy} — ${d.name}`, esc(extra)))
        } else if (d.status === 'reconsent_required') {
          // Its own message because it is the one failure that never recovers on a retry: it
          // will fail identically every night until a human re-consents (FR-13.54).
          out.push(banner(`${L.backupOffsiteCopy} — ${d.name}: ${L.backupOffsiteReconsent}`, true))
        } else if (d.status === 'failed') {
          out.push(banner(`${L.backupOffsiteCopy} — ${d.name}: ${L.backupOffsiteFailed}${d.reason ? ` — ${d.reason}` : ''}`, true))
        } else if (d.reason) {
          // `skipped` = not configured. A warning, not a failure — but never silence, or
          // "we never turned it on" becomes indistinguishable from "it is working".
          out.push(line(`${L.backupOffsiteCopy} — ${d.name}`, esc(d.reason), `${S.note};${S.warn}`))
        }
      }
    }
  }

  // ── FR-13.37: somebody restored into live data ──────────────────────────────
  //
  // ⚠ A writing restore is rendered as a BANNER, not as a line, and it is the only thing in
  // this section that is neither a success nor a failure. It is an operator having reached
  // into this organisation's data — inserting documents, possibly deleting them, possibly
  // from another organisation's bundle. The audit log records it; the digest is what puts it
  // in front of the people who did not do it.
  for (const r of b.restores || []) {
    const who = r.actor ? ` · ${r.actor}` : ''
    const from = r.bundleDate ? ` · ${humanDate(r.bundleDate)}` : ''

    if (r.mode === 'inspect') {
      // Writes nothing, so it is information: reported, never alarming.
      out.push(line(L.backupRestoreInspected, esc(`${who}${from}`.replace(/^ · /, '')), `${S.note}`))
      continue
    }

    const counts = `+${r.documentsInserted}${r.documentsDeleted ? ` / −${r.documentsDeleted}` : ''}`
    const extras = [
      r.remap ? L.backupRestoreRemapped : '',
      r.sequenceClamps ? fmt(L.backupRestoreClamped, { n: r.sequenceClamps }) : '',
      r.danglingFileCount ? fmt(L.backupRestoreDangling, { n: r.danglingFileCount }) : '',
    ].filter(Boolean).join(' · ')

    if (r.status === 'completed') {
      out.push(banner(
        `${r.mode === 'replace' ? L.backupRestoreReplaced : L.backupRestoreMerged}${who}${from} · ${counts}` +
        (extras ? ` · ${extras}` : ''),
        true,
      ))
    } else if (r.status === 'rolled_back') {
      // The good outcome of a bad event, and it must say BOTH halves: it failed, and the data
      // is back. "Failed" alone sends someone looking for damage that was already undone.
      out.push(banner(`${L.backupRestoreRolledBack}${who}${r.error ? ` — ${r.error}` : ''}`, true))
    } else if (r.status === 'failed') {
      out.push(banner(`${L.backupRestoreFailedRun}${who}${r.error ? ` — ${r.error}` : ''}`, true))
    } else {
      out.push(line(L.backupRestoreRunning, esc(who.replace(/^ · /, '')), `${S.note};${S.warn}`))
    }
  }

  // ── FR-13.47: a measured figure has crossed the line the FR drew ────────────
  //
  // ⚠ A note, not a failure. Nothing is broken — the backups ran, the archive policy is doing
  // what it was told. What has changed is that the MEASUREMENT the policy was chosen on no
  // longer holds, and FR-13.40's "rows are never archived out of Mongo" was a decision taken
  // against numbers, not a principle. This is the only place those numbers are ever re-read.
  for (const t of b.archiveTriggers || []) {
    out.push(line(
      L.backupArchiveTrigger,
      esc(`${L[`backupTrigger_${t.trigger}` as keyof DigestStrings] as string} — ${t.value} > ${t.threshold}`),
      `${S.note};${S.warn}`,
    ))
  }

  if (b.reportedAt) {
    out.push(`<div style="${S.muted}">${esc(L.generated)} ${esc(b.reportedAt.slice(0, 16).replace('T', ' '))}` +
      `${b.host ? ` · ${esc(b.host)}` : ''}</div>`)
  }
  return out.join('\n')
}

// ── The page ────────────────────────────────────────────────────────────────

export function digestSubject(data: DailyDigestData): string {
  const L = digestStrings(data.locale)
  return `${L.subject} — ${data.orgName} — ${humanDate(data.date)}`
}

export function renderDigestHtml(data: DailyDigestData): string {
  const L = digestStrings(data.locale)
  const out: string[] = [`<div style="${S.body}">`]

  out.push(`<h1 style="font-size:18px;margin:0 0 2px">${esc(L.heading)}</h1>`)
  out.push(`<div style="${S.muted}">${esc(data.orgName)} · ${esc(L.forDate)} ${esc(humanDate(data.date))}</div>`)

  // An empty day still sends: silence is itself the signal that the day was clean.
  if (data.allClear) {
    out.push(`<p style="margin:16px 0;padding:10px 12px;background:#f1f8e9;border-left:4px solid #7cb342">${esc(L.allClear)}</p>`)
  }

  out.push(guard(data.kpis, L, k => [
    h2(L.kpis),
    `<table style="${S.table}">`,
    `<tr><th style="${S.th}"></th><th style="${S.thR}">${esc(L.count)}</th><th style="${S.thR}">${esc(L.total)}</th></tr>`,
    `<tr><td style="${S.td}">${esc(L.sales)}</td><td style="${S.tdR}">${k.salesCount}</td><td style="${S.tdR}">${num(k.salesTotal)} ${esc(k.currency)}</td></tr>`,
    `<tr><td style="${S.td}">${esc(L.cashRegister)}</td><td style="${S.tdR}">${k.cashCount}</td><td style="${S.tdR}">${num(k.cashTotal)} ${esc(k.currency)}</td></tr>`,
    `<tr><td style="${S.td}">${esc(L.purchases)}</td><td style="${S.tdR}">${k.purchaseCount}</td><td style="${S.tdR}">${num(k.purchaseTotal)} ${esc(k.currency)}</td></tr>`,
    `<tr><td style="${S.td}">${esc(L.payments)}</td><td style="${S.tdR}">${k.paymentsCount}</td><td style="${S.tdR}">${num(k.paymentsTotal)} ${esc(k.currency)}</td></tr>`,
    '</table>',
    k.byMethod.length
      ? `<div style="${S.note}">${k.byMethod.map(m => `${esc(m.method)}: ${num(m.amount)}`).join(' · ')}</div>`
      : '',
  ].join('\n')))

  out.push(guard(data.documents, L, d => [
    h2(L.documents),
    renderFamily(d.sales, L.sales, L),
    renderFamily(d.cash, L.cashRegister, L),
    d.purchases.count
      ? `<div style="${S.note}">${esc(L.purchases)}: ${d.purchases.count} · ${num(d.purchases.total)}</div>`
      : '',
  ].join('\n')))

  out.push(guard(data.materials, L, m => [
    h2(L.materials),
    renderMaterialBlock(m.sold, L.sold, L),
    renderMaterialBlock(m.transferred, L.transferred, L),
    renderMaterialBlock(m.loaded, L.loaded, L),
  ].join('\n')))

  out.push(guard(data.stock, L, s => {
    if (!s.count) return h2(L.stock) + `<div style="${S.muted}">${esc(L.stockEmpty)}</div>`
    const rows = s.rows.map(r => `
      <tr>
        <td style="${S.td}">${esc(r.sku)}</td>
        <td style="${S.td}">${esc(r.name)}</td>
        <td style="${S.td}">${esc(r.warehouseName)}</td>
        <td style="${S.tdR};${r.quantity < 0 ? S.bad : ''}">${num(r.quantity, 3)}</td>
      </tr>`).join('')
    return [
      h2(`${L.stock} (${s.count})`),
      `<table style="${S.table}">`,
      `<tr><th style="${S.th}">SKU</th><th style="${S.th}">${esc(L.product)}</th>`,
      `<th style="${S.th}">${esc(L.warehouse)}</th><th style="${S.thR}">${esc(L.quantity)}</th></tr>`,
      rows, '</table>', moreLine(s.more, L),
    ].join('\n')
  }))

  out.push(guard(data.corrections, L, c => {
    if (!c.count) return h2(L.corrections) + noneLine(L)
    const label = (k: string) => k === 'correction' ? L.correction : k === 'writeOff' ? L.writeOff : L.manualCorrection
    const rows = c.rows.map(r => `
      <tr>
        <td style="${S.td}">${esc(r.movementNumber)}</td>
        <td style="${S.td}">${esc(label(r.kind))}</td>
        <td style="${S.tdR}">${r.lineCount} ${esc(L.lines)}</td>
        <td style="${S.tdR};${r.quantity < 0 ? S.bad : ''}">${num(r.quantity, 3)}</td>
        <td style="${S.tdR}">${num(r.value)}</td>
      </tr>`).join('')
    return [
      h2(`${L.corrections} (${c.count})`),
      `<table style="${S.table}">`,
      `<tr><th style="${S.th}">${esc(L.number)}</th><th style="${S.th}"></th>`,
      `<th style="${S.thR}"></th><th style="${S.thR}">${esc(L.quantity)}</th><th style="${S.thR}">${esc(L.value)}</th></tr>`,
      rows, '</table>', moreLine(c.more, L),
    ].join('\n')
  }))

  out.push(guard(data.undocumentedSales, L, u => {
    if (!u.count) return h2(L.undocumented) + noneLine(L)
    const rows = u.rows.map(r => `
      <tr${r.imported ? ' style="color:#999"' : ''}>
        <td style="${S.td}">${esc(r.number)}</td>
        <td style="${S.td}">${esc(r.type)}${r.imported ? ` <span style="${S.muted}">(${esc(L.importedNote)})</span>` : ''}</td>
        <td style="${S.tdR}">${num(r.total)}</td>
      </tr>`).join('')
    return [
      h2(`${L.undocumented} (${u.count})`),
      `<div style="${S.note}">${esc(L.undocumentedHint)}</div>`,
      `<table style="${S.table}">`,
      `<tr><th style="${S.th}">${esc(L.number)}</th><th style="${S.th}"></th><th style="${S.thR}">${esc(L.total)}</th></tr>`,
      rows, '</table>', moreLine(u.more, L),
    ].join('\n')
  }))

  out.push(guard(data.duplicates, L, d => {
    if (!d.count) return h2(L.duplicates) + noneLine(L)
    const rows = d.rows.map(r => `
      <tr>
        <td style="${S.td}">${esc(r.name)}</td>
        <td style="${S.tdR}">${num(r.quantity, 3)}</td>
        <td style="${S.tdR}">${r.occurrences} ${esc(L.occurrences)}</td>
        <td style="${S.td}">${esc(r.documents.join(', '))}</td>
      </tr>`).join('')
    return [
      h2(`${L.duplicates} (${d.count})`),
      `<div style="${S.note}">${esc(L.duplicatesHint)}</div>`,
      `<table style="${S.table}">`,
      `<tr><th style="${S.th}">${esc(L.product)}</th><th style="${S.thR}">${esc(L.quantity)}</th>`,
      `<th style="${S.thR}">${esc(L.occurrences)}</th><th style="${S.th}">${esc(L.documents)}</th></tr>`,
      rows, '</table>', moreLine(d.more, L),
    ].join('\n')
  }))

  out.push(guard(data.editedAfterIssue, L, e => {
    if (!e.count) return h2(L.edited) + noneLine(L)
    const rows = e.rows.map(r => `
      <tr>
        <td style="${S.td}">${esc(r.entityName)}</td>
        <td style="${S.td}">${esc(r.action)}</td>
        <td style="${S.tdR}">${r.changeCount}</td>
        <td style="${S.td}">${esc(r.userName)}</td>
      </tr>`).join('')
    return [
      h2(`${L.edited} (${e.count})`),
      `<table style="${S.table}">`,
      `<tr><th style="${S.th}">${esc(L.number)}</th><th style="${S.th}">${esc(L.action)}</th>`,
      `<th style="${S.thR}">${esc(L.changes)}</th><th style="${S.th}">${esc(L.user)}</th></tr>`,
      rows, '</table>', moreLine(e.more, L),
    ].join('\n')
  }))

  out.push(guard(data.ops, L, o => {
    if (!o.tasks.length && !o.failedEmailCount) return h2(L.ops) + noneLine(L)
    const tasks = o.tasks.map(t =>
      `<div style="${S.note}">${esc(t.type)}: ${t.completed} ${esc(L.completed)}, ${t.failed} ${esc(L.failed)}` +
      (t.created ? `, ${t.created} ${esc(L.created)}` : '') + '</div>').join('')
    const emails = o.failedEmailCount
      ? [
        `<div style="${S.note};${S.bad}">${esc(L.failedEmails)}: ${o.failedEmailCount}</div>`,
        ...o.failedEmails.map(e => `<div style="${S.muted}">${esc(e.to)} — ${esc(e.error)}</div>`),
      ].join('')
      : ''
    return h2(L.ops) + tasks + emails
  }))

  out.push(guard(data.server, L, v => renderServer(v, L)))

  out.push(guard(data.backups, L, b => renderBackups(b, L)))

  out.push(`<hr style="border:0;border-top:1px solid #eee;margin:20px 0 8px">`)
  out.push(`<div style="${S.muted}">${esc(data.orgName)} · ${esc(L.generated)} ${esc(data.generatedAt.slice(0, 16).replace('T', ' '))} · ${esc(data.timezone)}</div>`)
  out.push('</div>')

  return out.filter(Boolean).join('\n')
}
