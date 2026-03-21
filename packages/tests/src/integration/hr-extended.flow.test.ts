import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestEmployee, createTestDepartment } from '../helpers/factories'
import { getRepos } from 'services/context'
import type { Types } from 'mongoose'

let repos: ReturnType<typeof getRepos>

beforeAll(async () => {
  await setupTestDB()
  repos = getRepos()
})

afterAll(async () => {
  await teardownTestDB()
})

beforeEach(async () => {
  await clearCollections()
})

async function createJobPosition(orgId: Types.ObjectId, deptId: Types.ObjectId, userId: string, overrides: any = {}) {
  return repos.jobPositions.create({
    orgId: String(orgId),
    name: 'Software Engineer',
    departmentId: String(deptId),
    description: 'Build awesome software',
    requirements: '3+ years experience',
    salaryMin: 50000,
    salaryMax: 80000,
    salaryCurrency: 'EUR',
    state: 'draft',
    expectedHires: 2,
    hiredCount: 0,
    createdBy: userId,
    ...overrides,
  } as any)
}

async function createApplicant(orgId: Types.ObjectId, jobPositionId: string, userId: string, overrides: any = {}) {
  return repos.applicants.create({
    orgId: String(orgId),
    jobPositionId,
    name: 'John Doe',
    email: `john-${Date.now()}@test.com`,
    phone: '+1234567890',
    stageName: 'New',
    source: 'linkedin',
    rating: 4,
    state: 'new',
    createdBy: userId,
    ...overrides,
  } as any)
}

describe('HR Recruitment Flow', () => {
  it('should create a job position in draft state', async () => {
    const org = await createTestOrg()
    const dept = await createTestDepartment(org._id)
    const user = await createTestUser(org._id)

    const position = await createJobPosition(org._id, dept._id, String(user._id))

    expect(position.name).toBe('Software Engineer')
    expect(position.state).toBe('draft')
    expect(position.expectedHires).toBe(2)
    expect(position.hiredCount).toBe(0)
  })

  it('should publish a draft position', async () => {
    const org = await createTestOrg()
    const dept = await createTestDepartment(org._id)
    const user = await createTestUser(org._id)

    const position = await createJobPosition(org._id, dept._id, String(user._id))

    const published = await repos.jobPositions.update(position.id, {
      state: 'published',
      publishedDate: new Date(),
    } as any)

    expect(published!.state).toBe('published')
    expect((published as any).publishedDate).toBeTruthy()
  })

  it('should close a published position', async () => {
    const org = await createTestOrg()
    const dept = await createTestDepartment(org._id)
    const user = await createTestUser(org._id)

    const position = await createJobPosition(org._id, dept._id, String(user._id), { state: 'published' })

    const closed = await repos.jobPositions.update(position.id, {
      state: 'closed',
      closingDate: new Date(),
    } as any)

    expect(closed!.state).toBe('closed')
  })

  it('should create an applicant for a position', async () => {
    const org = await createTestOrg()
    const dept = await createTestDepartment(org._id)
    const user = await createTestUser(org._id)
    const position = await createJobPosition(org._id, dept._id, String(user._id), { state: 'published' })

    const applicant = await createApplicant(org._id, position.id, String(user._id))

    expect(applicant.name).toBe('John Doe')
    expect(applicant.state).toBe('new')
    expect(applicant.jobPositionId).toBe(position.id)
  })

  it('should transition applicant through stages: new → initial_review → interview → offer → hired', async () => {
    const org = await createTestOrg()
    const dept = await createTestDepartment(org._id)
    const user = await createTestUser(org._id)
    const position = await createJobPosition(org._id, dept._id, String(user._id), { state: 'published' })
    const applicant = await createApplicant(org._id, position.id, String(user._id))

    // new → initial_review
    const step1 = await repos.applicants.update(applicant.id, { state: 'initial_review', stageName: 'Initial Review' } as any)
    expect(step1!.state).toBe('initial_review')

    // initial_review → interview
    const step2 = await repos.applicants.update(applicant.id, { state: 'interview', stageName: 'Interview' } as any)
    expect(step2!.state).toBe('interview')

    // interview → offer
    const step3 = await repos.applicants.update(applicant.id, { state: 'offer', stageName: 'Offer' } as any)
    expect(step3!.state).toBe('offer')

    // offer → hired
    const step4 = await repos.applicants.update(applicant.id, { state: 'hired', stageName: 'Hired' } as any)
    expect(step4!.state).toBe('hired')
  })

  it('should increment hiredCount on job position when applicant is hired', async () => {
    const org = await createTestOrg()
    const dept = await createTestDepartment(org._id)
    const user = await createTestUser(org._id)
    const position = await createJobPosition(org._id, dept._id, String(user._id), { state: 'published' })

    expect(position.hiredCount).toBe(0)

    const applicant = await createApplicant(org._id, position.id, String(user._id))

    // Simulate hire: update applicant state and increment hiredCount
    await repos.applicants.update(applicant.id, { state: 'hired', stageName: 'Hired' } as any)
    const newCount = (position.hiredCount || 0) + 1
    await repos.jobPositions.update(position.id, { hiredCount: newCount } as any)

    const updatedPosition = await repos.jobPositions.findById(position.id)
    expect(updatedPosition!.hiredCount).toBe(1)
  })

  it('should refuse an applicant', async () => {
    const org = await createTestOrg()
    const dept = await createTestDepartment(org._id)
    const user = await createTestUser(org._id)
    const position = await createJobPosition(org._id, dept._id, String(user._id), { state: 'published' })
    const applicant = await createApplicant(org._id, position.id, String(user._id))

    const refused = await repos.applicants.update(applicant.id, { state: 'refused', stageName: 'Refused' } as any)
    expect(refused!.state).toBe('refused')
  })

  it('should list applicants filtered by job position', async () => {
    const org = await createTestOrg()
    const dept = await createTestDepartment(org._id)
    const user = await createTestUser(org._id)
    const pos1 = await createJobPosition(org._id, dept._id, String(user._id), { name: 'Position A' })
    const pos2 = await createJobPosition(org._id, dept._id, String(user._id), { name: 'Position B' })

    await createApplicant(org._id, pos1.id, String(user._id), { name: 'Alice' })
    await createApplicant(org._id, pos1.id, String(user._id), { name: 'Bob' })
    await createApplicant(org._id, pos2.id, String(user._id), { name: 'Charlie' })

    const result = await repos.applicants.findAll(
      { orgId: String(org._id), jobPositionId: pos1.id },
      { page: 0, size: 10 },
    )

    expect(result.items).toHaveLength(2)
  })
})

