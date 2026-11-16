<template>
  <v-dialog :model-value="modelValue" max-width="760" scrollable :persistent="phase === 'sending'" @update:model-value="onModel">
    <v-card data-testid="batch-email-dialog" :data-kind="kind" :data-phase="phase">
      <v-card-title class="d-flex align-center ga-2">
        <v-icon>mdi-email-arrow-right-outline</v-icon>
        {{ $t('docEmail.title') }}
      </v-card-title>

      <v-card-text>
        <v-progress-linear v-if="phase === 'loading'" indeterminate class="mb-2" />
        <v-alert v-if="loadFailed" type="error" variant="tonal" density="compact" data-testid="batch-email-load-error">
          {{ loadError || $t('common.operationFailed') }}
        </v-alert>

        <!-- What will go, to whom, and under what words. -->
        <template v-if="phase === 'compose' && !loadFailed">
          <p class="text-body-2 text-medium-emphasis mb-3" data-testid="batch-email-intro">
            {{ sendable.length ? $t('docEmail.intro', sendable.length) : $t('docEmail.nothing') }}
          </p>

          <!-- What the server will not mail, and why: a draft, a document this role does not send. -->
          <v-alert v-if="blocked.length" type="warning" variant="tonal" density="compact" class="mb-3" data-testid="batch-email-blocked">
            <div class="font-weight-medium">{{ $t('docEmail.blockedTitle', { n: blocked.length }) }}</div>
            <div v-for="b in blockedByReason" :key="b.reason" class="text-body-2" :data-reason="b.reason" :title="wholeList(b.numbers)">
              <template v-if="b.numbers.length">{{ listed(b.numbers) }} — {{ reasonText(b.reason) }}</template>
              <template v-else>{{ reasonText(b.reason) }} ({{ b.count }})</template>
            </div>
          </v-alert>

          <template v-if="sendable.length">
            <div class="text-subtitle-2">{{ $t('docEmail.recipient') }}</div>
            <v-radio-group v-model="mode" inline hide-details density="compact" class="mb-2">
              <v-radio value="partner" :label="$t('docEmail.modePartner')" :disabled="!hasPartner" class="me-4" data-testid="batch-email-mode-partner" />
              <v-radio value="single" :label="$t('docEmail.modeSingle')" data-testid="batch-email-mode-single" />
            </v-radio-group>

            <!-- A line per customer or supplier: the address on its card, which this mail may overrule. -->
            <div v-if="mode === 'partner'" data-testid="batch-email-recipients">
              <div
                v-for="group in groups"
                :key="group.key"
                class="batch-email-line"
                data-testid="batch-email-recipient"
                :data-partner="group.key"
              >
                <div class="batch-email-line__who">
                  <div class="font-weight-medium text-truncate" :title="nameOf(group)">{{ nameOf(group) }}</div>
                  <div class="text-caption text-medium-emphasis text-truncate" :title="numbersOf(group.rows)">
                    {{ $t('docEmail.nDocuments', group.rows.length) }}: {{ numbersOf(group.rows) }}
                  </div>
                </div>
                <v-text-field
                  v-model="addresses[group.key]"
                  type="email"
                  density="compact"
                  variant="outlined"
                  hide-details="auto"
                  prepend-inner-icon="mdi-at"
                  class="batch-email-line__to"
                  :placeholder="$t('docEmail.noAddress')"
                  :error-messages="plan.invalid.includes(group.key) ? [$t('validation.invalidEmail')] : []"
                  :aria-label="$t('docEmail.addressOf', { name: nameOf(group) })"
                />
              </div>
              <p class="text-caption text-medium-emphasis mt-1 mb-0">{{ $t('docEmail.partnerHint') }}</p>
            </div>

            <!-- One address for everything: a colleague, the accountant. -->
            <v-text-field
              v-else
              v-model="singleTo"
              type="email"
              density="compact"
              prepend-inner-icon="mdi-at"
              persistent-hint
              :label="$t('docEmail.singleTo')"
              :hint="$t('docEmail.singleHint')"
              :error-messages="plan.invalid.length ? [$t('validation.invalidEmail')] : []"
              data-testid="batch-email-single-to"
            />

            <v-text-field
              v-model="subject"
              density="compact"
              persistent-hint
              class="mt-4"
              :label="$t('docEmail.subject')"
              :hint="$t('docEmail.subjectHint')"
              data-testid="batch-email-subject"
            />
            <v-textarea
              v-model="message"
              rows="3"
              auto-grow
              density="compact"
              variant="outlined"
              hide-details
              class="mt-3"
              :label="$t('docEmail.message')"
              data-testid="batch-email-message"
            />
            <p v-if="totals.requests > totals.recipients" class="text-caption text-medium-emphasis mt-2 mb-0" data-testid="batch-email-several">
              {{ $t('docEmail.severalMails', { max: MAX_DOCS_PER_MAIL }) }}
            </p>
          </template>
        </template>

        <!-- One request per recipient, one after the other: this is how far it is. -->
        <div v-if="phase === 'sending'" data-testid="batch-email-progress">
          <p class="text-body-2 mb-2">{{ $t('docEmail.sending', { done: progress.done, total: progress.total }) }}</p>
          <v-progress-linear :model-value="progress.total ? (100 * progress.done) / progress.total : 0" height="6" rounded />
        </div>

        <!-- What became of each recipient's documents. Shown only when something did not go. -->
        <div v-if="phase === 'done'" data-testid="batch-email-results">
          <v-alert v-if="halted" type="error" variant="tonal" density="compact" class="mb-3" data-testid="batch-email-stopped">
            <div>{{ $t('docEmail.stopped') }}</div>
            <!-- The server's own words for why. -->
            <div v-if="stopped" class="text-body-2">{{ stopped }}</div>
          </v-alert>
          <div
            v-for="line in resultLines"
            :key="line.to"
            class="mb-2"
            data-testid="batch-email-result"
            :data-to="line.to"
            :data-state="line.state"
          >
            <div class="d-flex align-center ga-2 flex-wrap">
              <v-icon size="small" :color="line.color">{{ line.icon }}</v-icon>
              <span class="font-weight-medium">{{ line.to }}</span>
              <span class="text-body-2 text-medium-emphasis">{{ line.summary }}</span>
            </div>
            <div v-for="(left, i) in line.notSent" :key="i" class="text-body-2 ms-7" :title="left.detail || wholeList(left.numbers)">
              {{ listed(left.numbers) }} — {{ left.why }}
            </div>
          </div>
          <p v-if="anyQueued" class="text-caption text-medium-emphasis mt-2 mb-0">{{ $t('docEmail.queuedNote') }}</p>
          <p class="text-caption text-medium-emphasis mt-2 mb-0">{{ $t('docEmail.stayTicked') }}</p>
        </div>
      </v-card-text>

      <v-card-actions class="px-4 pb-3 flex-wrap">
        <span v-if="footNote" class="batch-email-note text-body-2" :class="footNote.error ? 'text-error' : 'text-medium-emphasis'" data-testid="batch-email-note">
          {{ footNote.text }}
        </span>
        <v-spacer />
        <v-btn variant="text" :disabled="phase === 'sending'" data-testid="batch-email-cancel" @click="close">
          {{ phase === 'done' ? $t('common.close') : $t('common.cancel') }}
        </v-btn>
        <v-btn
          v-if="phase !== 'done'"
          color="primary"
          variant="flat"
          prepend-icon="mdi-email-arrow-right-outline"
          :disabled="!canSend"
          :loading="phase === 'sending'"
          data-testid="batch-email-send"
          @click="submit"
        >
          {{ sendLabel }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDisplay } from 'vuetify'
