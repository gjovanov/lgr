<template>
  <!-- FR-28.32 / .33: the header of a document form, one component for the five that used to carry
       a copy of it (the six document types, the cash sale, both order forms, the reservation page).
       A row of equal columns — who (the party), which document (the number and its status), and
       when (the date) — and nothing else. The organization's name and the title the shell's <h1>
       already carries are gone: the top bar says whose books these are, and the heading says what
       this page is. A column whose slot is not given is not drawn, so an order form, which has no
       party and no date up here, is just its number.

       The two classes below are read by specs (`document-lists`, `p3-bill`, `p5-*`, `p6-proforma`,
       `receipt-to-bill`, `order-forms`): the number is the one `.text-h6` and the status the first
       `.v-chip` inside `.doc-banner-meta`. -->
  <div class="doc-banner px-4 py-3" :class="{ 'doc-banner--fields': $slots.party || $slots.date }">
    <v-row dense>
      <v-col v-if="$slots.party" cols="12" md="4" class="doc-banner-party">
        <div class="doc-banner-cell"><slot name="party" /></div>
      </v-col>
      <v-col cols="12" md="4" class="doc-banner-meta">
        <div class="doc-banner-cell">
          <div class="doc-banner-number d-flex align-center flex-wrap ga-2">
            <div class="text-h6 font-weight-bold" :data-testid="numberTestId">{{ number || '—' }}</div>
            <v-chip v-if="status" size="x-small" label :color="statusColor || 'primary'" variant="tonal">{{ status }}</v-chip>
            <!-- A second chip beside the status (a customer order's coverage). -->
            <slot name="chips" />
          </div>
        </div>
      </v-col>
      <v-col v-if="$slots.date" cols="12" md="4" class="doc-banner-date">
        <div class="doc-banner-cell"><slot name="date" /></div>
      </v-col>
    </v-row>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  /** The document's number as it reads now (a draft number before it is issued). */
  number?: string
  /** The status, already translated. No chip when empty. */
  status?: string
  /** Vuetify colour of the status chip; the primary colour when not given. */
  statusColor?: string
  /** `data-testid` on the number, for a page that has to find it by something other than its size. */
  numberTestId?: string
}>()
</script>

<style scoped>
.doc-banner {
  background: linear-gradient(
    90deg,
    rgba(var(--v-theme-primary), 0.06),
    rgba(var(--v-theme-primary), 0.01)
  );
  /* A compact filled field, and the one line its message takes (`required`, shown when the field
     loses focus). */
  --doc-banner-field: 42px;
  --doc-banner-message: 20px;
}
/* Room for that message, kept whether it shows or not. The banner is short on purpose, so without
   this a field losing focus grows it by a line, and everything under it moves while the mouse is
   still down: the click that took the focus away lands on something else and is dropped (the first
   click on „With product update" did nothing). Fields sit at the top of their cell, so a message
   fills the room under them and nothing moves. The minimum is on this inner box, not on the column:
   a column's own padding (the dense gutter) is inside its height. Only a banner that HAS a field
   keeps the room: an order's banner is its number and nothing can show a message there. */
.doc-banner--fields .doc-banner-cell {
  min-height: calc(var(--doc-banner-field) + var(--doc-banner-message));
}
/* The number is level with the field beside it, not with the room under it. */
.doc-banner-number {
  min-height: var(--doc-banner-field);
}
</style>
