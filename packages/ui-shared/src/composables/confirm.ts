import { reactive } from 'vue'

/**
 * The app's own confirm dialog (FR-31.17), opened by a function that returns the answer:
 *
 *   if (!(await askConfirm({ text: t('invoicing.deleteOrderConfirm'), confirm: t('common.delete'), danger: true }))) return
 *
 * The browser's `confirm()` has two buttons, „OK" and „Отказ", that both read as cancelling, in the browser's language
 * and not the app's. This one names the action on its button (`confirm`), in the session's language. One question is
 * open at a time: asking again answers the open one No. `ConfirmDialogHost` (in the one shell, `web/App.vue`) draws it.
 * `unit/no-browser-dialogs.test.ts` fails on `confirm(`, `alert(` or `prompt(` of the browser in UI source.
 */
export interface ConfirmAsk {
  /** The question. */
  text: string
  /** A title above it; nothing for none. */
  title?: string
  /** The button that does it, named for what it does („Изтрий"). */
  confirm: string
  /** The button that does not; `common.cancel` when not given. */
  cancel?: string
  /** A destructive action: its button is red. */
  danger?: boolean
}

export const confirmState = reactive<{ open: boolean; ask: ConfirmAsk | null }>({ open: false, ask: null })
let answer: ((yes: boolean) => void) | null = null

export function askConfirm(ask: ConfirmAsk): Promise<boolean> {
  answer?.(false)
  confirmState.ask = ask
  confirmState.open = true
  return new Promise(resolve => { answer = resolve })
}

/** The person answered (or closed the dialog: No). */
export function answerConfirm(yes: boolean): void {
  const done = answer
  answer = null
  confirmState.open = false
  done?.(yes)
}
