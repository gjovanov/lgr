<template>
  <v-menu>
    <template #activator="{ props: menuProps }">
      <v-btn
        v-bind="menuProps"
        variant="outlined"
        :icon="mobile || undefined"
        :prepend-icon="mobile ? undefined : 'mdi-download'"
      >
        <v-icon v-if="mobile">mdi-download</v-icon>
        <template v-if="!mobile">{{ $t('common.export') }}</template>
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
import { useDisplay } from 'vuetify'

const { mobile } = useDisplay()

defineProps<{
  module?: string
}>()

const emit = defineEmits<{
  export: [format: string]
}>()
</script>
