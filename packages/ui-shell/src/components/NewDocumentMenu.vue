<template>
  <!-- FR-22.49: „+ Нов" — every daily document one move away, from any app. Opens on hover on a
       desktop (FR-05), like the menus beside it; a click opens it everywhere. -->
  <v-menu
    v-if="groups.length"
    location="bottom start"
    :close-on-content-click="true"
    :open-on-hover="hoverEnabled"
    :open-on-click="true"
    :open-delay="openDelay"
    :close-delay="closeDelay"
  >
    <template #activator="{ props: menuProps }">
      <v-btn
        v-bind="menuProps"
        :icon="mobile"
        color="primary"
        :variant="mobile ? 'text' : 'tonal'"
        :size="mobile ? undefined : 'small'"
        class="text-none mr-2"
        data-testid="new-document-menu"
        :title="$t('nav.quickCreateHint')"
        :aria-label="mobile ? $t('nav.quickCreate') : undefined"
      >
        <v-icon :start="!mobile">mdi-plus</v-icon>
        <template v-if="!mobile">
          {{ $t('nav.quickCreate') }}
          <v-icon end size="small">mdi-chevron-down</v-icon>
        </template>
      </v-btn>
    </template>

    <v-list density="compact" nav min-width="240" data-testid="new-document-list">
      <template v-for="(group, gi) in groups" :key="gi">
        <v-divider v-if="gi > 0" class="my-1" />
        <!-- A real link: a middle or Ctrl click opens the form in a new tab. -->
        <v-list-item
          v-for="item in group"
          :key="item.page.id"
          :href="hrefOf(item.page)"
          :prepend-icon="item.page.icon"
          :title="$t(item.labelKey)"
          @click="open($event, item.page)"
        />
      </template>
    </v-list>
  </v-menu>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useHoverMenus } from 'ui-shared/composables/useHoverMenus'
import { sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import { newDocumentMenu, type PageDef } from 'ui-shared/nav/page-registry'
import { appHref } from 'ui-shared/nav/navigate'
import { openPage } from 'ui-shared/nav/open-page'

defineProps<{ mobile?: boolean }>()

const router = useRouter()
const { hoverEnabled, openDelay, closeDelay } = useHoverMenus()

// The session cannot change under a mounted page (a switch or a sign-in reloads it), so the
// entries are worked out once. Nothing to offer, no button: a read-only role sees none.
const groups = newDocumentMenu(sessionViewer())

function hrefOf(page: PageDef): string {
  return appHref(page.appId, page.path)
}

function open(e: MouseEvent, page: PageDef) {
  // Leave a new-tab click (Ctrl, ⌘, Shift, middle button) to the browser and the link.
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return
  e.preventDefault()
  openPage(page, router)
}
</script>