import {
  DOC_EMAIL_BLOCKS, MAX_DOCS_PER_MAIL, wentOut, type DocEmailPreviewRow, type DocEmailRecipientGroup, type DocEmailResult,
} from 'config/doc-email'
import { shortList, useBatchEmail, type BatchEmailOutcome } from '../composables/useBatchEmail'
import { useSnackbar } from '../composables/useSnackbar'

/**
 * E-mailing a list's ticked documents (2026-11-16): one dialog for every kind of document.
 *
 * It opens on the ticked ids and asks the kind's preview what will go. The person chooses how the batch is addressed,
 * each document to its own customer or supplier (the default, a line per partner with the address on its card), or
 * everything to one address (a colleague, the accountant), and either way every address can be typed over. Then one
 * request per recipient, in turn, with the progress shown.
 *
 * When everything went the dialog closes and says so in a snackbar. When something did not, it stays on the results:
 * per recipient, what went and why the rest did not. `sent` names the ticked ids that went whole, so the list unticks
 * exactly those and what is left can be tried again.
 *
 * Generic: `kind` and its two endpoints (relative to the org's URL) are all it knows of a document. The state and
 * the requests are `useBatchEmail`'s, the rules of who is mailed what are `config/doc-email`'s.
 *
 * ⚠ Never "send" in a route or a handler name here: `POST /invoices/:id/send` ISSUES a document.
 */

