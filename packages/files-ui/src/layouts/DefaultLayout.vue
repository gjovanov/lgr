<template>
  <ModuleLayout :manifest="manifest" />
</template>

<script setup lang="ts">
// FR-24.2: one shell for every module (ui-shell); what is files's is in its manifest.
import ModuleLayout from 'ui-shell/components/ModuleLayout'
import { manifest } from '../manifest'
</script>
