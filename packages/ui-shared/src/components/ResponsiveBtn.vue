<template>
  <v-btn
    v-bind="$attrs"
    :icon="mobile ? icon : undefined"
    :prepend-icon="mobile ? undefined : icon"
  >
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
