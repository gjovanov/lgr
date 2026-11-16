<template>
  <!-- What is ticked, and what to do with it: as on the Products list (FR-28.14). -->
  <div v-if="selected.length" class="mb-3" data-testid="selection-bar">
    <div class="d-flex align-center ga-2 flex-wrap">
      <v-chip color="primary" variant="tonal" data-testid="selection-count">
        {{ $t('docEmail.bar.selected', { n: selected.length }) }}
      </v-chip>
      <v-tooltip v-if="mayEmail" :disabled="!overCap" location="bottom">
        <template #activator="{ props: tip }">
          <span v-bind="tip">
            <v-btn
              color="primary"
              variant="flat"
              prepend-icon="mdi-email-arrow-right-outline"
              :disabled="overCap"
              data-testid="email-selected"
              @click="dialog = true"
            >
              {{ $t('docEmail.bar.send') }}
            </v-btn>
          </span>
        </template>
        {{ $t('docEmail.bar.tooMany', { max: MAX_SELECTION }) }}
      </v-tooltip>
      <v-btn variant="text" data-testid="selection-clear" @click="emit('update:selected', [])">{{ $t('docEmail.bar.clear') }}</v-btn>
      <span v-if="mayEmail && overCap" class="text-body-2 text-error" data-testid="selection-too-many">
        {{ $t('docEmail.bar.tooMany', { max: MAX_SELECTION }) }}
      </span>
    </div>
  </div>

  <!-- Beside the bar, not inside it: the bar goes when the last ticked document has gone, the dialog closes itself. -->
  <BatchEmailDialog
    v-if="mayEmail"
    v-model="dialog"
    :kind="kind"
    :org-url="orgUrl"
    :preview-path="previewPath"
    :email-path="emailPath"
    :ids="selected"
    :org-name="orgName"
    :locale="locale"
    :columns="columns"
    @sent="onSent"
  />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { MAX_SELECTION } from 'config/doc-email'
import BatchEmailDialog from './BatchEmailDialog.vue'

/**
 * The bar over a list whose rows can be ticked (2026-11-16): how many are, „Изпрати по имейл", and Clear. It goes in
 * `ListScaffold`'s `#bulk-bar` slot (or above a table of its own) and owns the dialog:
 *
 *     <ListScaffold selectable v-model:selected="ticked" …>
 *       <template #bulk-bar>
 *         <BatchEmailBar v-model:selected="ticked" kind="invoice" :org-url="…" preview-path="…" email-path="…" :may-email="…" />
 *       </template>
 *
 * Generic over the kind of document, as the dialog is: a kind is its name and its two endpoints.
 *
 * `mayEmail` is the list's own answer to "does this role mail these documents" (it consults the session's access):
 * a role that only reads sees what it ticked and Clear, and no button the server would refuse.
 */
const props = defineProps<{
  /** The ticked ids (`v-model:selected`). */
  selected: string[]
  kind: string
  orgUrl: string
  previewPath: string
  emailPath: string
  mayEmail: boolean
  orgName?: string
  locale?: string
  columns?: () => string[] | undefined
}>()

const emit = defineEmits<{ 'update:selected': [ids: string[]] }>()

const dialog = ref(false)
/** More than one dialog takes: the server would refuse the preview (422 `selection_too_large`). */
const overCap = computed(() => props.selected.length > MAX_SELECTION)

/** What went leaves the selection; what did not stays ticked, to be tried again. */
function onSent(ids: string[]) {
  const went = new Set(ids)
  emit('update:selected', props.selected.filter(id => !went.has(id)))
}
</script>
