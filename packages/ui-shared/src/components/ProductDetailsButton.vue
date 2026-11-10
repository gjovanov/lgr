<template>
  <!-- FR-28.25 — "Details": the way from any product field into the product dialog, the Products list in a window.
       The same button, the same tooltip and the same key (F4) on every screen that picks a product. It stays out
       of the tab order (the keyboard's way in is F4, in the field), as the ⌕ it replaces did. -->
  <v-btn
    icon="mdi-magnify-expand"
    size="x-small"
    variant="text"
    tabindex="-1"
    :aria-label="$t('invoicing.productDetails.button')"
    :disabled="disabled"
    data-testid="product-details"
  >
    <v-icon>mdi-magnify-expand</v-icon>
    <v-tooltip activator="parent" location="top">{{ $t('invoicing.productDetails.tooltip') }}</v-tooltip>
  </v-btn>
</template>

<script setup lang="ts">
defineProps<{ disabled?: boolean }>()
</script>
