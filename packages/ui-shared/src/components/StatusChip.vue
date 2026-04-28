<template>
  <v-chip
    size="small"
    label
    :color="color"
    :style="{ cursor: hasHistory ? 'pointer' : 'default' }"
    @click.stop="onClick"
  >
    {{ statusLabel }}
    <v-icon v-if="hasHistory" size="x-small" class="ml-1">mdi-history</v-icon>
  </v-chip>

  <v-dialog v-model="dialog" max-width="520">
    <v-card>
      <v-card-title class="d-flex align-center">
        <v-icon class="mr-2">mdi-history</v-icon>
        <span>{{ $t ? $t('common.statusHistory') : 'Status history' }}</span>
      </v-card-title>
      <v-card-text>
        <status-timeline :history="history" :color-fn="colorFn" />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="dialog = false">{{ $t ? $t('common.close') : 'Close' }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import StatusTimeline from './StatusTimeline.vue'

const props = defineProps<{
  status: string
  history?: Array<{ status: string; fromStatus?: string; changedAt: string | Date; changedBy?: any; reason?: string }>
  colorFn?: (s: string) => string
}>()

const dialog = ref(false)
const { t, te } = useI18n()

const color = computed(() => (props.colorFn ? props.colorFn(props.status) : 'grey'))
const history = computed(() => props.history || [])
const hasHistory = computed(() => history.value.length > 0)
const colorFn = computed(() => props.colorFn || ((_s: string) => 'grey'))
const statusLabel = computed(() => {
  const s = props.status
  if (!s) return ''
  const key = `invoicing.status.${s}`
  return te(key) ? t(key) : s
})

function onClick() {
  if (hasHistory.value) dialog.value = true
}
</script>
