<template>
  <!-- FR-22.47: „Заприходи", „Продай", „Резервирай" on the article's page, in its header, so they are
       there on every tab. Each opens its document with the article on the first line. -->
  <div v-if="actions.length" class="d-flex align-center ga-2 flex-shrink-0" data-testid="product-doc-actions">
    <!-- The wrapper carries the tooltip: a disabled button takes no pointer events. -->
    <span v-for="a in actions" :key="a.key" class="d-inline-flex" :data-testid="`product-action-${a.key}-wrap`">
      <!-- A disabled one carries no link at all: a disabled `<a>` keeps its href. -->
      <ResponsiveBtn
        :icon="a.icon"
        :to="a.disabledKey ? undefined : a.to"
        :href="a.disabledKey ? undefined : a.href"
        :disabled="!!a.disabledKey"
        size="small"
        variant="tonal"
        color="primary"
        :aria-label="$t(a.labelKey)"
        :data-testid="`product-action-${a.key}`"
      >
        {{ $t(a.labelKey) }}
      </ResponsiveBtn>
      <!-- What it opens („Нова стокова разписка"), or why it cannot be taken now. -->
      <v-tooltip activator="parent" location="bottom">{{ $t(a.disabledKey || a.pageLabelKey) }}</v-tooltip>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import type { ProductForActions } from '../composables/product-doc-actions'
import { useProductDocActions } from '../composables/useProductDocActions'

const props = defineProps<{
  /** The article as stored (not as the form is being edited). Null until it has loaded. */
  product: ProductForActions | null
}>()

const { actionsFor } = useProductDocActions()

const actions = computed(() => (props.product?._id ? actionsFor(props.product) : []))
</script>
