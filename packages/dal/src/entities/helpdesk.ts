import type { TenantEntity } from '../types.js'

export interface ITicket extends TenantEntity {
  name: string
  description: string
  channelSource: string
  partnerId?: string
  assigneeId?: string
  teamId?: string
  stageName: string
  state: string
  priority: string
  slaDeadline?: Date
  slaStatus: string
  tags?: string[]
  categoryId?: string
  rating?: number
  ratingComment?: string
  totalHours: number
  roomId?: string
  relatedEntityType?: string
  relatedEntityId?: string
  firstResponseDate?: Date
  resolutionDate?: Date
  closedDate?: Date
  createdBy: string
}

export interface IHelpdeskTeam extends TenantEntity {
  name: string
  memberIds: string[]
  leaderId: string
  assignmentMethod: string
  emailAlias?: string
  description?: string
  isActive: boolean
}

export interface ISLATarget {
  firstResponseHours?: number
  resolutionHours?: number
}

export interface ISLAPolicy extends TenantEntity {
  name: string
  teamId?: string
  priority: string
  targets: ISLATarget
  businessHoursOnly: boolean
  escalateTo?: string
  isActive: boolean
}
