import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('HR Module', () => {
  test('should navigate to departments and verify data table renders', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/hr/departments')

    // DepartmentsView uses <h1 class="text-h4"> with i18n key hr.departments
    await expect(page.getByRole('heading', { name: /departments/i })).toBeVisible()

    // Verify data table is rendered (uses v-data-table directly)
    await expect(page.locator('.v-data-table')).toBeVisible()

    // Verify Create button is present
    await expect(page.getByRole('button', { name: /create/i })).toBeVisible()
  })

  test('should navigate to leave management and verify renders', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/hr/leave')

    // LeaveManagementView uses <h1 class="text-h4"> with i18n key hr.leaveManagement
    await expect(page.getByRole('heading', { name: /leave management/i })).toBeVisible()

    // Verify the "Request Leave" button is present (i18n key: hr.requestLeave)
    await expect(page.getByRole('button', { name: /request leave/i })).toBeVisible()

    // Verify tabs are rendered: "Leave Requests" and "Leave Balances" (i18n keys)
    await expect(page.getByRole('tab', { name: /requests/i })).toBeVisible()
    await expect(page.getByRole('tab', { name: /balances/i })).toBeVisible()

    // Verify data table is rendered under the default Requests tab
    await expect(page.locator('.v-data-table')).toBeVisible()
  })

  test('should show leave requests tab with status column', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/hr/leave')

    // Ensure the Requests tab is active by default
    const requestsTab = page.getByRole('tab', { name: /requests/i })
    await expect(requestsTab).toBeVisible()
    await requestsTab.click()

    // Verify the data table renders with expected column headers
    const table = page.locator('.v-data-table')
    await expect(table).toBeVisible()

    // Check that status column header is present
    await expect(table.locator('th', { hasText: /status/i })).toBeVisible()

    // Check that actions column header is present
    await expect(table.locator('th', { hasText: /actions/i }).or(
      table.locator('th').last()
    )).toBeVisible()
  })

  test('should navigate to business trips and verify list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/hr/business-trips')

    // BusinessTripsView uses <h1 class="text-h4"> with i18n key hr.businessTrips
    await expect(page.getByRole('heading', { name: /business trips/i })).toBeVisible()

    // Verify data table is rendered
    await expect(page.locator('.v-data-table')).toBeVisible()

    // Verify Create button is present
    await expect(page.getByRole('button', { name: /create/i })).toBeVisible()
  })

  test('should navigate to employee documents and verify renders', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/hr/documents')

    // EmployeeDocumentsView uses <h1 class="text-h4"> with i18n key hr.employeeDocuments
    await expect(page.getByRole('heading', { name: /employee documents/i })).toBeVisible()

    // Verify data table is rendered
    await expect(page.locator('.v-data-table')).toBeVisible()

    // Verify Upload button is present (i18n key: common.upload)
    await expect(page.getByRole('button', { name: /upload/i })).toBeVisible()
  })

  test('should open leave request creation form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/hr/leave')

    // Click the Request Leave button to open the dialog
    await page.getByRole('button', { name: /request leave/i }).click()

    // Verify the dialog form opens
    const dialog = page.locator('.v-dialog')
    await expect(dialog).toBeVisible()

    // Verify form fields are present
    // Employee field (label: payroll.employee)
    await expect(dialog.getByLabel(/employee/i)).toBeVisible()
    // Leave type field (label: hr.leaveType)
    await expect(dialog.getByLabel(/leave type/i)).toBeVisible()
    // Date from field (label: common.dateFrom)
    await expect(dialog.getByLabel(/date from|from/i).first()).toBeVisible()
    // Date to field (label: common.dateTo)
    await expect(dialog.getByLabel(/date to|to/i).first()).toBeVisible()
    // Reason field (label: invoicing.reason)
    await expect(dialog.getByLabel(/reason/i)).toBeVisible()

    // Verify Save and Cancel buttons
    await expect(dialog.getByRole('button', { name: /save/i })).toBeVisible()
    await expect(dialog.getByRole('button', { name: /cancel/i })).toBeVisible()
  })
})
