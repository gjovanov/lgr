<template>
  <v-container class="py-8" style="max-width: 720px">
    <v-card variant="flat" border>
      <v-card-item>
        <v-card-title class="d-flex align-center ga-2">
          <v-icon :icon="icon" />
          {{ title }}
        </v-card-title>
        <v-card-subtitle>{{ subtitle }}</v-card-subtitle>
      </v-card-item>
      <v-card-text>
        <v-alert type="info" variant="tonal" density="comfortable">
          Not built yet. This view arrives with the shell's pages (FR-14.30–14.33).
        </v-alert>
        <p class="text-body-2 mt-4 mb-0 text-medium-emphasis">
          LGR Desktop opens the LGR cloud app; there is no local mode and no local data.
        </p>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
/**
 * The one card every shell view renders until FR-14.30–14.33 builds them for real.
 *
 * ⚠ It exists so `desktop-ui` has something to compile after local mode was removed
 * (FR-14.34). Its job is to keep the package in `bun run build` — the bit-rot that broke this
 * package unnoticed from 2026-08-22 to 2026-08-26 happened precisely because nothing built it.
 *
 * It uses no network and no store, so it renders with the machine offline, which is the standing
 * requirement for every shell page (FR-14.31).
 */
defineProps<{ title: string; subtitle: string; icon: string }>()
</script>
