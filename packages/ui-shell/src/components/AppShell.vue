<template>
  <v-app>
    <v-navigation-drawer
      :model-value="mobile ? mobileDrawerOpen : drawerOpen"
      @update:model-value="handleDrawerUpdate"
      :rail="!mobile && rail"
      :expand-on-hover="!mobile && rail"
      :temporary="mobile"
      :permanent="!mobile"
    >
      <OrgSelector :org="org" :rail="!mobile && rail" @toggle-rail="rail = !rail" />
      <v-divider />
      <v-list density="compact" nav>
        <slot name="nav-items" />
      </v-list>
    </v-navigation-drawer>

    <v-app-bar density="compact" flat>
      <v-app-bar-nav-icon @click="mobile ? (mobileDrawerOpen = !mobileDrawerOpen) : $emit('toggle-drawer')" />
      <v-toolbar-title v-if="!mobile" class="text-body-1">{{ org?.name }}</v-toolbar-title>
      <v-spacer />

      <LocaleSwitcher
        :locales="locales"
        :current-locale="currentLocale"
        @change="$emit('locale-change', $event)"
      />

      <ThemeToggle :is-dark="isDark" @toggle="$emit('theme-toggle')" />

      <AppSwitcher :apps="apps" :mobile="mobile" @navigate="$emit('app-navigate', $event)" @navigate-portal="$emit('portal-navigate')" />

      <NotificationBell
        :notifications="notifications"
        :unread-count="unreadCount"
        :mobile="mobile"
        @mark-read="$emit('notification-read', $event)"
        @mark-all-read="$emit('notification-read-all')"
      />

      <UserMenu :user="user" :compact="mobile" @logout="$emit('logout')" @profile="$emit('profile')" />
    </v-app-bar>

    <v-main>
      <slot />
    </v-main>
  </v-app>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useDisplay } from 'vuetify'
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

const emit = defineEmits<{
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

const { mobile } = useDisplay()
const rail = ref(true)
const mobileDrawerOpen = ref(false)

function handleDrawerUpdate(value: boolean) {
  if (mobile.value) {
    mobileDrawerOpen.value = value
  } else {
    emit('toggle-drawer')
  }
}
</script>

<style scoped>
/* In rail mode, remove extra indentation on nested list items so icons align with parent icons */
:deep(.v-navigation-drawer--rail .v-list-group__items .v-list-item) {
  padding-inline-start: 16px !important;
}
</style>
