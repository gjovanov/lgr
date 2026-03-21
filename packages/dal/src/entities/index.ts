// Core
export type {
  IOrg, IOrgSettings, IOrgSubscription, IVatRate, ITaxConfig, IPayrollConfig, ICloudStorageIntegration,
  IUser, IOAuthProvider, IUserPreferences, IRoleHistoryEntry,
  IInvite, InviteStatus,
  ICode, CodeType,
  IEmailLog,
  IAuditLog, IAuditLogChange,
  IFile, IAiRecognition,
  INotification,
  IBackgroundTask,
  IOrgApp,
  ITag,
} from './core.js'

// Accounting
export type {
  IAccount,
  IFiscalYear,
  IFiscalPeriod,
  IJournalEntry, IJournalEntryLine,
  IFixedAsset, IDepreciationEntry,
  IBankAccount,
  IBankReconciliation, IBankReconciliationItem,
  ITaxReturn, ITaxReturnLine,
  IExchangeRate,
} from './accounting.js'

// Invoicing
export type {
  IPriceStep,
  IContact, IContactAddress, IContactBankDetail,
  IInvoice, IInvoiceLine, IInvoicePayment, IInvoiceAddress, IInvoiceRecurringConfig,
  IPaymentOrder,
  ICashOrder,
} from './invoicing.js'

// Warehouse
export type {
  IProduct, IProductDimensions, IProductCustomPrice, IProductTagPrice, IProductCategoryPrice, IProductVariant,
  IProductCategory,
  IWarehouse, IWarehouseAddress,
  IStockLevel,
  IStockMovement, IStockMovementLine, ICostAllocation,
  IInventoryCount, IInventoryCountLine,
  IPriceList, IPriceListItem,
  ICostLayer,
} from './warehouse.js'

// Payroll
export type {
  IEmployee, IEmployeeAddress, IEmployeeSalary, IEmployeeDeduction, IEmployeeBenefit, IEmergencyContact,
  IPayrollRun, IPayrollRunItem, IPayrollRunDeduction, IPayrollRunEmployerContribution, IPayrollRunTotals,
  IPayslip, IPayslipEarning, IPayslipDeduction, IPayslipYearToDate,
  ITimesheet,
} from './payroll.js'

// HR
export type {
  IDepartment,
  ILeaveType,
  ILeaveRequest,
  ILeaveBalance,
  IBusinessTrip, IBusinessTripExpense,
  IEmployeeDocument,
} from './hr.js'

// CRM
export type {
  ILead,
  IDeal, IDealProduct,
  IPipeline, IPipelineStage,
  IActivity,
} from './crm.js'

// ERP
export type {
  IBillOfMaterials, IBOMMaterial,
  IProductionOrder, IProductionStage, IMaterialConsumed, IQualityCheck,
  IConstructionProject, IProjectAddress, IProjectBudget, IProjectPhase, IConstructionTask, IProjectTeamMember, IProjectMaterial,
  IFiscalDevice, IFiscalDeviceConnectionParams,
  IWorkstation,
  IPOSSession,
  IPOSTransaction, IPOSTransactionLine, IPOSTransactionPayment,
} from './erp.js'

// Sales
export type {
  ISalesOrder, ISalesOrderLine,
  IQuotationTemplate, IQuotationTemplateLine,
} from './sales.js'

// Purchase
export type {
  IPurchaseOrder, IPurchaseOrderLine,
  IBlanketOrder, IBlanketOrderLine,
  IReorderRule,
} from './purchase.js'

// Project
export type {
  IProject, IProjectStage,
  IProjectTask,
  IProjectMilestone,
  IProjectTimesheet,
} from './project.js'

// Helpdesk
export type {
  ITicket,
  IHelpdeskTeam,
  ISLAPolicy, ISLATarget,
} from './helpdesk.js'

// Documents
export type {
  IDocumentRecord, IDocumentShare, IDocumentVersion,
  IDocumentWorkspace,
  ISignatureRequest, ISigner, ISignatureAuditEntry,
} from './documents.js'

// Subscriptions
export type {
  ISubscription, ISubscriptionLine,
} from './subscriptions.js'

// Approvals
export type {
  IApprovalType, IApprovalStepConfig,
  IApprovalRequest, IApprovalStepResult,
} from './approvals.js'

// Planning
export type {
  IShift,
  IShiftTemplate, IShiftTemplateEntry,
  IAppointmentType, IAppointmentQuestion,
  IAppointment, IAppointmentAnswer,
} from './planning.js'

// Recruitment & Appraisals
export type { IJobPosition, IApplicant, IAppraisal, IAppraisalAnswer, IAppraisalGoal } from './recruitment.js'

// Fleet
export type { IVehicle, IVehicleCost } from './fleet.js'

// Maintenance
export type { IEquipment, IMaintenanceRequest } from './maintenance.js'

// Knowledge
export type { IKnowledgeArticle, IKnowledgeArticleVersion, IKnowledgeArticleShare } from './knowledge.js'

// Field Service
export type { IFieldServiceTask, IFieldServicePart } from './field-service.js'

// Manufacturing (Advanced MRP + PLM)
export type { IWorkCenter, IRouting, IRoutingStep, IECO, IECOChange } from './manufacturing.js'

// POS Restaurant
export type { IRestaurantFloor, IRestaurantTable, IKitchenOrder, IKitchenOrderLine } from './pos-restaurant.js'
