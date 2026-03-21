import type { IRepository, IBatchRepository } from './repository.js'
import type {
  IOrg, IUser, IInvite, ICode, IEmailLog, IAuditLog, IFile, INotification, IBackgroundTask, IOrgApp, ITag,
  IAccount, IFiscalYear, IFiscalPeriod, IJournalEntry, IFixedAsset, IBankAccount, IBankReconciliation, ITaxReturn, IExchangeRate,
  IContact, IInvoice, IPaymentOrder, ICashOrder,
  IProduct, IWarehouse, IStockLevel, IStockMovement, IInventoryCount, IPriceList, ICostLayer, IProductCategory,
  IEmployee, IPayrollRun, IPayslip, ITimesheet,
  IDepartment, ILeaveType, ILeaveRequest, ILeaveBalance, IBusinessTrip, IEmployeeDocument,
  ILead, IDeal, IPipeline, IActivity,
  IBillOfMaterials, IProductionOrder, IConstructionProject, IFiscalDevice, IWorkstation, IPOSSession, IPOSTransaction,
  ISalesOrder, IQuotationTemplate,
  IPurchaseOrder, IBlanketOrder, IReorderRule,
  IProject, IProjectTask, IProjectMilestone, IProjectTimesheet,
  ITicket, IHelpdeskTeam, ISLAPolicy,
  IDocumentRecord, IDocumentWorkspace, ISignatureRequest,
  ISubscription,
  IApprovalType, IApprovalRequest,
  IShift, IShiftTemplate, IAppointmentType, IAppointment,
  IJobPosition, IApplicant, IAppraisal,
  IVehicle, IVehicleCost,
  IEquipment, IMaintenanceRequest,
  IKnowledgeArticle,
  IFieldServiceTask,
  IWorkCenter, IRouting, IECO,
  IRestaurantFloor, IKitchenOrder,
} from './entities/index.js'

/**
 * Registry of all repositories, keyed by entity name.
 * This is the single entry point for all data access in business logic.
 */
export interface RepositoryRegistry {
  // Core
  orgs: IBatchRepository<IOrg>
  users: IBatchRepository<IUser>
  invites: IBatchRepository<IInvite>
  codes: IBatchRepository<ICode>
  emailLogs: IBatchRepository<IEmailLog>
  auditLogs: IBatchRepository<IAuditLog>
  files: IBatchRepository<IFile>
  notifications: IBatchRepository<INotification>
  backgroundTasks: IBatchRepository<IBackgroundTask>
  orgApps: IBatchRepository<IOrgApp>
  tags: IBatchRepository<ITag>

  // Accounting
  accounts: IBatchRepository<IAccount>
  fiscalYears: IBatchRepository<IFiscalYear>
  fiscalPeriods: IBatchRepository<IFiscalPeriod>
  journalEntries: IBatchRepository<IJournalEntry>
  fixedAssets: IBatchRepository<IFixedAsset>
  bankAccounts: IBatchRepository<IBankAccount>
  bankReconciliations: IBatchRepository<IBankReconciliation>
  taxReturns: IBatchRepository<ITaxReturn>
  exchangeRates: IBatchRepository<IExchangeRate>

  // Invoicing
  contacts: IBatchRepository<IContact>
  invoices: IBatchRepository<IInvoice>
  paymentOrders: IBatchRepository<IPaymentOrder>
  cashOrders: IBatchRepository<ICashOrder>

  // Warehouse
  products: IBatchRepository<IProduct>
  warehouses: IBatchRepository<IWarehouse>
  stockLevels: IBatchRepository<IStockLevel>
  stockMovements: IBatchRepository<IStockMovement>
  inventoryCounts: IBatchRepository<IInventoryCount>
  priceLists: IBatchRepository<IPriceList>
  costLayers: IBatchRepository<ICostLayer>
  productCategories: IBatchRepository<IProductCategory>

