<template>
  <v-btn
    v-bind="$attrs"
    :icon="mobile || undefined"
    :prepend-icon="mobile ? undefined : icon"
  >
    <v-icon v-if="mobile">{{ icon }}</v-icon>
    <template v-if="!mobile"><slot /></template>
  </v-btn>
</template>

<script setup lang="ts">
import { useDisplay } from 'vuetify'

const { mobile } = useDisplay()

defineProps<{
  icon: string
}>()
</script>
