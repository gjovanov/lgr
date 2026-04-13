<template>
  <v-chip
    size="small"
    label
    :color="color"
    :style="{ cursor: hasHistory ? 'pointer' : 'default' }"
    @click.stop="onClick"
  >
    {{ status }}
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
import StatusTimeline from './StatusTimeline.vue'

const props = defineProps<{
  status: string
  history?: Array<{ status: string; fromStatus?: string; changedAt: string | Date; changedBy?: any; reason?: string }>
  colorFn?: (s: string) => string
}>()

const dialog = ref(false)

const color = computed(() => (props.colorFn ? props.colorFn(props.status) : 'grey'))
const history = computed(() => props.history || [])
const hasHistory = computed(() => history.value.length > 0)
const colorFn = computed(() => props.colorFn || ((_s: string) => 'grey'))

function onClick() {
  if (hasHistory.value) dialog.value = true
}
</script>
