<template>
  <!--
    #510: what became of an invitation. It used to be a snackbar ("Saved successfully"), and no
    email ever went out, so the person was never told. The link shows in every case: an admin can
    always send it themselves.
  -->
  <v-dialog :model-value="!!result" max-width="520" @update:model-value="v => { if (!v) emit('close') }">
    <v-card v-if="result">
      <v-card-title>{{ $t('settings.inviteResult.title') }}</v-card-title>
      <v-card-text>
        <v-alert :type="alertType" variant="tonal" density="compact" class="mb-4" data-testid="invite-result-status">
          {{ statusText }}
        </v-alert>
        <v-text-field
          :model-value="result.link"
          :label="$t('settings.inviteResult.link')"
          readonly
          density="compact"
          variant="outlined"
          hide-details
          data-testid="invite-result-link"
        >
          <template #append-inner>
            <v-btn icon size="small" variant="text" :title="$t('settings.inviteResult.copy')" @click="copy">
              <v-icon>mdi-content-copy</v-icon>
            </v-btn>
          </template>
        </v-text-field>
        <div v-if="copied" class="text-caption text-success mt-1">{{ $t('settings.inviteResult.copied') }}</div>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn color="primary" @click="emit('close')">{{ $t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

/** `POST /org/:orgId/invite`'s answer: the link, and for an invite that names an address, the mail. */
export interface InviteResult {
  link: string
  targetEmail?: string | null
  email?: { sent: true; queued?: true } | { sent: false; reason: 'not_configured' | 'provider_error' }
}

const props = defineProps<{ result: InviteResult | null }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const copied = ref(false)

watch(() => props.result, () => { copied.value = false })

const alertType = computed(() => {
  const r = props.result
  if (!r?.targetEmail) return 'info'
  return r.email?.sent ? 'success' : 'warning'
})

const statusText = computed(() => {
  const r = props.result
  if (!r) return ''
  if (!r.targetEmail) return t('settings.inviteResult.shareLink')
  const email = r.targetEmail
  if (r.email?.sent) return t(r.email.queued ? 'settings.inviteResult.emailQueued' : 'settings.inviteResult.emailSent', { email })
  if (r.email?.reason === 'not_configured') return t('settings.inviteResult.emailNotConfigured', { email })
  return t('settings.inviteResult.emailFailed', { email })
})

async function copy() {
  if (!props.result) return
  try {
    await navigator.clipboard.writeText(props.result.link)
    copied.value = true
  } catch { /* the field is selectable; the admin copies it by hand */ }
}
</script>
