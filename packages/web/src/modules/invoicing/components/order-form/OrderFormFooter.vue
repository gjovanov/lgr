<template>
  <!-- Notes / terms / tags + totals -->
  <v-row class="mt-4">
    <v-col cols="12" md="6">
      <v-textarea v-model="notes" :label="$t('common.notes')" rows="2" auto-grow :readonly="readonly" />
      <v-textarea v-model="terms" :label="$t('invoicing.terms')" rows="2" auto-grow :readonly="readonly" />
      <TagInput v-model="tags" :type="tagType" :org-url="orgUrl" class="mt-2" />
    </v-col>
    <v-col cols="12" md="6">
      <v-card variant="outlined">
        <v-card-text>
          <div class="d-flex justify-space-between mb-2">
            <span>{{ $t('invoicing.orderedQty') }}</span>
            <span class="font-weight-medium">{{ ordered }}</span>
          </div>
          <div class="d-flex justify-space-between mb-2">
            <span>{{ $t('invoicing.reservedQty') }}</span>
            <span>{{ reserved }}</span>
          </div>
          <div v-if="isEdit" class="d-flex justify-space-between mb-2">
            <span>{{ $t(movedLabel) }}</span>
            <span>{{ moved }}</span>
          </div>
          <v-divider class="my-2" />
          <div class="d-flex justify-space-between text-h6">
            <span>{{ $t('invoicing.estimatedTotal') }}</span>
            <span>{{ total }}</span>
          </div>
        </v-card-text>
      </v-card>
    </v-col>
  </v-row>

  <!-- Bottom action bar mirroring the shell's top actions. -->
  <template v-if="!readonly">
    <v-divider class="my-4" />
    <div class="d-flex justify-end ga-2 flex-wrap pb-2">
      <v-btn v-cap="isEdit ? ['orders.create', 'orders.edit'] : 'orders.create'" color="primary" variant="flat" prepend-icon="mdi-content-save" :loading="saving" @click="emit('save')">
        {{ $t('common.save') }}
      </v-btn>
    </div>
  </template>
</template>

<script setup lang="ts">
/**
 * FR-32.23 (#797): the foot of both order forms, the supplier order's and the customer order's: notes, terms and tags,
 * the totals card, and the Save button under them. The third figure of the card is what has moved: received on a
 * supplier order, delivered on a customer order.
 */
import TagInput from 'ui-shared/components/TagInput.vue'

defineProps<{
  /** The kind of tags: `order` or `internal_order`. */
  tagType: string
  orgUrl: string
  readonly: boolean
  isEdit: boolean
  saving: boolean
  ordered: number
  reserved: number
  /** The label of the third figure, and the figure. */
  movedLabel: string
  moved: number
  /** The estimated total, in the order's currency. */
  total: string
}>()
const notes = defineModel<string>('notes', { required: true })
const terms = defineModel<string>('terms', { required: true })
const tags = defineModel<string[]>('tags', { required: true })
const emit = defineEmits<{ save: [] }>()
</script>
