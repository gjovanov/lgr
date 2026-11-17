<template>
  <!-- FR-31.17: the one confirm dialog (`composables/confirm.ts#askConfirm`). Its buttons name the action. -->
  <v-dialog :model-value="confirmState.open" max-width="440" data-testid="confirm-dialog" @update:model-value="(open: boolean) => { if (!open) answerConfirm(false) }">
    <v-card v-if="confirmState.ask">
      <v-card-title v-if="confirmState.ask.title" class="text-wrap">{{ confirmState.ask.title }}</v-card-title>
      <v-card-text class="text-body-1">{{ confirmState.ask.text }}</v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" data-testid="confirm-dialog-no" @click="answerConfirm(false)">
          {{ confirmState.ask.cancel || $t('common.cancel') }}
        </v-btn>
        <v-btn :color="confirmState.ask.danger ? 'error' : 'primary'" variant="flat" data-testid="confirm-dialog-yes" @click="answerConfirm(true)">
          {{ confirmState.ask.confirm }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { answerConfirm, confirmState } from '../composables/confirm'
</script>
