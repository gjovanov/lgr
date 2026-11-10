<template>
  <v-container fluid>
    <div class="d-flex align-center mb-2">
      <v-btn icon="mdi-arrow-left" variant="text" :to="{ name: 'settings.roles' }" class="mr-2" />
      <h1 class="text-h4">{{ form.name || $t('access.ui.title') }}</h1>
      <v-chip v-if="role?.isBuiltin" size="small" variant="outlined" class="ml-3">{{ $t('access.ui.builtin') }}</v-chip>
      <v-chip v-if="role?.edited" size="small" color="info" variant="tonal" class="ml-1">{{ $t('access.ui.edited') }}</v-chip>
      <v-spacer />
      <v-btn v-if="role && !role.isBuiltin && !people.length" variant="text" color="error" class="mr-2" data-testid="role-delete" @click="remove">{{ $t('access.ui.deleteRole') }}</v-btn>
      <v-btn v-if="role && !role.all" color="primary" :loading="saving" data-testid="role-save" @click="save">{{ $t('common.save') }}</v-btn>
    </div>

    <v-progress-linear v-if="loading" indeterminate class="mb-4" />

    <template v-if="role">
      <v-row>
        <v-col cols="12" md="5">
          <v-text-field v-model="form.name" :label="$t('access.ui.name')" :disabled="role.all" data-testid="role-name" />
        </v-col>
        <v-col cols="12" md="7">
          <v-text-field v-model="form.description" :label="$t('access.ui.description')" :disabled="role.all" :placeholder="role.isBuiltin && role.templateKey ? $t(`access.roles.${role.templateKey}.description`) : ''" />
        </v-col>
        <v-col v-if="!role.all" cols="12" md="5">
          <!-- FR-27.4: where the role's people start; only pages the role opens are offered. -->
          <v-autocomplete
            v-model="form.landing"
            :items="landingOptions"
            :label="$t('access.ui.landing')"
            :hint="$t('access.ui.landingHint')"
            :placeholder="$t('access.ui.landingDefault')"
            persistent-hint
            persistent-placeholder
            clearable
            data-testid="role-landing"
          />
        </v-col>
      </v-row>

      <v-alert v-if="role.all" type="info" variant="tonal" class="mb-4">{{ $t('access.ui.administratorFixed') }}</v-alert>
      <v-alert v-if="role.needsRelease" type="warning" variant="tonal" class="mb-4">{{ $t('access.ui.needsReleaseHint') }}</v-alert>
      <v-alert v-if="role.unknownCaps?.length" type="warning" variant="tonal" class="mb-4">
        {{ $t('access.ui.unknownCaps') }}: {{ role.unknownCaps.join(', ') }}
      </v-alert>

      <v-card variant="outlined" class="mb-4">
        <v-card-text class="text-body-2">
          <div><strong>{{ $t('access.ui.canCreate') }}:</strong> {{ names(summary.canCreate) }}</div>
          <div><strong>{{ $t('access.ui.readOnly') }}:</strong> {{ names(summary.readOnly) }}</div>
          <div><strong>{{ $t('access.ui.notVisible') }}:</strong> {{ names(summary.notVisible) }}</div>
          <div class="text-medium-emphasis mt-2">{{ $t('access.ui.alwaysIncluded') }}</div>
        </v-card-text>
      </v-card>

      <v-expansion-panels v-model="openGroups" multiple variant="accordion">
        <v-expansion-panel v-for="group in groups" :key="group.id" :value="group.id">
          <v-expansion-panel-title>
            <span class="font-weight-medium">{{ $t(`access.group.${group.id}`) }}</span>
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <v-table density="compact">
              <thead>
                <tr>
                  <th>{{ $t('access.ui.feature') }}</th>
                  <th v-for="level in LEVELS" :key="level" class="text-center">{{ $t(`access.level.${level}`) }}</th>
                  <th>{{ $t('access.ui.extras') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="f in group.features" :key="f.id" :data-feature="f.id">
                  <td>{{ $t(`access.feature.${f.id}`) }}</td>
                  <td v-for="level in LEVELS" :key="level" class="text-center">
                    <v-tooltip :disabled="level === 'none'" :text="grants(f, level)">
                      <template #activator="{ props: tip }">
                        <input
                          v-bind="tip"
                          type="radio"
                          :name="`level-${f.id}`"
                          :checked="levelOf(f, grant) === level"
                          :disabled="role.all || !offers(f, level)"
                          :data-cap="`${f.id}:${level}`"
                          @change="setLevel(f, level)"
                        >
                      </template>
                    </v-tooltip>
                  </td>
                  <td>
                    <v-checkbox
                      v-for="c in extrasOf(f)"
                      :key="c"
                      :model-value="selected.has(c)"
                      :label="actionLabel(c)"
                      :disabled="role.all"
                      density="compact"
                      hide-details
                      class="d-inline-flex mr-3"
                      :data-cap="c"
                      @update:model-value="(on: any) => toggle(c, !!on)"
                    />
                  </td>
                </tr>
              </tbody>
            </v-table>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>

      <!-- FR-27.9: preview as the role, as it stands in the editor: the pages its people would be offered. -->
      <v-card variant="outlined" class="mt-4" data-testid="role-preview">
        <v-card-title class="text-subtitle-1">{{ $t('access.tools.preview') }} ({{ previewCount }})</v-card-title>
        <v-card-subtitle>{{ $t('access.tools.previewHint') }}</v-card-subtitle>
        <v-card-text>
          <div v-if="!previewCount" class="text-medium-emphasis">{{ $t('access.tools.previewNone') }}</div>
          <div v-for="g in preview" :key="g.app" class="mb-2">
            <div class="text-caption text-medium-emphasis">{{ g.title }}</div>
            <v-chip v-for="p in g.pages" :key="p.id" size="small" class="mr-1 mb-1" :data-page="p.id">{{ p.title }}</v-chip>
          </div>
        </v-card-text>
      </v-card>

      <v-card v-if="people.length" variant="outlined" class="mt-4">
        <v-card-title class="text-subtitle-1">{{ $t('access.ui.people') }} ({{ people.length }})</v-card-title>
        <v-card-text>
          <v-chip v-for="p in people" :key="p.id" size="small" class="mr-1 mb-1">{{ p.name || p.username }}</v-chip>
        </v-card-text>
      </v-card>
    </template>
  </v-container>
</template>

<script setup lang="ts">
/**
 * FR-27 §2.2 (#529) — the role editor: per feature a level, None, View, Work or Full, and the extras beyond it. A
 * level is a shortcut, never stored: Save sends the role's capabilities, and the server holds them to FR-27.8 and adds
 * the helpers their forms read.
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  EDITOR_FEATURES, FEATURE_GROUPS, LEVELS, beyondLevel, levelOf, levelsOf, summarize,
  type CapabilityId, type Grant, type Level,
} from 'config/access'
import { useAppStore } from '../../store/app.store'
import { APP_NAV_META, PAGE_REGISTRY } from 'ui-shared/nav/page-registry'
import { canOpen, pagesOpenedBy } from 'config/access'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { httpClient } from 'ui-shared/composables/useHttpClient'

type Feature = (typeof EDITOR_FEATURES)[number]

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const role = ref<any>(null)
const people = ref<any[]>([])
const loading = ref(false)
const saving = ref(false)
const form = reactive({ name: '', description: '', landing: null as string | null })
const selected = ref(new Set<CapabilityId>())
const openGroups = ref<string[]>(['invoicing', 'inventory'])

const grant = computed<Grant>(() => (role.value?.all ? { all: true } : { caps: selected.value }))
const summary = computed(() => summarize(grant.value))
/** FR-27.9: the portal's pages by the label its menu gives them (`DefaultLayout`). */
const PORTAL_LABELS: Record<string, string> = {
  '/dashboard': 'nav.dashboard', '/settings/organization': 'nav.organization', '/settings/users': 'nav.users',
  '/settings/roles': 'access.ui.title', '/settings/permission-sets': 'permissionSets.title', '/settings/desktops': 'desktops.title',
  '/settings/servers': 'servers.title', '/settings/server': 'serverStatus.title', '/admin/audit-log': 'nav.auditLog',
}
/** FR-27.9 preview as the role: what it opens as it stands, by app, the portal last. */
const preview = computed(() => {
  const byId = new Map(PAGE_REGISTRY.map(p => [p.id, p]))
  const groups = new Map<string, { app: string; title: string; pages: Array<{ id: string; title: string }> }>()
  for (const id of pagesOpenedBy(grant.value)) {
    const page = byId.get(id)
    const app = page?.appId ?? 'portal'
    if (!groups.has(app)) groups.set(app, { app, title: APP_NAV_META[app] ? t(APP_NAV_META[app].nameKey) : t('access.tools.portal'), pages: [] })
    groups.get(app)!.pages.push({ id, title: page ? t(page.labelKey) : PORTAL_LABELS[id] ? t(PORTAL_LABELS[id]) : id })
  }
  return [...groups.values()].sort((a, b) => (a.app === 'portal' ? 1 : 0) - (b.app === 'portal' ? 1 : 0))
})
const previewCount = computed(() => preview.value.reduce((n, g) => n + g.pages.length, 0))
/** FR-27.4: the pages this role opens, as it stands in the editor, by app; one with a query is a variant of a form. */
const landingOptions = computed(() => PAGE_REGISTRY
  .filter(p => !p.id.includes('?') && canOpen(p.id, grant.value))
  .map(p => ({ value: p.id, title: `${APP_NAV_META[p.appId] ? t(APP_NAV_META[p.appId].nameKey) : p.appId} · ${t(p.labelKey)}` })))
const groups = computed(() => FEATURE_GROUPS.filter(g => g !== 'helpers').map(g => ({ id: g, features: EDITOR_FEATURES.filter(f => f.group === g) })).filter(g => g.features.length))

const actionLabel = (c: string) => t(`access.action.${c.slice(c.indexOf('.') + 1).replace(/[:-]/g, '_')}`)
const names = (ids: string[]) => ids.map(id => t(`access.feature.${id}`)).join(', ') || '—'

/** A level is offered when it says more than the one below it. */
function offers(f: Feature, level: Level): boolean {
  if (level === 'none') return true
  const l = levelsOf(f)
  if (level === 'view') return l.view.length > 0
  if (level === 'work') return l.work.length > l.view.length
  return l.full.length > l.work.length || (l.full.length > 0 && l.work.length === l.view.length && l.full.length > l.view.length)
}

/** What a level grants, for its hover (FR-27 §2.2). */
function grants(f: Feature, level: Level): string {
  if (level === 'none') return ''
  return `${t('access.ui.grants')}: ${levelsOf(f)[level].map(actionLabel).join(', ')}`
}

/** The extras a feature shows: its own, and anything the role holds beyond its level. */
function extrasOf(f: Feature): CapabilityId[] {
  return [...new Set([...levelsOf(f).extras, ...beyondLevel(f, grant.value)])]
}

function setLevel(f: Feature, level: Level) {
  const l = levelsOf(f)
  const next = new Set(selected.value)
  for (const c of l.full) next.delete(c)
  if (level !== 'none') for (const c of l[level]) next.add(c)
  selected.value = next
}

function toggle(c: CapabilityId, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(c)
  else next.delete(c)
  selected.value = next
}

async function load() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/roles/${route.params.id}`)
    role.value = data.role
    people.value = data.people ?? []
    form.name = data.role.name
    form.description = data.role.description ?? ''
    form.landing = data.role.landing ?? null
    selected.value = new Set(data.role.caps as CapabilityId[])
  } catch (e: any) {
    showError(e?.response?.data?.message ?? t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  try {
    // A landing the capabilities chosen no longer open is cleared rather than refused.
    const landing = form.landing && landingOptions.value.some(o => o.value === form.landing) ? form.landing : null
    const { data } = await httpClient.put(`${appStore.orgUrl()}/roles/${role.value.id}`, { name: form.name.trim(), description: form.description, caps: [...selected.value], landing })
    role.value = data.role
    form.landing = data.role.landing ?? null
    selected.value = new Set(data.role.caps as CapabilityId[])
    showSuccess(t('access.ui.saved'))
  } catch (e: any) {
    showError(e?.response?.data?.message ?? t('common.operationFailed'))
  } finally {
    saving.value = false
  }
}

async function remove() {
  try {
    await httpClient.delete(`${appStore.orgUrl()}/roles/${role.value.id}`)
    router.push({ name: 'settings.roles' })
  } catch (e: any) {
    showError(e?.response?.data?.message ?? t('common.operationFailed'))
  }
}

onMounted(load)
</script>
