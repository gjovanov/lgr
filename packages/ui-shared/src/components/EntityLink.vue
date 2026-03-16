<template>
  <a v-if="href" :href="href" class="entity-link" @click.stop>{{ label }}</a>
  <router-link v-else-if="to" :to="to" class="entity-link" @click.stop>{{ label }}</router-link>
  <span v-else>{{ label }}</span>
</template>

<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'

defineProps<{
  label: string
  to?: RouteLocationRaw
  href?: string
}>()
</script>

<style scoped>
.entity-link {
  color: rgb(var(--v-theme-primary));
  text-decoration: none;
  font-weight: 500;
}
.entity-link:hover {
  text-decoration: underline;
}
</style>
