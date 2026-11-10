<template>
  <!-- FR-28.38: the tree of an order's lines, warehouses and client reservations, one table with one set
       of columns. The node model (`composables/order-tree`) says what each row is and what a parent adds
       up to; this draws it and holds what is open. What a row SAYS is the screen's: its `item` cell (the
       article, the warehouse, the client) and its other `cells` come through two slots, so the supplier
       order, the customer order and the reservation page draw their own rows in the same table.

       Open and closed is kept here, not in a table library: it has to open by itself where something needs
       a look, open and close one supplier at a time, survive the reload a save causes, and open the way to
       a row a link points at (see `tree-rows.ts`). -->
  <v-table
    ref="tableRef"
    density="compact"
    class="order-tree"
    :style="{ '--tree-min-width': `${minWidth}px` }"
    data-testid="order-tree"
    @keydown="onKeydown"
  >
    <colgroup>
      <col v-for="c in shown" :key="c.key" :style="c.width ? { width: c.width } : undefined" />
    </colgroup>
    <thead>
      <tr>
        <th
          v-for="c in shown"
          :key="c.key"
          :data-col="c.key"
          :title="c.hint"
          :class="[c.align === 'end' ? 'text-end' : c.align === 'center' ? 'text-center' : undefined, { 'order-tree__hinted': !!c.hint }]"
        >{{ c.title }}</th>
      </tr>
    </thead>
    <tbody>
      <tr
        v-for="row in rows"
        :key="row.node.id"
        class="order-tree__row"
        :class="rowClasses(row.node)"
        data-testid="tree-row"
        :data-node-id="row.node.id"
        :data-kind="row.node.kind"
        :data-root-id="rootOf.get(row.node.id)"
        :data-depth="row.node.depth"
      >
        <td class="order-tree__item" data-col="item">
          <div class="d-flex align-center" :style="{ paddingInlineStart: `${row.node.depth * 20}px` }">
            <v-btn
              v-if="row.expandable"
              icon
              size="x-small"
              variant="text"
              class="order-tree__toggle flex-shrink-0"
              :aria-expanded="row.open ? 'true' : 'false'"
              :aria-label="toggleLabel(row.node, row.open)"
              :title="toggleLabel(row.node, row.open)"
              :data-tree-toggle="row.node.id"
              data-testid="tree-toggle"
              @click="toggle(row.node)"
            >
              <v-icon>{{ row.open ? 'mdi-chevron-down' : 'mdi-chevron-right' }}</v-icon>
            </v-btn>
            <span v-else class="order-tree__spacer flex-shrink-0" />
            <slot name="item" :node="row.node" :open="row.open" :expandable="row.expandable" />
          </div>
        </td>
        <slot name="cells" :node="row.node" :open="row.open" :expandable="row.expandable" :hidden="hidden" :span="shown.length" />
      </tr>
      <!-- A supplier's totals: what its lines add up to, in the same columns. -->
      <tr v-if="$slots.totals" class="order-tree__totals" data-testid="tree-totals">
        <slot name="totals" :hidden="hidden" :span="shown.length" />
      </tr>
    </tbody>
  </v-table>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { columnsWidth, fitColumns } from '../../composables/order-tree/columns'
import type { TreeColumn, TreeNode } from '../../composables/order-tree/types'
import {
  collapseAll as collapseAllRows,
  expandAll as expandAllRows,
  isNodeOpen,
  needsAttention,
  revealed,
  setOpen as setOpenRow,
  toggled,
  visibleRows,
  type OpenState,
} from '../../composables/order-tree/tree-rows'

const props = defineProps<{
  nodes: TreeNode[]
  columns: TreeColumn[]
  /** A screen's own classes for a row (a cancelled reservation, a draft). */
  rowClass?: (node: TreeNode) => string | string[] | Record<string, boolean> | undefined
}>()

const { t } = useI18n()

/** The user's changes to what is open; a node without one is open when its data says so. */
const state = ref<OpenState>({})
const rows = computed(() => visibleRows(props.nodes, state.value))

