<template>
  <v-list-item :title="org?.name || 'Ledger'" :subtitle="org?.slug" nav>
    <template #prepend>
      <v-icon color="primary">mdi-book-multiple</v-icon>
    </template>
    <template #append>
      <v-btn icon="mdi-chevron-left" variant="text" size="small" @click="$emit('toggle-rail')" />
    </template>
  </v-list-item>
</template>

<script setup lang="ts">
import type { ShellOrg } from './types'

defineProps<{
  org: ShellOrg | null
}>()

defineEmits<{
  'toggle-rail': []
}>()
</script>
