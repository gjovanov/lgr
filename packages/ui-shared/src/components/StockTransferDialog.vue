<template>
  <v-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)" max-width="900" persistent>
    <v-card>
      <v-card-title class="d-flex align-center">
        <v-icon color="warning" class="mr-2">mdi-alert-circle</v-icon>
        {{ $t('invoicing.transferRequired') }}
      </v-card-title>

      <v-card-text>
        <v-alert type="warning" variant="tonal" class="mb-4">
          {{ $t('invoicing.insufficientStock') }}
        </v-alert>

        <!-- One section per shortfall/proposal -->
        <div v-for="(proposal, pi) in editableProposals" :key="pi" class="mb-4 pa-4 border rounded">
          <div class="d-flex justify-space-between align-center mb-2">
            <span class="text-subtitle-2 font-weight-bold">{{ proposal.productName }} → {{ proposal.toWarehouseName }}</span>
            <v-chip size="small" :color="proposalCovered(pi) ? 'success' : 'error'" label>
              {{ proposalCovered(pi) ? 'Covered' : `Short by ${proposalDeficit(pi)}` }}
            </v-chip>
          </div>

          <v-table density="compact">
            <thead>
              <tr>
                <th>{{ $t('invoicing.selectSourceWarehouse') }}</th>
                <th class="text-end" style="width:100px">Available</th>
                <th class="text-end" style="width:140px">Transfer Qty</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(src, si) in proposal.sources" :key="si">
                <td>{{ src.fromWarehouseName }}</td>
                <td class="text-end">{{ src.available }}</td>
                <td style="width:140px">
                  <v-text-field
                    v-model.number="src.transferQuantity"
                    type="number"
                    min="0"
                    :max="src.available"
                    density="compact"
                    hide-details
                    variant="underlined"
                    class="text-end"
                  />
                </td>
              </tr>
            </tbody>
          </v-table>

          <div class="d-flex justify-space-between mt-2 text-body-2">
            <span>Needed: <strong>{{ shortfalls[pi]?.deficit }}</strong></span>
            <span>Total transfer: <strong>{{ proposalTotal(pi) }}</strong></span>
          </div>
        </div>

        <v-alert v-if="!allCovered" type="error" variant="tonal" density="compact">
          Some products are not fully covered. Adjust transfer quantities to proceed.
        </v-alert>
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="$emit('update:modelValue', false)">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="primary" :loading="confirming" :disabled="!allCovered" @click="confirmTransfers">
          {{ $t('common.confirm') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'

const props = defineProps<{
  modelValue: boolean
  shortfalls: any[]
  proposals: any[]
  allResolvable: boolean
  confirming?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'confirm': [proposals: any[]]
}>()

// Deep-copy proposals so user can edit transferQuantity without mutating parent
const editableProposals = ref<any[]>([])

watch(() => props.modelValue, (open) => {
  if (open) {
    editableProposals.value = JSON.parse(JSON.stringify(props.proposals))
  }
})

function proposalTotal(pi: number) {
  return editableProposals.value[pi]?.sources?.reduce((s: number, src: any) => s + (src.transferQuantity || 0), 0) ?? 0
}

function proposalDeficit(pi: number) {
  const needed = props.shortfalls[pi]?.deficit ?? 0
  return Math.max(0, needed - proposalTotal(pi))
}

function proposalCovered(pi: number) {
  return proposalDeficit(pi) === 0
}

const allCovered = computed(() => {
  return editableProposals.value.every((_, i) => proposalCovered(i))
})

function confirmTransfers() {
  // Filter out sources with 0 transfer quantity
  const cleaned = editableProposals.value.map(p => ({
    ...p,
    sources: p.sources.filter((s: any) => s.transferQuantity > 0),
    totalTransfer: p.sources.reduce((s: number, src: any) => s + (src.transferQuantity || 0), 0),
    deficit: 0,
  }))
  emit('confirm', cleaned)
}
</script>
