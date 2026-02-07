<template>
  <v-app>
    <v-main class="d-flex align-center justify-center" style="min-height: 100vh; background: linear-gradient(135deg, #1565C0 0%, #0D47A1 100%)">
      <v-container style="max-width: 500px">
        <div class="text-center mb-6">
          <h1 class="text-h3 font-weight-bold text-white">{{ $t('app.name') }}</h1>
          <p class="text-subtitle-1 text-blue-lighten-3">{{ $t('app.tagline') }}</p>
        </div>
        <router-view />
      </v-container>
    </v-main>
  </v-app>
</template>

<script setup lang="ts">
</script>
