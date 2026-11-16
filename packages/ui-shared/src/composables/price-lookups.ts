/**
 * FR-31.5: a line's price lookup that waits for the typing in its quantity to stop.
 *
 * `PriceCombobox` looks the price up again when the quantity changes, 250 ms after the last keystroke: typing „120"
 * makes one lookup, not three. While one waits it is registered here, so that leaving the quantity field or saving
 * runs it at once (`flushPriceLookups`): what is saved is the price of the quantity on the screen, never the price of
 * a quantity that was already replaced.
 */

export const PRICE_LOOKUP_DELAY_MS = 250

const waiting = new Set<() => Promise<void>>()

/** A lookup is waiting; `run` does it now. Returns the way to say it no longer waits. */
export function waitingPriceLookup(run: () => Promise<void>): () => void {
  waiting.add(run)
  return () => {
    waiting.delete(run)
  }
}

/** Run every waiting lookup now, and wait for their answers. */
export async function flushPriceLookups(): Promise<void> {
  await Promise.all([...waiting].map((run) => run()))
}
