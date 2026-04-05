<template>
  <v-breadcrumbs v-if="breadcrumbItems.length > 0" :items="breadcrumbItems" class="px-4 py-2">
    <template #item="{ item }">
      <v-breadcrumbs-item
        :to="item.to"
        :disabled="item.disabled"
        class="text-body-2"
      >
        {{ item.title }}
      </v-breadcrumbs-item>
    </template>
  </v-breadcrumbs>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

export interface BreadcrumbItem {
  title: string
  to?: string
  disabled?: boolean
}

const props = defineProps<{
  items?: BreadcrumbItem[]
}>()

const route = useRoute()

const breadcrumbItems = computed<BreadcrumbItem[]>(() => {
  // Use explicit items override if provided
  if (props.items?.length) {
    return props.items.map((item, idx) => ({
      ...item,
      disabled: idx === props.items!.length - 1,
    }))
  }

  // Otherwise build from route meta.breadcrumb
  const crumbs: BreadcrumbItem[] = []
  for (const matched of route.matched) {
    const meta = matched.meta?.breadcrumb as BreadcrumbItem[] | undefined
    if (meta) {
      crumbs.push(...meta)
    }
  }

  // Last item is always disabled (current page)
  return crumbs.map((crumb, idx) => ({
    ...crumb,
    disabled: idx === crumbs.length - 1,
  }))
})
</script>
