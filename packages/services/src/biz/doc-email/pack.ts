import { MAX_DOCS_PER_MAIL } from 'config/doc-email'

/**
 * How many attachments one mail carries (2026-11-16), by count and by bytes.
 *
 * Both of `sendEmail`'s paths refuse a mail that is too heavy, and by then every PDF has been rendered: so the
 * documents are packed to fit before anything is sent. Each path counts in its own unit, and one figure serves both:
 * an attachment's base64 text is `4 · ⌈n / 3⌉` characters, which is `attachmentWeight(n) / 3 · 4`.
 *   - on a master (`queueMail`): the decoded bytes of the base64 text, `⌊chars · 3 / 4⌋`, against
 *     `config.relay.maxAttachmentBytes`. That is `attachmentWeight(n)` exactly;
 *   - anywhere else: the base64 characters themselves, against `MAX_ATTACHMENT_BYTES`. That is the weight against
 *     three quarters of it.
 * `engine.ts#mailLimits` turns the node's cap into `maxBytes` of this weight.
 *
 * Import-pure.
 */

export interface MailLimits {
  /** Attachments in one mail. The relay takes 10, and one request carries no more documents than that. */
  maxAttachments: number
  /** The sum of `attachmentWeight` one mail may carry. */
  maxBytes: number
}

/** A file's size as both mail paths count it: rounded up to whole base64 groups. */
export function attachmentWeight(bytes: number): number {
  return 3 * Math.ceil(Math.max(0, bytes) / 3)
}

export interface Packing {
  /** Indices into the input, a mail each, in the input's order. */
  mails: number[][]
  /** Indices of files no mail can carry: heavier than `maxBytes` alone. */
  tooLarge: number[]
}

/**
 * The files of one request, as mails. In order, never reordered to pack tighter: twelve invoices go as the first
 * ten and the last two, which is what the person who ticked them expects to find.
 */
export function packAttachments(sizes: readonly number[], limits: MailLimits): Packing {
  const maxAttachments = Math.max(1, Math.floor(limits.maxAttachments || MAX_DOCS_PER_MAIL))
  const mails: number[][] = []
  const tooLarge: number[] = []
  let current: number[] = []
  let weight = 0
  sizes.forEach((size, index) => {
    const w = attachmentWeight(size)
    if (w > limits.maxBytes) {
      tooLarge.push(index)
      return
    }
    if (current.length && (current.length >= maxAttachments || weight + w > limits.maxBytes)) {
      mails.push(current)
      current = []
      weight = 0
    }
    current.push(index)
    weight += w
  })
  if (current.length) mails.push(current)
  return { mails, tooLarge }
}
