<template>
  <!-- FR-24.14: the first navigation failed and no reload is coming. Blank, this tab would be a dead one. -->
  <v-app v-if="deadStart">
    <v-main>
      <v-container class="fill-height justify-center">
        <v-card max-width="460" data-testid="dead-start">
          <v-card-text>{{ $t('common.pageNotLoaded') }}</v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn href="/">{{ $t('appHub.title') }}</v-btn>
            <v-btn color="primary" variant="flat" @click="reloadNow">{{ $t('common.reload') }}</v-btn>
          </v-card-actions>
        </v-card>
      </v-container>
    </v-main>
  </v-app>
  <router-view v-else />
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
  <v-snackbar :model-value="newBuild && !deadStart" :timeout="-1" location="bottom" color="info" data-testid="new-build">
    {{ $t('common.newVersion') }}
    <template #actions>
      <v-btn variant="text" @click="reloadNow">{{ $t('common.reload') }}</v-btn>
    </template>
  </v-snackbar>
  <v-snackbar v-model="moveFailed" location="top" color="error" data-testid="move-failed">{{ $t('common.pageNotLoaded') }}</v-snackbar>
</template>

<script setup lang="ts">
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { deadStart, moveFailed, newBuild, reloadNow } from './stale'

const { snackbar, hideSnackbar } = useSnackbar()
</script>
