<template>
  <span class="ledger-movements">
    <template v-for="(m, i) in movements" :key="m.id">
      <span v-if="i > 0">, </span>
      <!-- A number is read whole: several movements wrap between them, never inside one. -->
      <span :title="describe(m)" class="text-no-wrap" data-testid="ledger-movement">
        <entity-link :label="m.number" :href="opens ? `/inventory/movements/${m.id}` : undefined" />
      </span>
      <span v-if="withReference && m.reference" class="ledger-movements__reference text-caption text-medium-emphasis text-no-wrap" data-testid="ledger-movement-reference">{{ m.reference }}</span>
    </template>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAccess } from '../access/useAccess'
import type { ContactLedgerMovement } from '../composables/useContactLedger'
import EntityLink from './EntityLink.vue'

/**
 * The stock movements a ledger row names, each by its number: a link to the movement for a role that opens Stock
 * Movement Documents, its number alone for one that does not. Hovering says what the movement is and which document
 * it was booked from; a movement's own row (`withReference`) prints that document under the number, since the row has
 * no other number to be known by.
 */
defineProps<{
  movements: ContactLedgerMovement[]
  withReference?: boolean
}>()

const { t } = useI18n()
const opens = computed(() => useAccess().can('movements.view'))

function describe(m: ContactLedgerMovement): string {
  return [t(`warehouse.movementTypes.${m.type}`, m.type), m.reference].filter(Boolean).join(' · ')
}
</script>

<style scoped>
.ledger-movements__reference {
  display: block;
}
</style>
