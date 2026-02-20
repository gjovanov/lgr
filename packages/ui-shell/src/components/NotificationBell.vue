<template>
  <v-menu :close-on-content-click="false" max-width="400">
    <template #activator="{ props }">
      <v-btn v-bind="props" icon variant="text">
        <v-badge :content="unreadCount" :model-value="unreadCount > 0" color="error">
          <v-icon>mdi-bell</v-icon>
        </v-badge>
      </v-btn>
    </template>
    <v-card>
      <v-card-title class="d-flex align-center">
        <span>{{ $t('common.notifications') }}</span>
        <v-spacer />
        <v-btn v-if="unreadCount > 0" variant="text" size="small" @click="$emit('mark-all-read')">
          {{ $t('common.markAllRead') }}
        </v-btn>
      </v-card-title>
      <v-divider />
      <v-list v-if="notifications.length" density="compact" max-height="400" class="overflow-y-auto">
        <v-list-item
          v-for="n in notifications"
          :key="n._id"
          :class="{ 'bg-blue-lighten-5': !n.read }"
          @click="$emit('mark-read', n._id)"
        >
          <template #prepend>
            <v-icon :color="typeColor(n.type)" :icon="typeIcon(n.type)" />
          </template>
          <v-list-item-title>{{ n.title }}</v-list-item-title>
          <v-list-item-subtitle>{{ n.message }}</v-list-item-subtitle>
        </v-list-item>
      </v-list>
      <v-card-text v-else class="text-center text-grey">
        {{ $t('common.noNotifications') }}
      </v-card-text>
    </v-card>
  </v-menu>
</template>

<script setup lang="ts">

export interface NotificationItem {
  _id: string
  type: string
  title: string
  message: string
  read: boolean
  createdAt: string
}

defineProps<{
  notifications: NotificationItem[]
  unreadCount: number
}>()

defineEmits<{
  'mark-read': [id: string]
  'mark-all-read': []
}>()

function typeColor(type: string) {
  const colors: Record<string, string> = { info: 'blue', success: 'green', warning: 'orange', error: 'red' }
  return colors[type] || 'grey'
}

function typeIcon(type: string) {
  const icons: Record<string, string> = {
    info: 'mdi-information', success: 'mdi-check-circle', warning: 'mdi-alert', error: 'mdi-alert-circle',
  }
  return icons[type] || 'mdi-bell'
}
</script>
