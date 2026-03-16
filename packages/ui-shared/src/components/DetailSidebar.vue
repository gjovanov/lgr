<template>
  <v-navigation-drawer
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    location="right"
    temporary
    :width="400"
    :border="0"
  >
    <div class="d-flex align-center pa-3">
      <h3 class="text-body-1 font-weight-bold flex-grow-1 text-truncate">{{ entityName }}</h3>
      <v-btn icon="mdi-close" variant="text" size="small" @click="$emit('update:modelValue', false)" />
    </div>
    <v-divider />
    <v-tabs v-model="activeTab" density="compact">
      <v-tab value="audit">{{ $t ? $t('common.auditLog', 'Audit Log') : 'Audit Log' }}</v-tab>
      <slot name="tabs" />
    </v-tabs>
    <v-divider />
    <v-tabs-window v-model="activeTab">
      <v-tabs-window-item value="audit">
        <AuditLogPanel v-if="entityId" :entity-type="entityType" :entity-id="entityId" :org-url="orgUrl" />
      </v-tabs-window-item>
      <slot name="tab-items" />
    </v-tabs-window>
  </v-navigation-drawer>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import AuditLogPanel from './AuditLogPanel.vue'

defineProps<{
  modelValue: boolean
  entityType: string
  entityId: string
  entityName: string
  orgUrl: string
}>()

defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const activeTab = ref('audit')
</script>
