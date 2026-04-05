<template>
  <div class="kanban-board d-flex ga-3 overflow-x-auto pa-2">
    <div
      v-for="col in columns"
      :key="col.id"
      class="kanban-column"
      @dragover.prevent
      @drop="onDrop($event, col.id)"
    >
      <!-- Column header -->
      <div class="kanban-column-header d-flex align-center justify-space-between pa-3">
        <div class="d-flex align-center ga-2">
          <span class="text-subtitle-2 font-weight-bold">{{ col.title }}</span>
          <v-chip size="x-small" :color="col.color || 'default'" variant="tonal">
            {{ (items[col.id] || []).length }}
          </v-chip>
        </div>
      </div>

      <!-- Column cards -->
      <div class="kanban-column-body pa-2">
        <div
          v-for="item in (items[col.id] || [])"
          :key="item[itemKey]"
          class="kanban-card mb-2"
          :draggable="dragEnabled !== false"
          @dragstart="onDragStart($event, item[itemKey], col.id)"
          @dragend="onDragEnd"
        >
          <v-card variant="outlined" class="pa-3" :class="{ 'dragging': draggedId === item[itemKey] }">
            <slot name="card" :item="item" :column="col" />
          </v-card>
        </div>

        <!-- Empty state -->
        <div
          v-if="!(items[col.id] || []).length"
          class="kanban-empty text-center pa-4 text-medium-emphasis text-caption"
        >
          No items
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

export interface KanbanColumn {
  id: string
  title: string
  color?: string
}

const props = defineProps<{
  columns: KanbanColumn[]
  items: Record<string, any[]>
  itemKey: string
  dragEnabled?: boolean
}>()

const emit = defineEmits<{
  move: [itemId: string, fromColumnId: string, toColumnId: string]
}>()

const draggedId = ref<string | null>(null)
const dragSourceCol = ref<string | null>(null)

function onDragStart(event: DragEvent, id: string, colId: string) {
  draggedId.value = id
  dragSourceCol.value = colId
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
  }
}

function onDragEnd() {
  draggedId.value = null
  dragSourceCol.value = null
}

function onDrop(event: DragEvent, targetColId: string) {
  event.preventDefault()
  if (!draggedId.value || !dragSourceCol.value) return
  if (dragSourceCol.value === targetColId) return
  emit('move', draggedId.value, dragSourceCol.value, targetColId)
  draggedId.value = null
  dragSourceCol.value = null
}
</script>

<style scoped>
.kanban-board {
  min-height: 400px;
}

.kanban-column {
  min-width: 280px;
  max-width: 320px;
  flex: 1;
  background: rgba(var(--v-theme-surface-variant), 0.08);
  border-radius: 8px;
}

.kanban-column-header {
  border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.kanban-column-body {
  min-height: 200px;
  max-height: calc(100vh - 300px);
  overflow-y: auto;
}

.kanban-card {
  cursor: grab;
}

.kanban-card:active {
  cursor: grabbing;
}

.kanban-card .dragging {
  opacity: 0.5;
}

.kanban-empty {
  min-height: 100px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px dashed rgba(var(--v-border-color), 0.3);
  border-radius: 8px;
}
</style>