/** Every node by id, and the root each belongs to (a row says which line it is under, for tests and for links). */
const lookup = computed(() => {
  const nodes = new Map<string, TreeNode>()
  const roots = new Map<string, string>()
  const walk = (list: readonly TreeNode[], root: string | null) => {
    for (const n of list) {
      const r = root ?? n.id
      nodes.set(n.id, n)
      roots.set(n.id, r)
      walk(n.children, r)
    }
  }
  walk(props.nodes, null)
  return { nodes, roots }
})
const rootOf = computed(() => lookup.value.roots)

// ── room: how wide the table can be. A column that its screen can say another way gives way before the table
// would scroll sideways (a scroll hides the status and the actions, the columns at the far edge): see `columns.ts`.
const room = ref(0)
const fitted = computed(() => fitColumns(props.columns, room.value))
const shown = computed(() => fitted.value.shown)
const hidden = computed(() => new Set(fitted.value.hidden))
const minWidth = computed(() => columnsWidth(shown.value))

let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  const el = tableRef.value?.$el as HTMLElement | undefined
  if (!el) return
  room.value = el.clientWidth
  if (typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(() => { room.value = el.clientWidth })
  resizeObserver.observe(el)
})

const highlighted = ref('')
let highlightTimer: ReturnType<typeof setTimeout> | null = null

function rowClasses(node: TreeNode) {
  const own = props.rowClass?.(node)
  return [
    `order-tree__row--${node.kind}`,
    {
      'order-tree__row--flagged': needsAttention(node.flags),
      'order-tree__row--editing': !!node.editing,
      'order-tree__row--hit': highlighted.value === node.id,
    },
    own,
  ]
}

function toggleLabel(node: TreeNode, open: boolean): string {
  return `${t(open ? 'common.collapse' : 'common.expand')} ${node.label}`.trim()
}

// ── state ──
function toggle(node: TreeNode) {
  state.value = toggled(state.value, node)
}
function setOpen(id: string, open: boolean) {
  state.value = setOpenRow(state.value, id, open)
}
function isOpen(id: string): boolean {
  const n = lookup.value.nodes.get(id)
  return n ? isNodeOpen(n, state.value) : false
}
function expandAll() {
  state.value = expandAllRows(state.value, props.nodes)
}
function collapseAll() {
  state.value = collapseAllRows(state.value, props.nodes)
}

/** Open the way to a row, scroll it into view and mark it for a moment (a link that names it). */
async function reveal(id: string, opts: { openSelf?: boolean; highlight?: boolean } = {}) {
  if (!lookup.value.nodes.has(id)) return
  state.value = revealed(state.value, lookup.value.nodes, id, !!opts.openSelf)
  await nextTick()
  const el = tableRef.value?.$el?.querySelector?.(`tr[data-node-id="${CSS.escape(id)}"]`) as HTMLElement | null
  el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  if (opts.highlight) mark(id)
}
function mark(id: string) {
  highlighted.value = id
  if (highlightTimer) clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => { highlighted.value = '' }, 2400)
}
onBeforeUnmount(() => {
  if (highlightTimer) clearTimeout(highlightTimer)
  resizeObserver?.disconnect()
})

// ── keyboard: arrows move between the rows that have a toggle, right opens and left closes ──
const tableRef = ref<any>(null)

function focusToggle(id: string | undefined) {
  if (!id) return
  nextTick(() => {
    const el = tableRef.value?.$el?.querySelector?.(`[data-tree-toggle="${CSS.escape(id)}"]`) as HTMLElement | null
    el?.focus()
  })
}
function nextWithToggle(from: number, dir: 1 | -1): string | undefined {
  for (let i = from + dir; i >= 0 && i < rows.value.length; i += dir) if (rows.value[i].expandable) return rows.value[i].node.id
  return undefined
}
function onKeydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null
  const id = target?.getAttribute?.('data-tree-toggle')
  if (!id) return
  const i = rows.value.findIndex((r) => r.node.id === id)
  if (i < 0) return
  const row = rows.value[i]
  switch (e.key) {
    case 'ArrowDown':
      focusToggle(nextWithToggle(i, 1))
      break
    case 'ArrowUp':
      focusToggle(nextWithToggle(i, -1))
      break
    case 'ArrowRight':
      if (!row.open) setOpen(id, true)
      else focusToggle(row.node.children.find((c) => c.children.length > 0)?.id)
      break
    case 'ArrowLeft':
      if (row.open) setOpen(id, false)
      else focusToggle(row.node.parentId)
      break
    default:
      return
  }
  e.preventDefault()
}

