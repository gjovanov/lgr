<template>
  <div class="signature-footer mt-4">
    <div class="text-body-2 mb-3">
      <strong>{{ $t('invoicing.placeOfTransaction') }}:</strong> {{ place || '—' }}
    </div>
    <v-row dense>
      <!-- Left 50%: the recipient signs -->
      <v-col cols="12" md="6">
        <div class="text-body-2 mb-4">
          {{ $t('invoicing.recipient') }}: <span class="sig-line" />
        </div>
        <div class="text-body-2">
          {{ $t('invoicing.signatureLabel') }}: <span class="sig-line" />
        </div>
      </v-col>
      <!-- Right 50%: the author signs -->
      <v-col cols="12" md="6">
        <div class="text-body-2 mb-4">
          {{ $t('invoicing.preparedBy') }}: <strong>{{ preparedBy || '—' }}</strong>
        </div>
        <div class="text-body-2">
          {{ $t('invoicing.signatureLabel') }}: <span class="sig-line" />
        </div>
      </v-col>
    </v-row>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  /** Съставил — the document author (OCR-imported name or the creating user). */
  preparedBy?: string
  /** Място на сделката. */
  place?: string
}>()
</script>

<style scoped>
.sig-line {
  display: inline-block;
  min-width: 220px;
  border-bottom: 1px dotted currentColor;
  vertical-align: baseline;
  height: 1em;
}
</style>
