<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.sequences') }}</h1>
    </div>
    <v-card>
      <v-card-text>
        <v-alert type="info" variant="tonal">
          {{ $t('sequences.placeholder') }}
        </v-alert>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
</script>