const props = defineProps<{
  modelValue: boolean
  /** The kind of document, as its endpoints take it: `invoice`, `order`… */
  kind: string
  /** The org's API root (`/org/<id>`). */
  orgUrl: string
  /** The kind's two endpoints, relative to the org's URL. */
  previewPath: string
  emailPath: string
  /** The ticked ids. Read when the dialog opens. */
  ids: string[]
  /** Closes the default subject, as on the single document's dialog. */
  orgName?: string
  locale?: string
  /** For a kind whose print has columns (an invoice): the person's own, read when the batch leaves. */
  columns?: () => string[] | undefined
}>()

const emit = defineEmits<{
  'update:modelValue': [open: boolean]
  /** The ticked ids whose every document went: the list unticks them. */
  sent: [ids: string[]]
}>()

const { t, te } = useI18n()
const { showSuccess } = useSnackbar()
const { xs } = useDisplay()

const {
  phase, loadFailed, loadError, sendable, blocked, groups, hasPartner,
  mode, addresses, singleTo, subject, message,
  plan, totals, canSend, progress, results, halted, stopped,
  open, close: closeBatch, send,
} = useBatchEmail({
  kind: () => props.kind,
  orgUrl: () => props.orgUrl,
  previewPath: () => props.previewPath,
  emailPath: () => props.emailPath,
  locale: () => props.locale,
  columns: () => props.columns?.(),
  defaultSubject,
})

/** One document: its number, as the single dialog starts. Several: a word for them. Each closed by the org's name. */
function defaultSubject(rows: DocEmailPreviewRow[]): string {
  const what = rows.length === 1 ? rows[0]!.number : t('docEmail.documents')
  return [what, props.orgName].filter(Boolean).join(' — ')
}

watch(() => props.modelValue, (isOpen) => {
  if (isOpen) void open(props.ids)
  else closeBatch()
}, { immediate: true })

function close() {
  if (phase.value === 'sending') return
  emit('update:modelValue', false)
}

function onModel(isOpen: boolean) {
  if (!isOpen) close()
}

const nameOf = (group: DocEmailRecipientGroup) => group.partner?.name || t('docEmail.noPartner')
const numbersOf = (rows: readonly { number: string }[]) => rows.map(r => r.number).filter(Boolean).join(', ')

/** Document numbers as a line reads them: all of a few, or the first ones and how many more. */
function listed(numbers: readonly string[]): string {
  const { shown, more } = shortList(numbers)
  return more ? `${shown.join(', ')} ${t('docEmail.andMore', { n: more })}` : shown.join(', ')
}
/** The whole run, for the tooltip of a line that was cut. */
const wholeList = (numbers: readonly string[]) => (shortList(numbers).more ? numbers.join(', ') : undefined)

/** A reason in the reader's words; one the catalogue does not know reads as it came. */
const reasonText = (reason: string) => (te(`docEmail.reason.${reason}`) ? t(`docEmail.reason.${reason}`) : reason)

/** The documents that will not go, by why, in the order the reasons are listed. A missing document has no number. */
const blockedByReason = computed(() => DOC_EMAIL_BLOCKS
  .map(reason => {
    const rows = blocked.value.filter(r => r.blocked === reason)
    return { reason, count: rows.length, numbers: rows.map(r => r.number).filter(Boolean) }
  })
  .filter(b => b.count > 0))

/** On a phone the button says the verb alone: the counts do not fit it, and the lines above carry them. */
const sendLabel = computed(() => {
  const { documents, recipients } = totals.value
  if (!documents || xs.value) return t('docEmail.send')
  return t('docEmail.sendN', { documents: t('docEmail.nDocuments', documents), recipients: t('docEmail.nRecipients', recipients) })
})

