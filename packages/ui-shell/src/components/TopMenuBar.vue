<template>
  <!-- Desktop: horizontal toolbar with dropdown menus -->
  <v-toolbar v-if="!mobile" density="compact" flat class="top-menu-bar">
    <template v-for="item in menuItems" :key="item.label">
      <!-- Item with children: dropdown menu -->
      <v-menu v-if="item.children?.length" :close-on-content-click="true" offset-y>
        <template #activator="{ props }">
          <v-btn
            v-bind="props"
            variant="text"
            size="small"
            :class="{ 'menu-active': isGroupActive(item) }"
          >
            <v-icon v-if="item.icon" start size="small">{{ item.icon }}</v-icon>
            {{ item.label }}
            <v-icon end size="small">mdi-chevron-down</v-icon>
          </v-btn>
        </template>
        <v-list density="compact" nav>
          <template v-for="(child, idx) in item.children" :key="idx">
            <v-divider v-if="child.divider" class="my-1" />
            <v-list-item
              v-else
              :to="child.to"
              :prepend-icon="child.icon"
              :title="child.label"
            />
          </template>
        </v-list>
      </v-menu>

      <!-- Item without children: direct link -->
      <v-btn
        v-else
        :to="item.to"
        variant="text"
        size="small"
        :class="{ 'menu-active': isItemActive(item) }"
      >
        <v-icon v-if="item.icon" start size="small">{{ item.icon }}</v-icon>
        {{ item.label }}
      </v-btn>
    </template>
  </v-toolbar>

  <!-- Mobile: hamburger menu with expandable groups -->
  <v-menu v-else :close-on-content-click="true">
    <template #activator="{ props }">
      <v-btn v-bind="props" icon variant="text" size="small" class="ml-1">
        <v-icon>mdi-menu</v-icon>
      </v-btn>
    </template>
    <v-list density="compact" nav>
      <template v-for="item in menuItems" :key="item.label">
        <v-list-group v-if="item.children?.length" :value="item.label">
          <template #activator="{ props }">
            <v-list-item v-bind="props" :prepend-icon="item.icon" :title="item.label" />
          </template>
          <template v-for="(child, idx) in item.children" :key="idx">
            <v-divider v-if="child.divider" class="my-1" />
            <v-list-item
              v-else
              :to="child.to"
              :prepend-icon="child.icon"
              :title="child.label"
            />
          </template>
        </v-list-group>
        <v-list-item
          v-else
          :to="item.to"
          :prepend-icon="item.icon"
          :title="item.label"
        />
      </template>
    </v-list>
  </v-menu>
</template>

<script setup lang="ts">
import { useDisplay } from 'vuetify'
import { useRoute } from 'vue-router'

export interface TopMenuItem {
  label: string
  icon?: string
  to?: string
  children?: TopMenuChild[]
}

export interface TopMenuChild {
  label: string
  icon?: string
  to?: string
  divider?: boolean
}

defineProps<{
  menuItems: TopMenuItem[]
}>()

const { mobile } = useDisplay()
const route = useRoute()

function isGroupActive(item: TopMenuItem): boolean {
  if (!item.children) return false
  return item.children.some(child => child.to && route.path.startsWith(child.to))
}

function isItemActive(item: TopMenuItem): boolean {
  return !!item.to && route.path.startsWith(item.to)
}
</script>

<style scoped>
.top-menu-bar {
  border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.menu-active {
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
}
</style>
