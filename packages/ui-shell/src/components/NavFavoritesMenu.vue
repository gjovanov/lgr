<template>
  <!-- FR-22.51: opens on hover on a desktop (FR-05), like the menus beside it. -->
  <v-menu
    v-model="open"
    :close-on-content-click="false"
    location="bottom end"
    min-width="300"
    max-width="360"
    :open-on-hover="hoverEnabled"
    :open-on-click="true"
    :open-delay="openDelay"
    :close-delay="closeDelay"
  >
    <template #activator="{ props }">
      <v-btn v-bind="props" icon variant="text" :title="$t('nav.favorites')" data-testid="favorites-menu">
        <v-icon>{{ currentIsFav ? 'mdi-star' : 'mdi-star-outline' }}</v-icon>
      </v-btn>
    </template>
    <v-card>
      <!-- Pin / unpin the page you're currently on -->
      <template v-if="currentPage">
        <v-list density="compact">
          <v-list-item
            :prepend-icon="currentIsFav ? 'mdi-star' : 'mdi-star-outline'"
            :title="currentIsFav ? $t('nav.unpinPage') : $t('nav.pinPage')"
            :subtitle="$t(currentPage.labelKey)"
            data-testid="favorites-pin-current"
            @click="toggleFavorite(currentPage.id)"
          />
        </v-list>
        <v-divider />
      </template>

      <div v-if="!sections.length" class="px-4 py-3 text-caption text-medium-emphasis text-center">
        {{ $t('nav.noFavorites') }}
      </div>

      <template v-for="section in sections" :key="section.key">
        <div class="text-overline text-medium-emphasis px-4 pt-2">{{ $t(section.labelKey) }}</div>
        <v-list density="compact" nav>
          <v-list-item
            v-for="p in section.pages"
            :key="p.id"
            :prepend-icon="p.icon"
            :title="$t(p.labelKey)"
            :subtitle="appName(p.appId)"
            @click="go(p)"
          >
            <template #append>
              <v-btn
                :icon="isFavorite(p.id) ? 'mdi-star' : 'mdi-star-outline'"
                :color="isFavorite(p.id) ? 'amber-darken-2' : 'grey'"
                size="x-small"
                variant="text"
                @click.stop="toggleFavorite(p.id)"
              />
            </template>
          </v-list-item>
        </v-list>
      </template>
    </v-card>
  </v-menu>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { usePageFavorites } from 'ui-shared/composables/usePageFavorites'
import { useHoverMenus } from 'ui-shared/composables/useHoverMenus'
import { sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import { PAGE_REGISTRY, APP_NAV_META, canOpenPage, matchPage, type PageDef } from 'ui-shared/nav/page-registry'
import { openPage } from 'ui-shared/nav/open-page'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const { isFavorite, toggleFavorite, groupItems } = usePageFavorites()
const { hoverEnabled, openDelay, closeDelay } = useHoverMenus()
const open = ref(false)

// The router path is app-relative; window.location is the full app-prefixed one that the
// registry is keyed on. Re-read it whenever the route changes. The query counts too: the
// invoice form opened as a credit note is a page of its own (FR-22.51).
const here = () => (typeof window !== 'undefined' ? { path: window.location.pathname, search: window.location.search } : { path: '', search: '' })
const currentLocation = ref(here())
watch(() => route.fullPath, () => { currentLocation.value = here() })

const currentPage = computed(() => matchPage(currentLocation.value.path, currentLocation.value.search))
const currentIsFav = computed(() => !!currentPage.value && isFavorite(currentPage.value.id))

// What this person may open (FR-22 §5.8): a pin to a page their role no longer reaches is kept,
// just not offered.
const viewer = sessionViewer()
const openable = PAGE_REGISTRY.filter((p) => canOpenPage(p, viewer))

const sections = computed(() => {
  const g = groupItems(openable)
  const out: { key: string; labelKey: string; pages: PageDef[] }[] = []
  if (g.favorites.length) out.push({ key: 'fav', labelKey: 'nav.favorites', pages: g.favorites })
  if (g.frequent.length) out.push({ key: 'freq', labelKey: 'nav.frequent', pages: g.frequent })
  return out
})

function appName(appId: string): string {
  const key = APP_NAV_META[appId]?.nameKey
  return key ? t(key) : appId
}

// The menu stays open for its own stars, so a move inside this app has to close it.
function go(p: PageDef) {
  open.value = false
  openPage(p, router)
}
</script>