/** Under the form, left of the buttons: why nothing can leave yet, or what will stay behind. */
const footNote = computed<{ text: string; error: boolean } | null>(() => {
  if (phase.value !== 'compose' || loadFailed.value || !sendable.value.length) return null
  if (plan.value.invalid.length) return { text: t('validation.invalidEmail'), error: true }
  if (!totals.value.documents) return { text: t('docEmail.noRecipient'), error: false }
  if (plan.value.unaddressed.length) return { text: t('docEmail.unaddressed', { n: plan.value.unaddressed.length }), error: false }
  return null
})

/** A document that did not go: the reason in the reader's words, the server's own beside it for whoever looks closer. */
function whyNot(result: DocEmailResult): { why: string; detail: string } {
  if (result.reason) return { why: reasonText(result.reason), detail: result.message || '' }
  return { why: result.message || t('docEmail.reason.notAsked'), detail: '' }
}

const numberOf = (result: DocEmailResult) =>
  result.number || sendable.value.find(r => r.id === result.id && (r.groupId ?? '') === (result.groupId ?? ''))?.number || '—'

const resultLines = computed(() => results.value.map((recipient) => {
  const sent = recipient.results.filter(r => r.status === 'sent').length
  const queued = recipient.results.filter(r => r.status === 'queued').length
  const left = recipient.results.filter(r => !wentOut(r))
  // The documents that did not go, gathered by why: ten that met the same refusal are one line.
  const byWhy = new Map<string, { why: string; detail: string; numbers: string[] }>()
  for (const result of left) {
    const { why, detail } = whyNot(result)
    const had = byWhy.get(why)
    if (had) had.numbers.push(numberOf(result))
    else byWhy.set(why, { why, detail, numbers: [numberOf(result)] })
  }
  const state = !left.length ? 'sent' : sent + queued ? 'partial' : 'failed'
  return {
    to: recipient.to,
    state,
    icon: state === 'sent' ? 'mdi-check-circle-outline' : state === 'partial' ? 'mdi-alert-outline' : 'mdi-close-circle-outline',
    color: state === 'sent' ? 'success' : state === 'partial' ? 'warning' : 'error',
    summary: [
      sent ? t('docEmail.result.sent', { n: sent }) : '',
      queued ? t('docEmail.result.queued', { n: queued }) : '',
      left.length ? t('docEmail.result.notSent', { n: left.length }) : '',
    ].filter(Boolean).join(' · '),
    notSent: [...byWhy.values()],
  }
}))
const anyQueued = computed(() => results.value.some(r => r.queued))

async function submit() {
  const outcome: BatchEmailOutcome | null = await send()
  if (!outcome) return
  if (outcome.went.length) emit('sent', outcome.went)
  if (!outcome.allFine) return
  // Everything went: nothing to read here. On an organization's own server a mail waits for lgrai.app (FR-20.86),
  // and is never said to be sent.
  const said = { documents: t('docEmail.nDocuments', outcome.documents), recipients: t('docEmail.nRecipients', outcome.recipients) }
  showSuccess(t(outcome.queued ? 'docEmail.doneQueued' : 'docEmail.done', said))
  emit('update:modelValue', false)
}
</script>

<style scoped>
.batch-email-line {
  display: flex;
  /* From the top: a field that shows an error grows downwards, and its line's name stays beside the field. */
  align-items: flex-start;
  gap: 12px;
  padding-block: 4px;
}
.batch-email-line__who {
  flex: 1 1 0;
  min-width: 0;
}
.batch-email-line__to {
  flex: 0 0 320px;
  max-width: 55%;
}
/* A phone: the address under its partner at full width, so it can be read and typed; the note on a line of its own,
   so Cancel and the button both stay on the screen. */
@media (max-width: 599.98px) {
  .batch-email-line {
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
  }
  .batch-email-line__who {
    flex: 0 0 auto;
  }
  .batch-email-line__to {
    flex: 0 0 auto;
    max-width: none;
  }
  .batch-email-note {
    flex: 1 1 100%;
    margin-bottom: 4px;
  }
}
</style>