  // Payroll
  employees: IBatchRepository<IEmployee>
  payrollRuns: IBatchRepository<IPayrollRun>
  payslips: IBatchRepository<IPayslip>
  timesheets: IBatchRepository<ITimesheet>

  // HR
  departments: IBatchRepository<IDepartment>
  leaveTypes: IBatchRepository<ILeaveType>
  leaveRequests: IBatchRepository<ILeaveRequest>
  leaveBalances: IBatchRepository<ILeaveBalance>
  businessTrips: IBatchRepository<IBusinessTrip>
  employeeDocuments: IBatchRepository<IEmployeeDocument>

  // CRM
  leads: IBatchRepository<ILead>
  deals: IBatchRepository<IDeal>
  pipelines: IBatchRepository<IPipeline>
  activities: IBatchRepository<IActivity>

  // ERP
  billOfMaterials: IBatchRepository<IBillOfMaterials>
  productionOrders: IBatchRepository<IProductionOrder>
  constructionProjects: IBatchRepository<IConstructionProject>
  posSessions: IBatchRepository<IPOSSession>
  posTransactions: IBatchRepository<IPOSTransaction>

  // Fiscal / SUPTO
  fiscalDevices: IBatchRepository<IFiscalDevice>
  workstations: IBatchRepository<IWorkstation>

  // Sales
  salesOrders: IBatchRepository<ISalesOrder>
  quotationTemplates: IBatchRepository<IQuotationTemplate>

  // Purchase
  purchaseOrders: IBatchRepository<IPurchaseOrder>
  blanketOrders: IBatchRepository<IBlanketOrder>
  reorderRules: IBatchRepository<IReorderRule>

  // Project
  projects: IBatchRepository<IProject>
  projectTasks: IBatchRepository<IProjectTask>
  projectMilestones: IBatchRepository<IProjectMilestone>
  projectTimesheets: IBatchRepository<IProjectTimesheet>

  // Helpdesk
  tickets: IBatchRepository<ITicket>
  helpdeskTeams: IBatchRepository<IHelpdeskTeam>
  slaPolicies: IBatchRepository<ISLAPolicy>

  // Documents
  documents: IBatchRepository<IDocumentRecord>
  documentWorkspaces: IBatchRepository<IDocumentWorkspace>
  signatureRequests: IBatchRepository<ISignatureRequest>

  // Subscriptions
  subscriptions: IBatchRepository<ISubscription>

  // Approvals
  approvalTypes: IBatchRepository<IApprovalType>
  approvalRequests: IBatchRepository<IApprovalRequest>

  // Planning
  shifts: IBatchRepository<IShift>
  shiftTemplates: IBatchRepository<IShiftTemplate>
  appointmentTypes: IBatchRepository<IAppointmentType>
  appointments: IBatchRepository<IAppointment>

  // Recruitment & Appraisals
  jobPositions: IBatchRepository<IJobPosition>
  applicants: IBatchRepository<IApplicant>
  appraisals: IBatchRepository<IAppraisal>

  // Fleet
  vehicles: IBatchRepository<IVehicle>
  vehicleCosts: IBatchRepository<IVehicleCost>

  // Maintenance
  equipment: IBatchRepository<IEquipment>
  maintenanceRequests: IBatchRepository<IMaintenanceRequest>

  // Knowledge
  knowledgeArticles: IBatchRepository<IKnowledgeArticle>

  // Field Service
  fieldServiceTasks: IBatchRepository<IFieldServiceTask>

  // Manufacturing (Advanced MRP + PLM)
  workCenters: IBatchRepository<IWorkCenter>
  routings: IBatchRepository<IRouting>
  ecos: IBatchRepository<IECO>

  // POS Restaurant
  restaurantFloors: IBatchRepository<IRestaurantFloor>
  kitchenOrders: IBatchRepository<IKitchenOrder>
}

/** All repository keys */
export type RepositoryKey = keyof RepositoryRegistry
