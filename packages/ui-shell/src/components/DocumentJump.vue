<template>
  <!-- FR-31.22: jump to a document by its number, from any screen. A button in the top bar (Ctrl+K) opens the field:
       Enter opens the one document the number names, lists several, or says there is none. The bar has no room for
       an open field at 1366 px (FR-31.20), so the field opens under its button. -->
  <v-menu
    v-model="open"
    location="bottom end"
    :close-on-content-click="false"
    offset="4"
  >
    <template #activator="{ props: menuProps }">
      <v-btn
        v-bind="menuProps"
        icon="mdi-magnify"
        variant="text"
        size="small"
        :aria-label="$t('shell.jump.open')"
        :title="$t('shell.jump.open')"
        data-testid="shell-jump"
      />
    </template>

    <v-card min-width="320" max-width="440" data-testid="shell-jump-panel">
      <v-card-text class="pb-2">
        <v-text-field
          ref="field"
          v-model="number"
          :label="$t('shell.jump.label')"
          :hint="$t('shell.jump.hint')"
          persistent-hint
          density="compact"
          variant="outlined"
          prepend-inner-icon="mdi-magnify"
          :loading="busy"
          autocomplete="off"
          spellcheck="false"
          data-testid="shell-jump-field"
          @keydown.enter.prevent="jump"
        />
      </v-card-text>

      <v-card-text v-if="failure" class="pt-0 text-error" role="alert" data-testid="shell-jump-failed">{{ failure }}</v-card-text>

      <template v-else-if="answer">
        <v-card-text v-if="!answer.matches.length" class="pt-0" role="status" data-testid="shell-jump-none">
          {{ $t('shell.jump.none', { number: answer.number }) }}
        </v-card-text>
        <template v-else-if="answer.matches.length > 1">
          <v-card-text class="pt-0 pb-1 text-medium-emphasis" role="status">
            {{ answer.exact ? $t('shell.jump.several', { number: answer.number }) : $t('shell.jump.prefix', { number: answer.number }) }}
          </v-card-text>
          <v-list density="compact" max-height="320" class="py-0 overflow-y-auto" data-testid="shell-jump-list">
            <v-list-item
              v-for="m in answer.matches"
              :key="`${m.family}:${m.id}`"
              :prepend-icon="documentIcon(m)"
              :title="m.number"
              :subtitle="subtitleOf(m)"
              :data-testid="`shell-jump-match-${m.number}`"
              @click="openMatch(m)"
            />
          </v-list>
          <v-card-text v-if="answer.more" class="pt-1 text-caption text-medium-emphasis">
            {{ $t('shell.jump.more', { n: answer.matches.length }) }}
          </v-card-text>
        </template>
      </template>
    </v-card>
  </v-menu>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from 'ui-shared/stores/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import { readsDocuments } from 'ui-shared/nav/page-registry'
import { formatDate } from 'ui-shared/format'
import type { LookupAnswer, LookupMatch } from 'config/document-lookup'
import { documentIcon, documentKindKey, documentRoute, isJumpShortcut } from '../document-route'

const { t } = useI18n()
const router = useRouter()
const appStore = useAppStore()

const open = ref(false)
const number = ref('')
const busy = ref(false)
const answer = ref<LookupAnswer | null>(null)
const failure = ref('')
const field = ref<{ focus?: () => void; select?: () => void } | null>(null)
let asked = 0

function subtitleOf(m: LookupMatch): string {
  return [
    t(documentKindKey(m)),
    m.date ? formatDate(m.date) : '',
    m.contactName ?? '',
    m.draftNumber ? t('shell.jump.viaDraft', { number: m.draftNumber }) : '',
  ].filter(Boolean).join(' · ')
}

function openMatch(m: LookupMatch) {
  open.value = false
  number.value = ''
  answer.value = null
  void router.push(documentRoute(m, readsDocuments(sessionViewer())))
}

async function jump() {
  const asking = number.value.trim()
  const orgId = appStore.currentOrg?.id
  if (!asking || !orgId || busy.value) return
  const mine = ++asked
  busy.value = true
  failure.value = ''
  try {
    const { data } = await httpClient.get<LookupAnswer>(`/org/${orgId}/lookup/documents`, { params: { number: asking } })
    if (mine !== asked) return
    if (data.matches.length === 1) openMatch(data.matches[0]!)
    else answer.value = data
  } catch (e: unknown) {
    if (mine !== asked) return
    answer.value = null
    const said = (e as { response?: { data?: { message?: unknown } } })?.response?.data?.message
    failure.value = typeof said === 'string' && said ? said : t('shell.jump.failed')
  } finally {
    if (mine === asked) busy.value = false
  }
}

// A new number is a new question: what the last one answered goes.
watch(number, () => {
  answer.value = null
  failure.value = ''
})

watch(open, (isOpen) => {
  if (!isOpen) return
  // The menu draws its content as it opens: the field is there a moment later.
  setTimeout(() => {
    field.value?.focus?.()
    field.value?.select?.()
  }, 50)
})

function onKeydown(e: KeyboardEvent) {
  if (!isJumpShortcut(e)) return
  // The browser's own Ctrl+K (its search box) never opens over the app.
  e.preventDefault()
  if (open.value) field.value?.focus?.()
  else open.value = true
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>
