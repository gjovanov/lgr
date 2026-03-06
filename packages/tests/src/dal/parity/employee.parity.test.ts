import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import type { RepositoryRegistry } from 'dal'
import { setupMongoRepos, setupSQLiteRepos, teardownMongo, teardownSQLite, createTestOrg } from '../helpers/dal-test-setup'

const backends: [string, () => Promise<RepositoryRegistry>, () => Promise<void>][] = [
  ['mongo', setupMongoRepos, teardownMongo],
  ['sqlite', setupSQLiteRepos, teardownSQLite],
]

for (const [name, setup, cleanup] of backends) {
  describe(`Employee Repository [${name}]`, () => {
    let repos: RepositoryRegistry
    let orgId: string

    beforeAll(async () => {
      repos = await setup()
    })

    beforeEach(async () => {
      await cleanup()
      orgId = await createTestOrg(repos)
    })

    afterAll(async () => {
      // cleanup handled by process exit
    })

    function makeEmployee(overrides: Record<string, any> = {}) {
      return {
        orgId,
        employeeNumber: `EMP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
        phone: '+1234567890',
        department: 'Engineering',
        position: 'Developer',
        employmentType: 'full_time',
        contractStartDate: new Date('2025-01-15'),
        status: 'active',
        salary: {
          baseSalary: 5000,
          currency: 'EUR',
          frequency: 'monthly',
        },
        deductions: [],
        benefits: [],
        documents: [],
        ...overrides,
      } as any
    }

    test('creates employee with embedded salary JSON and retrieves it', async () => {
      const emp = await repos.employees.create(makeEmployee())

      expect(emp.id).toBeDefined()
      expect(emp.firstName).toBe('John')
      expect(emp.lastName).toBe('Doe')
      expect(emp.salary.baseSalary).toBe(5000)
      expect(emp.salary.currency).toBe('EUR')

      const found = await repos.employees.findById(emp.id)
      expect(found).not.toBeNull()
      expect(found!.salary.baseSalary).toBe(5000)
      expect(found!.salary.frequency).toBe('monthly')
    })

    test('creates employee with deductions and benefits child tables', async () => {
      const emp = await repos.employees.create(makeEmployee({
        deductions: [
          { type: 'tax', name: 'Income Tax', percentage: 10 },
          { type: 'social', name: 'Social Security', amount: 200 },
        ],
        benefits: [
          { type: 'health', name: 'Health Insurance', value: 300 },
        ],
      }))

      expect(emp.deductions).toHaveLength(2)
      expect(emp.deductions[0].type).toBe('tax')
      expect(emp.deductions[0].percentage).toBe(10)
      expect(emp.deductions[1].amount).toBe(200)
      expect(emp.benefits).toHaveLength(1)
      expect(emp.benefits[0].value).toBe(300)

      const found = await repos.employees.findById(emp.id)
      expect(found!.deductions).toHaveLength(2)
      expect(found!.benefits).toHaveLength(1)
      expect(found!.benefits[0].name).toBe('Health Insurance')
    })

    test('update replaces deductions child table', async () => {
      const emp = await repos.employees.create(makeEmployee({
        deductions: [{ type: 'tax', name: 'Old Tax', percentage: 10 }],
      }))

      const updated = await repos.employees.update(emp.id, {
        deductions: [
          { type: 'tax', name: 'New Tax', percentage: 15 },
          { type: 'pension', name: 'Pension Fund', amount: 150 },
        ],
      } as any)

      expect(updated!.deductions).toHaveLength(2)
      expect(updated!.deductions[0].name).toBe('New Tax')
      expect(updated!.deductions[0].percentage).toBe(15)
    })

    test('update parent fields preserves children', async () => {
      const emp = await repos.employees.create(makeEmployee({
        deductions: [{ type: 'tax', name: 'Income Tax', percentage: 10 }],
        benefits: [{ type: 'health', name: 'Health', value: 300 }],
      }))

      const updated = await repos.employees.update(emp.id, {
        position: 'Senior Developer',
        salary: { baseSalary: 6000, currency: 'EUR', frequency: 'monthly' },
      } as any)

      expect(updated!.position).toBe('Senior Developer')
      expect(updated!.salary.baseSalary).toBe(6000)
      expect(updated!.deductions).toHaveLength(1)
      expect(updated!.benefits).toHaveLength(1)
    })

    test('unique employee number per org', async () => {
      const empNum = `UNIQUE-${Date.now()}`
      await repos.employees.create(makeEmployee({ employeeNumber: empNum }))

      await expect(
        repos.employees.create(makeEmployee({ employeeNumber: empNum })),
      ).rejects.toThrow()
    })

    test('findMany by department', async () => {
      await repos.employees.create(makeEmployee({ employeeNumber: 'E1', department: 'Engineering' }))
      await repos.employees.create(makeEmployee({ employeeNumber: 'E2', department: 'Engineering' }))
      await repos.employees.create(makeEmployee({ employeeNumber: 'E3', department: 'Sales' }))

      const engineers = await repos.employees.findMany({ orgId, department: 'Engineering' })
      expect(engineers).toHaveLength(2)
      for (const e of engineers) {
        expect(e.department).toBe('Engineering')
      }
    })

    test('delete cascades to deductions and benefits', async () => {
      const emp = await repos.employees.create(makeEmployee({
        deductions: [{ type: 'tax', name: 'Tax', percentage: 10 }],
        benefits: [{ type: 'health', name: 'Health', value: 300 }],
      }))

      expect(await repos.employees.delete(emp.id)).toBe(true)
      expect(await repos.employees.findById(emp.id)).toBeNull()
    })

    test('count by status', async () => {
      await repos.employees.create(makeEmployee({ employeeNumber: 'C1', status: 'active' }))
      await repos.employees.create(makeEmployee({ employeeNumber: 'C2', status: 'active' }))
      await repos.employees.create(makeEmployee({ employeeNumber: 'C3', status: 'terminated' }))

      const activeCount = await repos.employees.count({ orgId, status: 'active' })
      expect(activeCount).toBe(2)
    })
  })
}
