<template>
  <!-- FR-28.43: a card whose body folds away. The header is where the card says what it holds; when
       folded it also says how much ("2 lines · 300 ordered · 85 reserved"), so closing a panel
       loses nothing a glance needs. The toggle is a button of its own, NOT the whole header: a
       header may hold fields and menus (a supplier select, an Export menu), and those cannot sit
       inside a button. -->
  <v-card variant="outlined" rounded="lg" v-bind="$attrs" class="collapsible-panel" :data-open="open ? 'true' : 'false'">
    <v-card-title class="d-flex align-center ga-2 py-2 flex-wrap collapsible-panel__title">
      <v-btn
        :icon="open ? 'mdi-chevron-down' : 'mdi-chevron-right'"
        size="x-small"
        variant="text"
        :aria-expanded="open ? 'true' : 'false'"
        :aria-controls="bodyId"
        :aria-label="toggleLabel"
        :title="toggleLabel"
        data-testid="panel-toggle"
        @click="toggle"
      />
      <slot name="title" />
      <!-- A thing that needs attention stays visible when the panel is closed. -->
      <v-chip v-if="flag" size="x-small" label color="warning" variant="tonal" prepend-icon="mdi-alert-outline" data-testid="panel-flag">{{ flag }}</v-chip>
      <span v-if="!open && summary" class="text-body-2 text-medium-emphasis" data-testid="panel-summary">{{ summary }}</span>
      <v-spacer />
      <slot name="actions" />
    </v-card-title>
    <!-- v-show, not v-if: a folded panel's fields are still the form's fields (they validate, and
         what is typed in them is kept), it only stops taking room. -->
    <v-expand-transition>
      <div v-show="open" :id="bodyId" data-testid="panel-body">
        <v-divider />
        <slot />
      </div>
    </v-expand-transition>
  </v-card>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePanelState } from '../composables/usePanelState'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  /** The screen the panel is on, e.g. `orders.edit`: with the user and the organization, the key its state is kept under. */
  screen: string
  /** The panel within its screen. A card repeated per row (a supplier group) needs one id per row. */
  panelId: string
  /** One line shown while the panel is closed. */
  summary?: string
  /** A reason to look inside, shown whether the panel is open or not. */
  flag?: string
  /** Where a panel nobody has touched starts. */
  defaultOpen?: boolean
}>(), { defaultOpen: true })

const { t } = useI18n()
const state = usePanelState(props.screen)
const open = ref(state.isOpen(props.panelId, props.defaultOpen))

// A row's panel id can change when its row is saved (a new group gets its id): read what is kept for it.
watch(() => props.panelId, (id) => { open.value = state.isOpen(id, props.defaultOpen) })

const bodyId = computed(() => `panel-${props.screen}-${props.panelId}`.replace(/[^a-zA-Z0-9_-]/g, '-'))
const toggleLabel = computed(() => t(open.value ? 'common.collapse' : 'common.expand'))

function setOpen(value: boolean) {
  open.value = value
  state.setOpen(props.panelId, value)
}
function toggle() {
  setOpen(!open.value)
}

defineExpose({ open, setOpen })
</script>
