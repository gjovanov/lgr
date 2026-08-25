<template>
  <v-dialog v-model="open" max-width="560">
    <v-card>
      <v-card-title class="d-flex align-center ga-2">
        <v-icon>mdi-email-arrow-right-outline</v-icon>
        {{ $t('invoicing.sendEmail.title') }}
      </v-card-title>

      <v-card-text>
        <p v-if="documentNumber" class="text-body-2 text-medium-emphasis mb-4">
          {{ documentNumber }}
        </p>

        <v-text-field
          v-model="to"
          :label="$t('invoicing.sendEmail.to')"
          :rules="[emailRule]"
          type="email"
          density="compact"
          autofocus
          prepend-inner-icon="mdi-at"
        />

        <v-text-field
          v-model="subject"
          :label="$t('invoicing.sendEmail.subject')"
          density="compact"
        />

        <v-textarea
          v-model="message"
          :label="$t('invoicing.sendEmail.message')"
          rows="3"
          auto-grow
          density="compact"
          hide-details
        />
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="open = false">{{ $t('common.cancel') }}</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-email-arrow-right-outline"
          :loading="loading"
          :disabled="!isValid"
          @click="confirm"
        >
          {{ $t('invoicing.sendEmail.send') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * FR-10.7 (#19) — the "email this document" dialog, modeled on ExportDialog's
 * open/emit/reset shape.
 *
 * The recipient is PREFILLED from the contact card but always editable: the docx asks for
 * both ("възможност за въвеждане или избор"), and plenty of customers want the invoice at
 * an address other than the one on file.
 */

const props = defineProps<{
  modelValue: boolean
  /** Prefill from the loaded contact; may be empty. */
  defaultTo?: string
  defaultSubject?: string
  documentNumber?: string
  loading?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: [payload: { to: string; subject?: string; message?: string }]
}>()

const { t } = useI18n()

const to = ref('')
const subject = ref('')
const message = ref('')

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
})

// Same permissive shape the server uses — the real check is the provider's.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const isValid = computed(() => EMAIL_RE.test(to.value.trim()))
const emailRule = (v: string) => (!v || EMAIL_RE.test(v.trim()) ? true : t('validation.invalidEmail'))

// Re-seed on every open so a second send does not inherit the first one's edits.
watch(open, (isOpen) => {
  if (!isOpen) return
  to.value = props.defaultTo || ''
  subject.value = props.defaultSubject || ''
  message.value = ''
})

function confirm() {
  if (!isValid.value) return
  emit('confirm', {
    to: to.value.trim(),
    subject: subject.value.trim() || undefined,
    message: message.value.trim() || undefined,
  })
}
</script>
