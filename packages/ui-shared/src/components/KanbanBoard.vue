<template>
  <div class="kanban-board d-flex overflow-x-auto ga-4 pa-2" style="min-height: 400px">
    <div
      v-for="stage in stages"
      :key="stage.name"
      class="kanban-column flex-shrink-0"
      :style="{ minWidth: '280px', maxWidth: '320px' }"
    >
      <v-card variant="outlined" class="h-100">
        <v-card-title class="text-subtitle-1 d-flex align-center justify-space-between py-2 px-3 bg-grey-lighten-4">
          <span>{{ stage.label || stage.name }}</span>
          <v-chip size="x-small" variant="tonal">{{ getStageItems(stage.name).length }}</v-chip>
        </v-card-title>
        <v-divider />
        <div class="kanban-cards pa-2 d-flex flex-column ga-2" style="min-height: 300px; max-height: 70vh; overflow-y: auto">
          <v-card
            v-for="item in getStageItems(stage.name)"
            :key="item.id"
            class="kanban-card cursor-pointer"
            variant="elevated"
            elevation="1"
            @click="$emit('card-click', item)"
          >
            <slot name="card" :item="item">
              <v-card-text class="pa-3">
                <div class="text-subtitle-2">{{ item.name || item.title }}</div>
              </v-card-text>
            </slot>
          </v-card>
          <div v-if="getStageItems(stage.name).length === 0" class="text-center text-grey py-8">
            {{ emptyText || 'No items' }}
          </div>
        </div>
      </v-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface Stage {
  name: string
  label?: string
}

const props = defineProps<{
  stages: Stage[]
  items: any[]
  stageKey?: string
  emptyText?: string
}>()

defineEmits<{
  'card-click': [item: any]
}>()

const stageKeyName = computed(() => props.stageKey || 'stageName')

function getStageItems(stageName: string) {
  return props.items.filter(item => item[stageKeyName.value] === stageName)
}
</script>

<style scoped>
.kanban-board {
  scrollbar-width: thin;
}
.kanban-card:hover {
  border-color: rgb(var(--v-theme-primary));
}
.cursor-pointer {
  cursor: pointer;
}
</style>
