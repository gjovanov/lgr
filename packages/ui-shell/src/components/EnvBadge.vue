<template>
  <span
    v-if="kind"
    class="env-badge"
    :class="`env-badge--${kind}`"
    :title="tip"
    role="img"
    :aria-label="tip"
    :data-testid="`env-badge-${kind}`"
  >{{ label }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * The PROD / DEV marker an org carries (`Org.settings.environment`), shown beside its name in the
 * org menu, the sidebar header and the org picker, so nobody keys real work into a test copy of
 * the company, or experiments in the real one. An org with no marker shows nothing.
 *
 * Colours come from the theme's own tokens so it reads in both the light and the dark theme:
 * PROD is the theme's error red, darkened until white text on it passes AA (the stock #f34f4f
 * does not at this size), DEV is a neutral gray built from the theme's ink.
 */
const props = defineProps<{ environment?: string | null }>()
const { t } = useI18n()

const kind = computed<'prod' | 'dev' | null>(() =>
  props.environment === 'prod' || props.environment === 'dev' ? props.environment : null,
)
const label = computed(() => (kind.value === 'prod' ? 'PROD' : 'DEV'))
const tip = computed(() => (kind.value ? t(`orgSwitcher.env.${kind.value}`) : ''))
</script>

<style scoped>
.env-badge {
  display: inline-flex;
  align-items: center;
  flex: none;
  height: 18px;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  line-height: 1;
  white-space: nowrap;
  vertical-align: middle;
  user-select: none;
}
.env-badge--prod {
  /* The fallback first: an engine without color-mix() keeps a red that passes contrast. */
  background: #c23f3f;
  background: color-mix(in srgb, rgb(var(--v-theme-error)) 80%, #000);
  color: #fff;
}
.env-badge--dev {
  background: rgba(var(--v-theme-on-surface), 0.12);
  color: rgb(var(--v-theme-on-surface));
  box-shadow: inset 0 0 0 1px rgba(var(--v-theme-on-surface), 0.32);
}
</style>
