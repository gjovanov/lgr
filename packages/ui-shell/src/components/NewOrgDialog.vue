<template>
  <v-dialog :model-value="modelValue" max-width="480" @update:model-value="$emit('update:modelValue', $event)">
    <v-card>
      <v-card-title class="pt-5 px-6">{{ $t('newOrg.title') }}</v-card-title>
      <v-card-text class="px-6">
        <p class="text-body-2 text-medium-emphasis mb-4">{{ $t('newOrg.hint') }}</p>
        <v-form ref="formRef" @submit.prevent="submit">
          <v-text-field
            v-model="name"
            :label="$t('newOrg.name')"
            :rules="[required]"
            prepend-inner-icon="mdi-domain"
            autofocus
            @update:model-value="onName"
          />
          <v-text-field
            v-model="slug"
            :label="$t('newOrg.slug')"
            :hint="$t('newOrg.slugHint')"
            persistent-hint
            :rules="[required, slugRule]"
            prepend-inner-icon="mdi-tag-outline"
            @update:model-value="slugEdited = true"
          />
          <v-select v-model="baseCurrency" :items="CURRENCIES" :label="$t('auth.baseCurrency')" class="mt-4" />
          <v-alert v-if="error" type="error" density="compact" variant="tonal" class="mt-2">
            {{ error }}
            <div v-if="needsOwnPassword" class="mt-1">
              <a :href="accountHref">{{ $t('identity.toAccount') }}</a>
            </div>
          </v-alert>
        </v-form>
      </v-card-text>
      <v-card-actions class="px-6 pb-4">
        <v-spacer />
        <v-btn variant="text" :disabled="busy" @click="$emit('update:modelValue', false)">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="primary" variant="flat" :loading="busy" @click="submit">{{ $t('newOrg.create') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { foundOrg, orgSlugFromName, refusalCode } from 'ui-shared/session/useOrgSession'
import { portalHref } from 'ui-shared/nav/navigate'

/**
 * Found an organization as the signed-in person, who becomes its admin, and enter it in this tab.
 * The server needs a password the person chose themselves (rule 3); when they have none yet, the
 * refusal links to the account page.
 */

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [open: boolean]; entered: [] }>()
const { t, te } = useI18n()

const CURRENCIES = ['EUR', 'BGN', 'MKD', 'USD', 'GBP', 'CHF']
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const formRef = ref()
const name = ref('')
const slug = ref('')
const slugEdited = ref(false)
const baseCurrency = ref('EUR')
const busy = ref(false)
const error = ref('')
const errorCode = ref('')

const needsOwnPassword = computed(() => errorCode.value === 'own_password_required')
const accountHref = computed(() => portalHref('/account'))
const required = (v: string) => !!v?.trim() || t('validation.required')
const slugRule = (v: string) => SLUG.test(v ?? '') || t('newOrg.slugHint')

watch(
  () => props.modelValue,
  open => {
    if (!open) return
    name.value = ''
    slug.value = ''
    slugEdited.value = false
    error.value = ''
    errorCode.value = ''
  },
)

function onName(value: string) {
  if (!slugEdited.value) slug.value = orgSlugFromName(value ?? '')
}

async function submit() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  busy.value = true
  error.value = ''
  errorCode.value = ''
  try {
    await foundOrg({ name: name.value.trim(), slug: slug.value, baseCurrency: baseCurrency.value })
    emit('entered')
  } catch (err) {
    const code = refusalCode(err)
    errorCode.value = code
    error.value = code && te(`identity.errors.${code}`)
      ? t(`identity.errors.${code}`)
      : (err as any)?.response?.data?.message || t('newOrg.failed')
    busy.value = false
  }
}
</script>
