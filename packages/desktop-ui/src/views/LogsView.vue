<template>
  <ShellFrame>
    <v-container class="py-6" style="max-width: 1100px">
      <div class="d-flex align-center mb-4 ga-3 flex-wrap">
        <h1 class="text-h5 mb-0">{{ $t('shell.logs.title') }}</h1>
        <v-spacer />
        <v-btn variant="text" size="small" prepend-icon="mdi-folder-open-outline" @click="onOpenFolder">
          {{ $t('shell.logs.openFolder') }}
        </v-btn>
        <v-btn variant="text" size="small" prepend-icon="mdi-refresh" :loading="loading" @click="refresh">
          {{ $t('shell.common.refresh') }}
        </v-btn>
      </div>

      <v-card variant="flat" border>
        <v-card-text class="d-flex ga-3 flex-wrap align-center pb-2">
          <v-select
            v-model="level"
            :items="levelItems"
            item-title="label"
            item-value="value"
            :label="$t('shell.logs.source')"
            variant="outlined"
            density="compact"
            hide-details
            style="max-width: 220px"
            data-field="level"
          />
          <v-text-field
            v-model="filter"
            :label="$t('shell.logs.filter')"
            variant="outlined"
            density="compact"
            hide-details
            clearable
            prepend-inner-icon="mdi-magnify"
            style="max-width: 320px"
            data-field="filter"
          />
          <v-switch
            v-model="follow"
            :label="$t('shell.logs.follow')"
            color="primary"
            density="compact"
            hide-details
            data-field="follow"
          />
          <v-spacer />
          <span class="text-caption text-medium-emphasis">{{ $t('shell.logs.lines', { n: visible.length }) }}</span>
        </v-card-text>

        <v-divider />

        <div ref="pane" class="log-pane" data-field="log-pane">
          <p v-if="!lines.length" class="pa-4 text-body-2 text-medium-emphasis mb-0">
            {{ $t('shell.logs.empty') }}
          </p>
          <p v-else-if="!visible.length" class="pa-4 text-body-2 text-medium-emphasis mb-0">
            {{ $t('shell.logs.noMatch') }}
          </p>
          <pre v-else class="log-text">{{ visible.join('\n') }}</pre>
        </div>
      </v-card>
    </v-container>
  </ShellFrame>
</template>

<script setup lang="ts">
/**
 * Source, filter, follow — reading C08's rotating files through `read_logs`.
 *
 * ⚠ Rendered as one `<pre>`, not a list of components. A log pane is the one screen that can
 * be handed thousands of lines, and 2 000 Vue nodes to show text is how a diagnostics page
 * becomes the slowest thing in the app.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import ShellFrame from '../components/ShellFrame.vue'
import { openLogFolder, readLogs } from '../shell'

const { t } = useI18n()
const { showError } = useSnackbar()

const lines = ref<string[]>([])
const filter = ref('')
const level = ref('all')
const follow = ref(true)
const loading = ref(false)
const pane = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

const levelItems = computed(() => [
  { value: 'all', label: t('shell.logs.level.all') },
  { value: 'error', label: t('shell.logs.level.error') },
  { value: 'warn', label: t('shell.logs.level.warn') },
  { value: 'info', label: t('shell.logs.level.info') },
])

/** The shell writes `LEVEL` in the line; matching is case-insensitive and tolerant of format. */
const LEVEL_PATTERNS: Record<string, RegExp> = {
  error: /\b(error|fatal)\b/i,
  warn: /\b(warn|warning|error|fatal)\b/i,
  info: /\b(info|warn|warning|error|fatal)\b/i,
}

const visible = computed(() => {
  const needle = (filter.value || '').toLowerCase()
  const pattern = LEVEL_PATTERNS[level.value]
  return lines.value.filter(l => {
    if (pattern && !pattern.test(l)) return false
    if (needle && !l.toLowerCase().includes(needle)) return false
    return true
  })
})

async function refresh() {
  loading.value = true
  try {
    lines.value = await readLogs(2000)
    if (follow.value) await scrollToEnd()
  } catch (e: any) {
    showError(String(e?.message || e))
  } finally {
    loading.value = false
  }
}

async function scrollToEnd() {
  await nextTick()
  if (pane.value) pane.value.scrollTop = pane.value.scrollHeight
}

async function onOpenFolder() {
  try {
    await openLogFolder()
  } catch (e: any) {
    showError(String(e?.message || e))
  }
}

watch(follow, on => {
  if (on) void scrollToEnd()
})

onMounted(async () => {
  await refresh()
  // Polling, not a file watcher: `read_logs` is a cheap tail and a 2 s poll is invisible next
  // to the IPC it rides on. A watcher would need a second Rust command and an event channel
  // for a page people leave open for a minute.
  timer = setInterval(() => { if (follow.value) void refresh() }, 2000)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.log-pane {
  max-height: 60vh;
  overflow: auto;
}
.log-text {
  margin: 0;
  padding: 12px 16px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
