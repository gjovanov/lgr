<template>
  <v-container class="py-12" data-testid="not-available">
    <EmptyState
      icon="mdi-lock-outline"
      :title="t('access.notAvailable.title')"
      :description="label ? t('access.notAvailable.text', { page: label }) : t('access.notAvailable.textAny')"
    >
      <template #actions>
        <v-btn color="primary" variant="flat" data-testid="not-available-home" @click="goTo(home)">
          {{ t('access.notAvailable.home') }}
        </v-btn>
      </template>
    </EmptyState>
  </v-container>
</template>

<script setup lang="ts">
/**
 * FR-27.7 (#529): what a page the session's role does not open shows instead of its view (`usePageAccess`). It
 * names the page and offers the session's start page (`startPage`: its role's landing, else the Dashboard), so a
 * bookmark or a shared link never lands on a form whose every request is refused.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import EmptyState from 'ui-shared/components/EmptyState.vue'
import { goTo } from 'ui-shared/nav/navigate'
import { startPage, type PageDef } from 'ui-shared/nav/page-registry'
import { sessionViewer } from 'ui-shared/composables/useStorageIdentity'

const props = defineProps<{ page: PageDef | null }>()
const { t } = useI18n()
const label = computed(() => (props.page?.labelKey ? t(props.page.labelKey) : ''))
const home = computed(() => startPage(sessionViewer()))
</script>
