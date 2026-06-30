<template>
  <v-card class="mb-4">
    <v-card-text class="pb-3">
      <v-defaults-provider :defaults="fieldDefaults">
        <v-row dense align="center">
          <v-col v-if="searchable" cols="12" sm="6" :md="searchMd">
            <v-text-field
              :model-value="search"
              prepend-inner-icon="mdi-magnify"
              :label="$t('common.search')"
              clearable
              @update:model-value="$emit('update:search', $event ?? '')"
            />
          </v-col>
          <!-- Caller-supplied filter columns: each a <v-col cols="12" sm="6" md="2"> -->
          <slot />
        </v-row>
      </v-defaults-provider>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
/**
 * Consistent, responsive filter row shared across list pages. Owns the universal
 * search field (toggle with `searchable`) and forces compact density + hidden
 * detail rows on every slotted control via <v-defaults-provider>, so callers no
 * longer repeat `hide-details density="compact"` on each field.
 *
 * Breakpoint convention: search md=3, each compact filter md=2, tags md=3.
 */
withDefaults(defineProps<{
  search?: string
  searchable?: boolean
  searchMd?: number | string
}>(), {
  search: '',
  searchable: true,
  searchMd: 3,
})

defineEmits<{ 'update:search': [v: string] }>()

const fieldDefaults = {
  VTextField: { density: 'compact', hideDetails: true, variant: 'outlined' },
  VSelect: { density: 'compact', hideDetails: true, variant: 'outlined' },
  VAutocomplete: { density: 'compact', hideDetails: true, variant: 'outlined' },
  VCombobox: { density: 'compact', hideDetails: true, variant: 'outlined' },
}
</script>
