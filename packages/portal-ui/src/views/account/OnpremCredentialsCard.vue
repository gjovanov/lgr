<template>
  <v-card v-if="orgs.length" class="mb-4" variant="flat" border data-testid="onprem-credentials">
    <v-card-title class="text-subtitle-1 font-weight-medium">{{ $t('account.onprem.title') }}</v-card-title>
    <v-card-text>
      <p class="text-body-2 text-medium-emphasis mb-4">{{ $t('account.onprem.description') }}</p>
      <v-alert v-if="done" type="success" variant="tonal" density="compact" class="mb-4">{{ done }}</v-alert>
      <v-alert v-if="cardError" type="error" variant="tonal" density="compact" class="mb-4">{{ cardError }}</v-alert>

      <div v-for="org in orgs" :key="org.orgId" class="mb-4" :data-testid="`onprem-org-${org.orgSlug}`">
        <div class="text-subtitle-2">{{ org.orgName }}</div>
        <div class="text-caption text-medium-emphasis mb-2">
          <span v-for="(s, i) in org.servers" :key="s.id">
            {{ i ? ', ' : '' }}{{ s.ready ? s.name : $t('account.onprem.serverWaiting', { name: s.name }) }}
          </span>
        </div>
        <v-list density="compact" class="py-0">
          <v-list-item
            v-for="kind in kindsOf(org)"
            :key="kind"
            :title="kind === 'password' ? $t('account.onprem.password') : $t('account.onprem.pin')"
            :data-testid="`onprem-${org.orgSlug}-${kind}`"
          >
            <template #subtitle>
              <span v-if="!org[kind]">{{ $t('account.onprem.notSet') }}</span>
              <span v-else-if="org[kind]!.live">{{ $t('account.onprem.setOn', { date: when(org[kind]!.setAt) }) }}</span>
              <span v-else class="text-warning">{{ $t('account.onprem.ended') }}</span>
            </template>
            <template #append>
              <v-btn size="small" variant="tonal" color="primary" class="mr-1" @click="open(org, kind)">
                {{ org[kind]?.live ? $t('account.onprem.change') : $t('account.onprem.set') }}
              </v-btn>
              <v-btn v-if="org[kind]" size="small" variant="text" color="error" :loading="removing === `${org.orgId}:${kind}`" @click="remove(org, kind)">
                {{ $t('account.onprem.remove') }}
              </v-btn>
            </template>
          </v-list-item>
        </v-list>
      </div>
    </v-card-text>

    <v-dialog v-model="dialog" max-width="460">
      <v-card v-if="editing">
        <v-card-title class="text-subtitle-1">
          {{ editing.kind === 'password'
            ? $t('account.onprem.dialogPassword', { org: editing.org.orgName })
            : $t('account.onprem.dialogPin', { org: editing.org.orgName }) }}
        </v-card-title>
        <v-card-text>
          <v-form ref="formRef" @submit.prevent="save">
            <v-text-field
              v-if="hasPassword"
              v-model="current"
              :label="$t('account.currentPassword')"
              type="password"
              autocomplete="current-password"
              :rules="[required]"
              class="mb-2"
            />
            <v-text-field
              v-model="secret"
              :label="editing.kind === 'password' ? $t('account.onprem.newPassword') : $t('account.pin.newPin')"
              type="password"
              :inputmode="editing.kind === 'pin' ? 'numeric' : undefined"
              autocomplete="new-password"
              :hint="editing.kind === 'password' ? $t('account.onprem.passwordRule') : $t('account.pin.rule')"
              persistent-hint
              :rules="[required, shape]"
              class="mb-2"
            />
            <v-text-field
              v-model="confirm"
              :label="editing.kind === 'password' ? $t('account.onprem.confirmPassword') : $t('account.pin.confirmPin')"
              type="password"
              :inputmode="editing.kind === 'pin' ? 'numeric' : undefined"
              autocomplete="new-password"
              :rules="[required, matches]"
              class="mb-2"
            />
            <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-2">{{ error }}</v-alert>
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="busy" @click="dialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="busy" data-testid="onprem-save" @click="save">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { refusalCode } from 'ui-shared/session/useOrgSession'

