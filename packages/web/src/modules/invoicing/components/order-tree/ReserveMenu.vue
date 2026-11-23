<template>
  <!-- FR-28.44: + Reserve on a customer-order line, and on the placeholder of a line with nothing reserved: where the
       goods come from. Each entry opens the dialog that already made that reservation, filtered to this line. The entries
       are not in the page until the menu is opened, so the order-wide buttons keep the page's only buttons of those names.
       A button with a menu: it opens with Enter or Space, the arrows move between the entries, Escape closes it. -->
  <v-menu location="bottom end">
    <template #activator="{ props: menuProps }">
      <v-btn
        v-bind="menuProps"
        size="x-small"
        variant="text"
        color="primary"
        :disabled="disabled"
        data-testid="tree-reserve"
      >{{ $t('invoicing.tree.reserveMenu') }}</v-btn>
    </template>
    <v-list density="compact">
      <v-list-item prepend-icon="mdi-warehouse" :title="$t('invoicing.tree.reserveFromStock')" data-testid="tree-reserve-stock" @click="emit('pick', 'stock')" />
      <v-list-item prepend-icon="mdi-truck-delivery-outline" :title="$t('invoicing.tree.reserveFromOrder')" data-testid="tree-reserve-order" @click="emit('pick', 'order')" />
      <v-list-item prepend-icon="mdi-factory" :title="$t('invoicing.generateExternalOrder')" data-testid="tree-reserve-generate" @click="emit('pick', 'generate')" />
    </v-list>
  </v-menu>
</template>

<script setup lang="ts">
defineProps<{
  /** Offered, but not now: a line with nothing short has nothing left to reserve. */
  disabled?: boolean
}>()

const emit = defineEmits<{
  /** Where the goods come from: free stock, a supplier order with room, or a new supplier order to be generated. */
  pick: [source: 'stock' | 'order' | 'generate']
}>()
</script>
