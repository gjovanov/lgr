<template>
  <EmptyState
    :icon="failure === 'forbidden' ? 'mdi-lock-outline' : 'mdi-cloud-alert-outline'"
    :title="$t(`common.listFailure.${failure}`)"
    data-testid="list-load-error"
    :data-failure="failure"
  >
    <template #actions>
      <v-btn color="primary" variant="flat" data-testid="list-load-error-retry" @click="emit('retry')">{{ $t('common.retry') }}</v-btn>
    </template>
  </EmptyState>
</template>

<script setup lang="ts">
/**
 * FR-31.7: a list whose request failed or was refused says so, with Retry, in the place of its rows. It is never the
 * "no rows" state: a list that could not be read is not an empty one. `ListScaffold` draws it from
 * `pagination.loadError`; a list with a table of its own puts it in the table's `#no-data`.
 */
import EmptyState from './EmptyState.vue'
import type { LoadFailure } from '../composables/load-failure'

defineProps<{ failure: LoadFailure }>()
const emit = defineEmits<{ retry: [] }>()
</script>
