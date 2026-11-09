<template>
  <v-list-item :title="org?.name || 'Ledger'" nav @click="rail && $emit('toggle-rail')">
    <template #prepend>
      <v-icon color="primary">{{ rail ? 'mdi-chevron-right' : 'mdi-book-multiple' }}</v-icon>
    </template>
    <template #subtitle>
      <span>{{ org?.slug }}</span>
      <EnvBadge :environment="org?.environment" class="ml-2" />
    </template>
    <template #append>
      <v-btn
        :icon="rail ? 'mdi-chevron-right' : 'mdi-chevron-left'"
        variant="text"
        size="small"
        style="min-width: 44px; min-height: 44px"
        @click.stop="$emit('toggle-rail')"
      />
    </template>
  </v-list-item>
</template>

<script setup lang="ts">
import EnvBadge from './EnvBadge.vue'
import type { ShellOrg } from './types'

defineProps<{
  org: ShellOrg | null
  rail?: boolean
}>()

defineEmits<{
  'toggle-rail': []
}>()
</script>
