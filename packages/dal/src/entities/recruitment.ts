import type { TenantEntity } from '../types.js'

export interface IJobPosition extends TenantEntity {
  name: string; departmentId: string; description: string; requirements?: string
  salaryMin?: number; salaryMax?: number; salaryCurrency: string
  state: string; publishedDate?: Date; closingDate?: Date
  expectedHires: number; hiredCount: number; createdBy: string
}

export interface IApplicant extends TenantEntity {
  jobPositionId: string; name: string; email: string; phone?: string
  stageName: string; source: string; referrerId?: string; resumeFileId?: string
  rating: number; interviewDate?: Date; notes?: string; state: string
  salary?: number; createdBy: string
}

export interface IAppraisalAnswer { question: string; answer: string; rating?: number }
export interface IAppraisalGoal { description: string; status: string }

export interface IAppraisal extends TenantEntity {
  employeeId: string; reviewerId: string; state: string
  dateScheduled: Date; dateCompleted?: Date
  selfEvaluation: IAppraisalAnswer[]; managerEvaluation: IAppraisalAnswer[]
  overallRating: number; goals: IAppraisalGoal[]; nextAppraisalDate?: Date; notes?: string
}
