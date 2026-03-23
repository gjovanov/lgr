/**
 * Cross-module event handlers.
 * Register these at startup after service context is initialized.
 */
import { logger } from '../logger/logger.js'

let _registered = false
export function registerEventHandlers(): void {
  if (_registered) {
    logger.warn('Event handlers already registered — skipping')
    return
  }
  _registered = true

  logger.info('Cross-module event handlers registered')
}

/** Reset registration guard (for tests only). */
export function resetEventHandlers(): void {
  _registered = false
}
