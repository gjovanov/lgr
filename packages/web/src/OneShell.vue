<template>
  <ModuleLayout :manifest="current" />
</template>

<script setup lang="ts">
/**
 * FR-24.11: ONE shell record holds every module, so moving between modules re-renders the menu
 * (data, from the current module's manifest) and never remounts the layout.
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ModuleLayout from 'ui-shell/components/ModuleLayout'
import { MODULES, moduleOf } from './modules'

const route = useRoute()
const current = computed(() => moduleOf(route) ?? MODULES[0])
</script>
