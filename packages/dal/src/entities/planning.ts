import type { TenantEntity } from '../types.js'

export interface IShift extends TenantEntity {
  employeeId?: string
  roleId?: string
  projectId?: string
  taskId?: string
  dateStart: Date
  dateEnd: Date
  hours: number
  state: string
  isRecurring: boolean
  recurringTemplateId?: string
  notes?: string
  color?: string
  createdBy: string
}

export interface IShiftTemplateEntry {
  roleId?: string
  dayOfWeek: number
  startTime: string
  endTime: string
}

export interface IShiftTemplate extends TenantEntity {
  name: string
  entries: IShiftTemplateEntry[]
  isActive: boolean
}

export interface IAppointmentQuestion {
  label: string
  type: string
  required: boolean
  options?: string[]
}

export interface IAppointmentType extends TenantEntity {
  name: string
  duration: number
  assigneeIds: string[]
  location: string
  autoConfirm: boolean
  reminderMinutes: number[]
  customQuestions: IAppointmentQuestion[]
  isPublic: boolean
  isActive: boolean
}

export interface IAppointmentAnswer {
  questionLabel: string
  answer: string
}

export interface IAppointment extends TenantEntity {
  typeId: string
  partnerId?: string
  assigneeId: string
  dateStart: Date
  dateEnd: Date
  state: string
  meetingUrl?: string
  notes?: string
  answers: IAppointmentAnswer[]
  leadId?: string
  remindersSent: Date[]
  createdBy: string
}
