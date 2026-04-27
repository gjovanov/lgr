<template>
  <v-dialog
    :model-value="store.leaveDialogOpen"
    max-width="480"
    persistent
  >
    <v-card>
      <v-card-title class="text-body-1 font-weight-bold">
        {{ $t('pendingChanges.leaveTitle') }}
      </v-card-title>
      <v-card-text>
        <p class="mb-3">{{ $t('pendingChanges.leaveBody') }}</p>
        <v-checkbox
          v-model="dontShowAgain"
          :label="$t('pendingChanges.dontShowAgain')"
          density="compact"
          hide-details
        />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="onCancel">{{ $t('common.cancel') }}</v-btn>
        <v-btn color="primary" variant="flat" @click="onConfirm">{{ $t('common.confirm') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { usePendingChangesStore } from 'ui-shared/stores/pending-changes.store'

const store = usePendingChangesStore()
const dontShowAgain = ref(false)

watch(() => store.leaveDialogOpen, open => {
  if (open) dontShowAgain.value = false
})

function onCancel() {
  store.resolveLeaveDecision('cancel')
}

function onConfirm() {
  store.resolveLeaveDecision(dontShowAgain.value ? 'ack' : 'ok')
}
</script>
