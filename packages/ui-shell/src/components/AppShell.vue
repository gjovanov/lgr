<template>
  <v-app>
    <v-navigation-drawer
      :model-value="mobile ? mobileDrawerOpen : drawerOpen"
      @update:model-value="handleDrawerUpdate"
      :rail="!mobile && rail"
      :expand-on-hover="!mobile && rail"
      :temporary="mobile"
      :permanent="!mobile"
      :border="0"
    >
      <div class="org-header">
        <OrgSelector :org="org" :rail="!mobile && rail" @toggle-rail="rail = !rail" />
      </div>
      <v-list density="compact" nav>
        <slot name="nav-items" />
      </v-list>
    </v-navigation-drawer>

    <v-app-bar flat :border="0" class="app-bar-aligned">
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

    <slot name="right-sidebar" />
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
/* OrgSelector header with bottom border — this is the reference line */
.org-header {
  border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
}

/* App bar: match the OrgSelector height so bottom borders align */
:deep(.app-bar-aligned.v-toolbar) {
  border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity)) !important;
}

/* Rail mode: align nested items with parent icons */
:deep(.v-navigation-drawer--rail .v-list-group__items .v-list-item) {
  padding-inline-start: 16px !important;
}

/* Expanded mode: reduce nested item indent (half of default ~40px) */
:deep(.v-navigation-drawer:not(.v-navigation-drawer--rail) .v-list-group__items .v-list-item) {
  padding-inline-start: 28px !important;
}

/* Thin scrollbar on navigation drawer */
:deep(.v-navigation-drawer__content) {
  scrollbar-width: thin;
  scrollbar-color: rgba(128,128,128,0.3) transparent;
}
:deep(.v-navigation-drawer__content::-webkit-scrollbar) {
  width: 4px;
}
:deep(.v-navigation-drawer__content::-webkit-scrollbar-track) {
  background: transparent;
}
:deep(.v-navigation-drawer__content::-webkit-scrollbar-thumb) {
  background: rgba(128,128,128,0.3);
  border-radius: 4px;
}
:deep(.v-navigation-drawer__content::-webkit-scrollbar-thumb:hover) {
  background: rgba(128,128,128,0.5);
}

/* Bold uppercase table headers */
:deep(.v-data-table th),
:deep(.v-data-table-server th) {
  font-weight: 700 !important;
  text-transform: uppercase;
  font-size: 0.75rem !important;
  letter-spacing: 0.05em;
}

/* Page background uses surface-variant for card contrast */
:deep(.v-main) {
  background: rgb(var(--v-theme-surface-variant));
}
</style>
