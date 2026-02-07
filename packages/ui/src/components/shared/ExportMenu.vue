<template>
  <v-menu>
    <template #activator="{ props: menuProps }">
      <v-btn v-bind="menuProps" variant="outlined" prepend-icon="mdi-download">
        {{ $t('common.export') }}
      </v-btn>
    </template>
    <v-list density="compact">
      <v-list-item @click="emit('export', 'csv')">
        <v-list-item-title>CSV</v-list-item-title>
      </v-list-item>
      <v-list-item @click="emit('export', 'xlsx')">
        <v-list-item-title>Excel (XLSX)</v-list-item-title>
      </v-list-item>
      <v-list-item @click="emit('export', 'pdf')">
        <v-list-item-title>PDF</v-list-item-title>
      </v-list-item>
    </v-list>
  </v-menu>
</template>

<script setup lang="ts">
defineProps<{
  module?: string
}>()

const emit = defineEmits<{
  export: [format: string]
}>()
</script>
