<template>
  <div class="signature-footer mt-4">
    <div class="text-body-2 mb-3">
      <strong>{{ $t('invoicing.placeOfTransaction') }}:</strong> {{ shownPlace || '—' }}
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
import { computed } from 'vue'
import { placeOfIssueOf } from 'config/party-identity'

const props = defineProps<{
  /** Съставил — the document author (OCR-imported name or the creating user). */
  preparedBy?: string
  /** Място на сделката: the document's own. */
  place?: string
  /** FR-25a: the company's place of issue, shown where the document names none, as the printed form does. */
  orgPlace?: string
}>()

/** The printed form's rule (`config/party-identity`): for a company with no place of issue, exactly `place`. */
const shownPlace = computed(() => placeOfIssueOf(props.place, { placeOfIssue: props.orgPlace }))
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
