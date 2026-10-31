<template>
  <router-view />
  <v-snackbar
    v-model="snackbar.visible"
    :color="snackbar.color"
    :timeout="snackbar.timeout"
    location="top"
  >
    {{ snackbar.message }}
    <template #actions>
      <v-btn variant="text" @click="hideSnackbar">{{ $t('common.close') }}</v-btn>
    </template>
  </v-snackbar>
  <!-- FR-24.14: a newer build is served; offered, never forced while a form is dirty or a printer is up. -->
  <v-snackbar :model-value="newBuild" :timeout="-1" location="bottom" color="info" data-testid="new-build">
    {{ $t('common.newVersion') }}
    <template #actions>
      <v-btn variant="text" @click="reloadNow">{{ $t('common.reload') }}</v-btn>
    </template>
  </v-snackbar>
</template>

<script setup lang="ts">
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { newBuild, reloadNow } from './stale'

const { snackbar, hideSnackbar } = useSnackbar()
</script>
