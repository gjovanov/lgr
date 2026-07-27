<template>
  <v-menu :close-on-content-click="false" location="bottom end" min-width="300" max-width="360">
    <template #activator="{ props }">
      <v-btn v-bind="props" icon variant="text" :title="$t('nav.favorites')">
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
import { useRoute } from 'vue-router'
import { usePageFavorites } from 'ui-shared/composables/usePageFavorites'
import { PAGE_REGISTRY, APP_NAV_META, matchPage, type PageDef } from 'ui-shared/nav/page-registry'
import { navigateToPage } from 'ui-shared/nav/navigate'

const { t } = useI18n()
const route = useRoute()
const { isFavorite, toggleFavorite, groupItems } = usePageFavorites()

// The router path is app-relative; window.location.pathname is the full app-prefixed path
// that the registry is keyed on. Re-read it whenever the route changes.
const currentPath = ref(typeof window !== 'undefined' ? window.location.pathname : '')
watch(() => route.fullPath, () => { currentPath.value = window.location.pathname })

const currentPage = computed(() => matchPage(currentPath.value))
const currentIsFav = computed(() => !!currentPage.value && isFavorite(currentPage.value.id))

const sections = computed(() => {
  const g = groupItems(PAGE_REGISTRY)
  const out: { key: string; labelKey: string; pages: PageDef[] }[] = []
  if (g.favorites.length) out.push({ key: 'fav', labelKey: 'nav.favorites', pages: g.favorites })
  if (g.frequent.length) out.push({ key: 'freq', labelKey: 'nav.frequent', pages: g.frequent })
  return out
})

function appName(appId: string): string {
  const key = APP_NAV_META[appId]?.nameKey
  return key ? t(key) : appId
}

function go(p: PageDef) {
  navigateToPage(p)
}
</script>
