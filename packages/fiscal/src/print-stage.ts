import type { PrintStage } from 'services/biz/cash-register/print-verdict'

/**
 * How far a receipt got, on the error of a print that throws. It is what `verdictOfFailedPrint` reads
 * first: before the money nothing can close the document, whatever the counter says, and from the
 * first payment SENT the device may hold the money.
 *
 * `print` says each stage as it reaches it. It starts at `opening`.
 */
export async function stagedPrint<T>(print: (reached: (stage: PrintStage) => void) => Promise<T>): Promise<T> {
  let stage: PrintStage = 'opening'
  try {
    return await print((s) => { stage = s })
  } catch (e) {
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { printStage: stage })
  }
}
