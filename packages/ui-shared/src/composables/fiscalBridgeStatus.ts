import { ref } from 'vue'

export type FiscalBridgeStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

/**
 * Whether this tab holds a fiscal printer, apart from the driver (`useFiscalBridge`), so the shell
 * and the one SPA's stale-build check can read it without loading the serial protocol into the
 * first page load (FR-24.15). `useFiscalBridge` writes it; nothing else does.
 */
export const fiscalBridgeStatus = ref<FiscalBridgeStatus>('disconnected')