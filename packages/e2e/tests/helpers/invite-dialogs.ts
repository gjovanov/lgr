import type { Locator, Page } from '@playwright/test'

/**
 * The Invites screen has two dialogs, and while one leaves the other arrives: creating an invite closes
 * the form and opens a dialog that shows what became of it (#510). A bare `.v-dialog` therefore names
 * two elements for a moment, and Playwright's strict mode rejects it. Name each one by what is in it.
 */

/** The form that makes an invite, found by its title. */
export function createInviteDialog(page: Page): Locator {
  return page.locator('.v-dialog').filter({ has: page.locator('.v-card-title', { hasText: 'Create Invite' }) })
}

/** The dialog that shows an invite's status and link once it is made, found by the link field. */
export function inviteResultDialog(page: Page): Locator {
  return page.locator('.v-dialog').filter({ has: page.getByTestId('invite-result-link') })
}

/** The result dialog's link: `<app>/invite/<code>`. The test id sits on the field, so the value is the input inside it. */
export function inviteResultLink(result: Locator): Locator {
  return result.getByTestId('invite-result-link').locator('input')
}
