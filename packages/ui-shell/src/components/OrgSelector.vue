<template>
  <v-list-item
    :title="org?.name || 'Ledger'"
    nav
    class="org-selector"
    :class="{ 'org-selector--rail': rail }"
    @click="rail && $emit('toggle-rail')"
  >
    <template #prepend>
      <v-icon color="primary">{{ rail ? 'mdi-chevron-right' : 'mdi-book-multiple' }}</v-icon>
    </template>
    <template #subtitle>
      <span class="org-selector__sub">
        <span class="org-selector__slug">{{ org?.slug }}</span>
        <EnvBadge :environment="org?.environment" />
      </span>
    </template>
    <template #append>
      <v-btn
        :icon="rail ? 'mdi-chevron-right' : 'mdi-chevron-left'"
        variant="text"
        size="small"
        style="min-width: 44px; min-height: 44px"
        @click.stop="$emit('toggle-rail')"
      />
    </template>
  </v-list-item>
</template>

<script setup lang="ts">
import EnvBadge from './EnvBadge.vue'
import type { ShellOrg } from './types'

defineProps<{
  org: ShellOrg | null
  rail?: boolean
}>()

defineEmits<{
  'toggle-rail': []
}>()
</script>

<style scoped>
/*
 * The collapsed rail gives this row no width for its text, and a subtitle made of an inline element and a
 * badge, which Vuetify's one-line clamp does not reach, wrapped a letter per line: the rail's header grew to
 * 186 px beside a 53 px app bar. So the subtitle never wraps, and the collapsed row is held to the height of
 * the expanded one (two lines, 52 px), the app bar's, whatever the text does.
 */
.org-selector--rail {
  max-height: 52px;
  overflow: hidden;
}
.org-selector__sub {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  white-space: nowrap;
}
.org-selector__slug {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
