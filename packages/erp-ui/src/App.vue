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
      <v-btn variant="text" @click="hideSnackbar">Close</v-btn>
    </template>
  </v-snackbar>
</template>

<script setup lang="ts">
import { useSnackbar } from 'ui-shared/composables/useSnackbar'

const { snackbar, hideSnackbar } = useSnackbar()
</script>
