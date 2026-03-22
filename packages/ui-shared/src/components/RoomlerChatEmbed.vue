<template>
  <div v-if="enabled" class="roomler-embed">
    <iframe
      v-if="roomId"
      :src="chatUrl"
      :style="{ width: '100%', height: `${height}px`, border: 'none', borderRadius: '8px' }"
      allow="camera; microphone; display-capture"
    />
    <v-alert v-else type="info" variant="tonal" class="ma-2">
      {{ $t('discuss.noRoom') }}
    </v-alert>
  </div>
  <v-alert v-else type="info" variant="tonal" class="ma-2">
    {{ $t('discuss.disabled') }}
  </v-alert>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  roomId?: string
  height?: number
}>(), { height: 500 })

const enabled = computed(() => !!(window as any).__LGR_ROOMLER_URL__)
const token = localStorage.getItem('lgr_token') || ''
const chatUrl = computed(() => {
  const base = (window as any).__LGR_ROOMLER_URL__ || ''
  return `${base}/embed/room/${props.roomId}?token=${encodeURIComponent(token)}`
})
</script>
