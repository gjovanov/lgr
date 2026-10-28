<template>
  <!-- FR-22.51: the pages pinned with ★, as tiles on the App Hub and the dashboard. -->
  <section v-if="pages.length" class="favorite-tiles" data-testid="favorite-tiles">
    <h2 class="text-subtitle-1 font-weight-bold d-flex align-center mb-2">
      <v-icon size="small" color="amber-darken-2" class="mr-1">mdi-star</v-icon>
      {{ $t('nav.favorites') }}
    </h2>
    <div class="d-flex flex-wrap ga-3">
      <v-card
        v-for="p in pages"
        :key="p.id"
        :href="hrefOf(p)"
        class="favorite-tile"
        variant="outlined"
        rounded="lg"
        data-testid="favorite-tile"
        @click="open($event, p)"
      >
        <div class="d-flex align-center pa-3">
          <v-avatar :color="appColor(p.appId)" size="36" class="mr-3 flex-shrink-0">
            <v-icon color="white" size="20">{{ p.icon }}</v-icon>
          </v-avatar>
          <div class="favorite-tile__text">
            <div class="text-body-2 font-weight-medium text-truncate">{{ $t(p.labelKey) }}</div>
            <div class="text-caption text-medium-emphasis text-truncate">{{ appName(p.appId) }}</div>
          </div>
        </div>
      </v-card>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { usePageFavorites } from 'ui-shared/composables/usePageFavorites'
import { sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import { APP_NAV_META, PAGE_REGISTRY, canOpenPage, type PageDef } from 'ui-shared/nav/page-registry'
import { appHref } from 'ui-shared/nav/navigate'
import { openPage } from 'ui-shared/nav/open-page'

const { t } = useI18n()
const router = useRouter()
const { groupItems } = usePageFavorites()

const viewer = sessionViewer()
const pages = computed(() => groupItems(PAGE_REGISTRY.filter((p) => canOpenPage(p, viewer))).favorites)

function appName(appId: string): string {
  const key = APP_NAV_META[appId]?.nameKey
  return key ? t(key) : appId
}

function appColor(appId: string): string {
  return APP_NAV_META[appId]?.color ?? 'primary'
}

function hrefOf(p: PageDef): string {
  return appHref(p.appId, p.path)
}

function open(e: MouseEvent, p: PageDef) {
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return
  e.preventDefault()
  openPage(p, router)
}
</script>

<style scoped>
.favorite-tile {
  width: 240px;
  max-width: 100%;
}
.favorite-tile__text {
  min-width: 0;
}
</style>