/**
 * The person's local credentials for their orgs' on-prem servers (FR-20.40, plan step P2-4c): a
 * local password for when the shop's internet is down, and a till PIN for a membership with an
 * operator code. Set here, on lgrai.app, ahead of time; the server receives them sealed.
 *
 * Shown on lgrai.app only, and only for a person with an org that has a server: everywhere else
 * `/auth/onprem` answers 404 or nothing, and the card does not appear.
 */

type Kind = 'password' | 'pin'
interface Cred { setAt: string; live: boolean }
interface OrgRow {
  orgId: string
  orgName: string
  orgSlug: string
  operatorCode: boolean
  servers: Array<{ id: string; name: string; ready: boolean }>
  password: Cred | null
  pin: Cred | null
}

defineProps<{ hasPassword: boolean }>()

const { t, locale } = useI18n()
const orgs = ref<OrgRow[]>([])
const dialog = ref(false)
const editing = ref<{ org: OrgRow; kind: Kind } | null>(null)
const formRef = ref()
const current = ref('')
const secret = ref('')
const confirm = ref('')
const busy = ref(false)
const removing = ref('')
const error = ref('')
const cardError = ref('')
const done = ref('')

const kindsOf = (org: OrgRow): Kind[] => (org.operatorCode ? ['password', 'pin'] : ['password'])
const when = (iso: string) => new Date(iso).toLocaleDateString(locale.value)
const required = (v: string) => !!v || t('validation.required')
const shape = (v: string) =>
  editing.value?.kind === 'pin'
    ? /^\d{6,12}$/.test(v ?? '') || t('account.pin.rule')
    : (v ?? '').length >= 12 || t('account.onprem.passwordRule')
const matches = (v: string) => v === secret.value || t('account.onprem.mismatch')

async function load() {
  try {
    const { data } = await httpClient.get('/auth/onprem')
    orgs.value = Array.isArray(data?.orgs) ? data.orgs : []
  } catch {
    orgs.value = []
  }
}

function message(err: unknown): string {
  switch (refusalCode(err)) {
    case 'wrong_password': return t('account.pin.wrongPassword')
    case 'same_as_global': return t('account.onprem.sameAsGlobal')
    case 'own_password_required': return t('account.onprem.ownPasswordRequired')
    case 'no_operator_code': return t('account.onprem.noOperatorCode')
    case 'pin_rule': return t('account.pin.rule')
    case 'password_rule': return t('account.onprem.passwordRule')
    case 'too_many_attempts': return t('account.onprem.tooMany')
    default: return t('account.onprem.failed')
  }
}

function open(org: OrgRow, kind: Kind) {
  editing.value = { org, kind }
  current.value = secret.value = confirm.value = ''
  error.value = cardError.value = done.value = ''
  dialog.value = true
}

async function save() {
  if (!editing.value) return
  const { valid } = await formRef.value.validate()
  if (!valid) return
  busy.value = true
  error.value = ''
  try {
    const { org, kind } = editing.value
    await httpClient.put(`/auth/onprem/${org.orgId}/${kind}`, { secret: secret.value, ...(current.value ? { currentPassword: current.value } : {}) })
    current.value = secret.value = confirm.value = ''
    dialog.value = false
    done.value = t('account.onprem.saved')
    await load()
  } catch (err) {
    error.value = message(err)
  } finally {
    busy.value = false
  }
}

async function remove(org: OrgRow, kind: Kind) {
  removing.value = `${org.orgId}:${kind}`
  cardError.value = done.value = ''
  try {
    await httpClient.delete(`/auth/onprem/${org.orgId}/${kind}`)
    done.value = t('account.onprem.removed')
    await load()
  } catch (err) {
    cardError.value = message(err)
  } finally {
    removing.value = ''
  }
}

onMounted(load)
defineExpose({ load })
</script>
