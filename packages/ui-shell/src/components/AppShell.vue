<template>
  <v-app>
    <v-navigation-drawer :model-value="drawerOpen" @update:model-value="$emit('toggle-drawer')" :rail="rail" permanent>
      <OrgSelector :org="org" :rail="rail" @toggle-rail="rail = !rail" />
      <v-divider />
      <v-list density="compact" nav>
        <slot name="nav-items" />
      </v-list>
    </v-navigation-drawer>

    <v-app-bar density="compact" flat>
      <v-app-bar-nav-icon @click="$emit('toggle-drawer')" />
      <v-toolbar-title class="text-body-1">{{ org?.name }}</v-toolbar-title>
      <v-spacer />

      <LocaleSwitcher
        :locales="locales"
        :current-locale="currentLocale"
        @change="$emit('locale-change', $event)"
      />

      <ThemeToggle :is-dark="isDark" @toggle="$emit('theme-toggle')" />

      <AppSwitcher :apps="apps" @navigate="$emit('app-navigate', $event)" @navigate-portal="$emit('portal-navigate')" />

      <NotificationBell
        :notifications="notifications"
        :unread-count="unreadCount"
        @mark-read="$emit('notification-read', $event)"
        @mark-all-read="$emit('notification-read-all')"
      />

      <UserMenu :user="user" @logout="$emit('logout')" @profile="$emit('profile')" />
    </v-app-bar>

    <v-main>
      <slot />
    </v-main>
  </v-app>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { AppInfo, ShellUser, ShellOrg } from './types'
import type { NotificationItem } from './NotificationBell.vue'
import AppSwitcher from './AppSwitcher.vue'
import OrgSelector from './OrgSelector.vue'
import UserMenu from './UserMenu.vue'
import NotificationBell from './NotificationBell.vue'
import ThemeToggle from './ThemeToggle.vue'
import LocaleSwitcher from './LocaleSwitcher.vue'

defineProps<{
  org: ShellOrg | null
  user: ShellUser | null
  apps: AppInfo[]
  notifications: NotificationItem[]
  unreadCount: number
  isDark: boolean
  locales: string[]
  currentLocale: string
  drawerOpen: boolean
}>()

defineEmits<{
  'toggle-drawer': []
  'locale-change': [locale: string]
  'theme-toggle': []
  'app-navigate': [app: AppInfo]
  'portal-navigate': []
  'notification-read': [id: string]
  'notification-read-all': []
  logout: []
  profile: []
}>()

const rail = ref(false)
</script>
