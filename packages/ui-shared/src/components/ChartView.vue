<template>
  <div class="chart-view" :style="{ height: `${height}px` }">
    <component
      v-if="chartComponent"
      :is="chartComponent"
      :data="data"
      :options="mergedOptions"
    />
    <div v-else class="d-flex align-center justify-center h-100">
      <v-progress-circular indeterminate size="32" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, shallowRef, watchEffect } from 'vue'
import { useTheme } from 'vuetify'
import type { Component } from 'vue'

const props = defineProps<{
  type: 'bar' | 'line' | 'pie' | 'doughnut'
  data: any
  options?: any
  height?: number
}>()

const theme = useTheme()
const chartComponent = shallowRef<Component | null>(null)

// Lazy-load chart.js and vue-chartjs
watchEffect(async () => {
  try {
    const [vueChartjs, chartjs] = await Promise.all([
      import('vue-chartjs'),
      import('chart.js'),
    ])

    // Register all chart.js components
    chartjs.Chart.register(
      ...chartjs.registerables || [
        chartjs.CategoryScale,
        chartjs.LinearScale,
        chartjs.BarElement,
        chartjs.LineElement,
        chartjs.PointElement,
        chartjs.ArcElement,
        chartjs.Title,
        chartjs.Tooltip,
        chartjs.Legend,
        chartjs.Filler,
      ]
    )

    const componentMap: Record<string, Component> = {
      bar: vueChartjs.Bar,
      line: vueChartjs.Line,
      pie: vueChartjs.Pie,
      doughnut: vueChartjs.Doughnut,
    }

    chartComponent.value = componentMap[props.type] || vueChartjs.Bar
  } catch (err) {
    console.warn('Failed to load chart.js:', err)
  }
})

const mergedOptions = computed(() => {
  const isDark = theme.current.value.dark
  const textColor = isDark ? '#e0e0e0' : '#333333'
  const gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'

  const defaults: any = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: { color: textColor },
      },
    },
  }

  // Scale options for bar/line only
  if (props.type === 'bar' || props.type === 'line') {
    defaults.scales = {
      x: {
        ticks: { color: textColor },
        grid: { color: gridColor },
      },
      y: {
        ticks: { color: textColor },
        grid: { color: gridColor },
      },
    }
  }

  return deepMerge(defaults, props.options || {})
})

function deepMerge(target: any, source: any): any {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key])
    } else {
      result[key] = source[key]
    }
  }
  return result
}
</script>

<style scoped>
.chart-view {
  position: relative;
  width: 100%;
  min-height: 200px;
}
</style>