defineExpose({ toggle, setOpen, isOpen, expandAll, collapseAll, reveal, highlight: mark })
</script>

<style scoped>
.order-tree :deep(table) {
  table-layout: fixed;
  width: 100%;
  min-width: var(--tree-min-width, 0);
}
/* Cells keep half the padding Vuetify gives a table: eleven columns of figures need the room. A header too long for
   its column (Резервирано, Фактурирано, Empfangen) goes onto a second line, hyphenated where the browser can,
   instead of running into its neighbour. */
.order-tree {
  --tree-cell-pad: 8px;
}
.order-tree :deep(.v-table__wrapper > table > thead > tr > th),
.order-tree :deep(.v-table__wrapper > table > tbody > tr > td) {
  padding-inline: var(--tree-cell-pad);
}
.order-tree :deep(th) {
  white-space: normal;
  overflow-wrap: anywhere;
  hyphens: auto;
  line-height: 1.15;
  font-size: 0.75rem;
}
.order-tree :deep(td) {
  vertical-align: middle;
}
/* A header that explains itself when the pointer rests on it says so. */
.order-tree :deep(th.order-tree__hinted) {
  cursor: help;
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}
/* Levels read apart without a border each: the line is the strongest, a client the plainest. */
/* The cells of a row come from the screen's slots, which carry the screen's scope, not this component's. */
.order-tree :deep(.order-tree__row--line > td) {
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.order-tree :deep(.order-tree__row--allocation > td) {
  background: rgba(var(--v-theme-on-surface), 0.02);
}
.order-tree :deep(.order-tree__row--flagged > td) {
  background: rgba(var(--v-theme-warning), 0.08);
}
.order-tree :deep(.order-tree__row--editing > td) {
  background: rgba(var(--v-theme-primary), 0.06);
}
.order-tree :deep(.order-tree__row--hit > td) {
  animation: order-tree-hit 2.4s ease-out;
}
@keyframes order-tree-hit {
  0%,
  55% {
    background: rgba(var(--v-theme-warning), 0.4);
  }
}
/* A number typed into the tree is read whole: 99,999 in a quantity, 9,999.99 in a price (a column cannot be widened for
   it, the table has 9 px to spare at 1341 px with the right panel open). Three things took its room, all gone:
   - the spin buttons, which a number input keeps 15 px for even while they are not drawn (100 read 10);
   - the field's own padding, 8 px a side: the cell has its own, and an underlined field shows no edge to pad;
   - the cell's padding on the field's start side, which an end-aligned figure leaves empty. The figure itself stays
     where the column's other figures are, flush with its header. */
.order-tree :deep(.order-tree__num) {
  margin-inline-start: calc(-1 * var(--tree-cell-pad));
}
.order-tree :deep(.order-tree__num input) {
  text-align: end;
  padding-inline: 0;
  -moz-appearance: textfield;
  appearance: textfield;
}
.order-tree :deep(.order-tree__num input::-webkit-inner-spin-button),
.order-tree :deep(.order-tree__num input::-webkit-outer-spin-button) {
  -webkit-appearance: none;
  margin: 0;
}
/* A figure is never split over two lines (a Free of 99,999 read 9999 over 9): it keeps its line, and one wider than its
   column spends the padding of its cell instead. */
.order-tree :deep(td.text-end) {
  white-space: nowrap;
}
.order-tree__spacer {
  display: inline-block;
  width: 28px;
}
.order-tree :deep(.order-tree__totals > td) {
  font-weight: 600;
  border-top: 2px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
</style>