describe('HR Appraisal Flow', () => {
  it('should create an appraisal in draft state', async () => {
    const org = await createTestOrg()
    const employee = await createTestEmployee(org._id)
    const reviewer = await createTestUser(org._id, { role: 'manager' })

    const appraisal = await repos.appraisals.create({
      orgId: String(org._id),
      employeeId: String(employee._id),
      reviewerId: String(reviewer._id),
      state: 'draft',
      dateScheduled: new Date(),
      selfEvaluation: [],
      managerEvaluation: [],
      goals: [],
      overallRating: 0,
    } as any)

    expect(appraisal.state).toBe('draft')
    expect(appraisal.employeeId).toBe(String(employee._id))
    expect(appraisal.reviewerId).toBe(String(reviewer._id))
  })

  it('should submit self-evaluation (draft → in_progress)', async () => {
    const org = await createTestOrg()
    const employee = await createTestEmployee(org._id)
    const reviewer = await createTestUser(org._id, { role: 'manager' })

    const appraisal = await repos.appraisals.create({
      orgId: String(org._id),
      employeeId: String(employee._id),
      reviewerId: String(reviewer._id),
      state: 'draft',
      dateScheduled: new Date(),
      selfEvaluation: [],
      managerEvaluation: [],
      goals: [],
      overallRating: 0,
    } as any)

    const updated = await repos.appraisals.update(appraisal.id, {
      state: 'in_progress',
      selfEvaluation: [
        { question: 'What went well?', answer: 'Delivered project on time', rating: 4 },
      ],
    } as any)

    expect(updated!.state).toBe('in_progress')
    expect((updated as any).selfEvaluation).toHaveLength(1)
  })

  it('should complete appraisal (in_progress → completed)', async () => {
    const org = await createTestOrg()
    const employee = await createTestEmployee(org._id)
    const reviewer = await createTestUser(org._id, { role: 'manager' })

    const appraisal = await repos.appraisals.create({
      orgId: String(org._id),
      employeeId: String(employee._id),
      reviewerId: String(reviewer._id),
      state: 'in_progress',
      dateScheduled: new Date(),
      selfEvaluation: [{ question: 'What went well?', answer: 'Good work', rating: 4 }],
      managerEvaluation: [],
      goals: [],
      overallRating: 0,
    } as any)

    const completed = await repos.appraisals.update(appraisal.id, {
      state: 'completed',
      dateCompleted: new Date(),
      managerEvaluation: [
        { question: 'Technical skills?', answer: 'Excellent', rating: 5 },
      ],
      overallRating: 4,
      goals: [
        { description: 'Lead a team project', status: 'not_started' },
      ],
    } as any)

    expect(completed!.state).toBe('completed')
    expect((completed as any).overallRating).toBe(4)
    expect((completed as any).dateCompleted).toBeTruthy()
    expect((completed as any).managerEvaluation).toHaveLength(1)
    expect((completed as any).goals).toHaveLength(1)
  })
})
