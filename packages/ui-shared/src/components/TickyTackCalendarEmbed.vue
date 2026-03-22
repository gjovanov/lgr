<template>
  <div v-if="enabled" class="tickytack-embed">
    <iframe
      :src="calendarUrl"
      style="width: 100%; height: 600px; border: none; border-radius: 8px;"
    />
  </div>
  <v-alert v-else type="info" variant="tonal" class="ma-2">
    {{ $t('timetracking.disabled') }}
  </v-alert>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  orgId: string
  projectId?: string
}>()

const enabled = computed(() => !!(window as any).__LGR_TICKYTACK_URL__)
const token = localStorage.getItem('lgr_token') || ''
const calendarUrl = computed(() => {
  const base = (window as any).__LGR_TICKYTACK_URL__ || ''
  const params = new URLSearchParams({ token })
  if (props.projectId) params.set('projectId', props.projectId)
  return `${base}/embed?${params}`
})
</script>
