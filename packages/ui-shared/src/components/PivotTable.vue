<template>
  <div class="pivot-table">
    <v-table density="compact" class="text-body-2">
      <thead>
        <tr>
          <!-- Row header columns -->
          <th v-for="row in rows" :key="row" class="text-left font-weight-bold">
            {{ formatHeader(row) }}
          </th>
          <!-- Measure columns per unique column value -->
          <template v-if="columnValues.length">
            <template v-for="colVal in columnValues" :key="colVal">
              <th
                v-for="m in measures"
                :key="`${colVal}-${m.field}`"
                class="text-right font-weight-bold"
              >
                {{ colVal }} — {{ m.label || formatHeader(m.field) }}
              </th>
            </template>
          </template>
          <template v-else>
            <th
              v-for="m in measures"
              :key="m.field"
              class="text-right font-weight-bold"
            >
              {{ m.label || formatHeader(m.field) }}
            </th>
          </template>
        </tr>
      </thead>
      <tbody>
        <template v-for="(group, idx) in groupedData" :key="idx">
          <tr
            :class="{ 'group-row': expandable && group.children?.length, 'cursor-pointer': expandable && group.children?.length }"
            @click="expandable && group.children?.length && toggleExpand(idx)"
          >
            <td v-for="row in rows" :key="row" class="font-weight-medium">
              <v-icon v-if="row === rows[0] && expandable && group.children?.length" size="small" class="mr-1">
                {{ expanded.has(idx) ? 'mdi-chevron-down' : 'mdi-chevron-right' }}
              </v-icon>
              {{ group.key[row] ?? '' }}
            </td>
            <template v-if="columnValues.length">
              <template v-for="colVal in columnValues" :key="colVal">
                <td v-for="m in measures" :key="`${colVal}-${m.field}`" class="text-right">
                  {{ formatNumber(group.values[colVal]?.[m.field]) }}
                </td>
              </template>
            </template>
            <template v-else>
              <td v-for="m in measures" :key="m.field" class="text-right">
                {{ formatNumber(group.values['_total']?.[m.field]) }}
              </td>
            </template>
          </tr>
          <!-- Expanded children -->
          <template v-if="expandable && expanded.has(idx) && group.children">
            <tr v-for="(child, cidx) in group.children" :key="`${idx}-${cidx}`" class="child-row">
              <td v-for="(row, ridx) in rows" :key="row" :class="{ 'pl-8': ridx === 0 }">
                {{ child.key[row] ?? '' }}
              </td>
              <template v-if="columnValues.length">
                <template v-for="colVal in columnValues" :key="colVal">
                  <td v-for="m in measures" :key="`${colVal}-${m.field}`" class="text-right">
                    {{ formatNumber(child.values[colVal]?.[m.field]) }}
                  </td>
                </template>
              </template>
              <template v-else>
                <td v-for="m in measures" :key="m.field" class="text-right">
                  {{ formatNumber(child.values['_total']?.[m.field]) }}
                </td>
              </template>
            </tr>
          </template>
        </template>
        <!-- Totals row -->
        <tr class="totals-row font-weight-bold">
          <td :colspan="rows.length">Total</td>
          <template v-if="columnValues.length">
            <template v-for="colVal in columnValues" :key="colVal">
              <td v-for="m in measures" :key="`${colVal}-${m.field}`" class="text-right">
                {{ formatNumber(totals[colVal]?.[m.field]) }}
              </td>
            </template>
          </template>
          <template v-else>
            <td v-for="m in measures" :key="m.field" class="text-right">
              {{ formatNumber(totals['_total']?.[m.field]) }}
            </td>
          </template>
        </tr>
      </tbody>
    </v-table>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

export interface PivotMeasure {
  field: string
  aggregate: 'sum' | 'count' | 'avg'
  label?: string
}

interface PivotGroup {
  key: Record<string, any>
  values: Record<string, Record<string, number>>
  children?: PivotGroup[]
}

const props = defineProps<{
  data: Record<string, any>[]
  rows: string[]
  columns?: string[]
  measures: PivotMeasure[]
  expandable?: boolean
}>()

const expanded = ref(new Set<number>())

function toggleExpand(idx: number) {
  if (expanded.value.has(idx)) {
    expanded.value.delete(idx)
  } else {
    expanded.value.add(idx)
  }
}

// Unique column values (for cross-tab columns)
const columnValues = computed<string[]>(() => {
  if (!props.columns?.length) return []
  const vals = new Set<string>()
  for (const row of props.data) {
    for (const col of props.columns) {
      if (row[col] != null) vals.add(String(row[col]))
    }
  }
  return Array.from(vals).sort()
})

// Group data by row fields and compute measures
const groupedData = computed<PivotGroup[]>(() => {
  const groups = new Map<string, { key: Record<string, any>; items: Record<string, any>[] }>()

  for (const row of props.data) {
    const groupKey = props.rows.map(r => row[r] ?? '').join('|||')
    if (!groups.has(groupKey)) {
      const key: Record<string, any> = {}
      for (const r of props.rows) key[r] = row[r]
      groups.set(groupKey, { key, items: [] })
    }
    groups.get(groupKey)!.items.push(row)
  }

  return Array.from(groups.values()).map(g => ({
    key: g.key,
    values: computeMeasures(g.items),
  }))
})

// Compute totals across all data
const totals = computed<Record<string, Record<string, number>>>(() => {
  return computeMeasures(props.data)
})

function computeMeasures(items: Record<string, any>[]): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {}

  if (columnValues.value.length) {
    for (const colVal of columnValues.value) {
      result[colVal] = {}
      const colField = props.columns![0]
      const colItems = items.filter(i => String(i[colField]) === colVal)
      for (const m of props.measures) {
        result[colVal][m.field] = aggregate(colItems, m)
      }
    }
  } else {
    result['_total'] = {}
    for (const m of props.measures) {
      result['_total'][m.field] = aggregate(items, m)
    }
  }

  return result
}

function aggregate(items: Record<string, any>[], measure: PivotMeasure): number {
  if (!items.length) return 0
  switch (measure.aggregate) {
    case 'sum':
      return items.reduce((acc, i) => acc + (Number(i[measure.field]) || 0), 0)
    case 'count':
      return items.length
    case 'avg': {
      const sum = items.reduce((acc, i) => acc + (Number(i[measure.field]) || 0), 0)
      return sum / items.length
    }
  }
}

function formatHeader(field: string): string {
  return field.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim()
}

function formatNumber(val: number | undefined): string {
  if (val == null) return '—'
  return Number.isInteger(val) ? val.toLocaleString() : val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
</script>

<style scoped>
.group-row {
  background: rgba(var(--v-theme-surface-variant), 0.04);
}

.child-row {
  background: rgba(var(--v-theme-surface-variant), 0.02);
}

.totals-row {
  border-top: 2px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgba(var(--v-theme-surface-variant), 0.06);
}

.cursor-pointer {
  cursor: pointer;
}
</style>
