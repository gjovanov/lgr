<template>
  <v-container>
    <HubPageHeader
      :title="$t('files.documents.title')"
      :subtitle="$t('files.documents.subtitle')"
      :back-label="$t('files.backToHub')"
    >
      <template #actions>
        <v-btn-toggle v-model="viewMode" density="compact" variant="outlined" mandatory @update:model-value="onViewChange">
          <v-btn value="flat" size="small" prepend-icon="mdi-table">{{ $t('files.batch.viewFlat') }}</v-btn>
          <v-btn value="date" size="small" prepend-icon="mdi-calendar-month">{{ $t('files.batch.viewByDate') }}</v-btn>
        </v-btn-toggle>
      </template>
    </HubPageHeader>

    <v-card variant="outlined" class="mb-3">
      <v-card-text class="d-flex flex-wrap ga-3 align-center">
        <v-text-field v-model="search" :label="$t('common.search')" prepend-inner-icon="mdi-magnify" density="compact" variant="outlined" hide-details clearable style="max-width: 220px" @update:model-value="reloadAll" />
        <v-select v-model="docType" :items="typeItems" :label="$t('files.col.type')" density="compact" variant="outlined" hide-details clearable style="max-width: 190px" @update:model-value="reloadAll" />
        <v-select v-model="statusFilter" :items="statusItems" :label="$t('files.col.status')" density="compact" variant="outlined" hide-details clearable style="max-width: 160px" @update:model-value="reloadAll" />
        <v-text-field v-if="viewMode === 'flat'" v-model="docDate" :label="$t('files.col.date')" placeholder="YYYY-MM-DD" density="compact" variant="outlined" hide-details clearable style="max-width: 150px" @update:model-value="reload" />
        <v-spacer />
        <v-btn variant="text" icon="mdi-refresh" @click="reloadAll" />
      </v-card-text>
    </v-card>

    <!-- Batch action bar -->
    <v-slide-y-transition>
      <v-card v-if="selected.size" variant="flat" color="primary" class="mb-3">
        <v-card-text class="d-flex flex-wrap align-center ga-3 py-2">
          <span class="font-weight-medium">{{ $t('files.batch.selected', { n: selected.size }) }}</span>
          <v-btn size="small" color="white" variant="flat" :loading="busy" prepend-icon="mdi-play-circle" @click="processSelected">{{ $t('files.batch.process') }}</v-btn>
          <v-btn size="small" variant="tonal" :loading="busy" prepend-icon="mdi-text-recognition" @click="ocrSelected">{{ $t('files.batch.ocr') }}</v-btn>
          <v-btn size="small" variant="tonal" :loading="busy" prepend-icon="mdi-magnify-scan" @click="analyzeSelected">{{ $t('files.batch.analyze') }}</v-btn>
          <v-btn size="small" variant="tonal" :loading="busy" prepend-icon="mdi-database-check" @click="reviewSelected">{{ $t('files.batch.review') }}</v-btn>
          <v-btn size="small" variant="tonal" :loading="busy" prepend-icon="mdi-sync-alert" @click="reconcileSelected">{{ $t('files.reconcile.action') }}</v-btn>
          <v-btn size="small" variant="tonal" color="red-lighten-4" :loading="busy" prepend-icon="mdi-delete-outline" @click="planDelete">{{ $t('files.batch.delete') }}</v-btn>
          <v-checkbox v-model="options.force" :label="$t('files.batch.force')" density="compact" hide-details color="white" />
          <v-spacer />
          <v-btn size="small" variant="text" @click="clearSelection">{{ $t('files.batch.clear') }}</v-btn>
        </v-card-text>
        <div v-if="busy && jobLabel" class="px-4 pb-2 text-caption">{{ jobLabel }}</div>
        <v-progress-linear v-if="busy" :model-value="progress" color="white" height="4" />
      </v-card>
    </v-slide-y-transition>

    <!-- FLAT view -->
    <v-data-table-server
      v-if="viewMode === 'flat'"
      :headers="headers"
      :items="items"
      :items-length="total"
      :loading="loading"
      :items-per-page="size"
      :page="page + 1"
      density="compact"
      @update:options="onOptions"
    >
      <template #item.select="{ item }">
        <v-checkbox-btn :model-value="selected.has(item.docFileId)" density="compact" @update:model-value="toggle(item.docFileId)" />
      </template>
      <template #item.docType="{ item }"><v-chip size="x-small" label>{{ item.docType }}</v-chip></template>
      <template #item.status="{ item }">
        <v-chip size="x-small" :color="statusColor(item.status)" label>{{ item.status }}</v-chip>
        <!-- Booked, but not from the bytes that are on disk now. Without this a corrected document
             sits among the committed ones looking finished. -->
        <v-chip v-if="item.staleBooking" size="x-small" color="deep-purple" label class="ml-1" prepend-icon="mdi-sync-alert" :title="$t('files.reconcile.staleHint')">{{ $t('files.reconcile.stale') }}</v-chip>
      </template>
      <template #item.version="{ item }">
        <v-btn v-if="item.version > 1" size="x-small" variant="tonal" @click="openVersions(item)">v{{ item.version }} · {{ $t('files.versions') }}</v-btn>
        <span v-else>v1</span>
      </template>
      <template #item.actions="{ item }">
        <v-btn size="x-small" variant="text" icon="mdi-clipboard-text-search-outline" :title="$t('files.batch.review')" @click="reviewOne(item)" />
        <v-btn v-if="canReconcile(item)" size="x-small" variant="text" color="deep-purple" icon="mdi-sync-alert" :title="$t('files.reconcile.action')" @click="reconcileOne(item)" />
        <v-btn size="x-small" variant="text" icon="mdi-download" @click="download(downloadUrl(item))" />
      </template>
    </v-data-table-server>

    <!-- BY-DATE view -->
    <div v-else>
      <v-progress-linear v-if="datesLoading" indeterminate color="primary" class="mb-2" />
      <v-expansion-panels v-model="expanded" multiple variant="accordion">
        <v-expansion-panel v-for="d in dates" :key="d.docDate" :value="d.docDate">
          <v-expansion-panel-title>
            <div class="d-flex align-center ga-3 flex-grow-1">
              <!-- VSelectionControl defaults to `flex: 1 0`, which would grow and push the date to
                   the middle of the header — pin it so the date sits right beside the checkbox. -->
              <v-checkbox-btn class="flex-grow-0" style="flex: 0 0 auto" :model-value="dateAllSelected(d.docDate)" :indeterminate="dateSomeSelected(d.docDate)" density="compact" @click.stop="toggleDate(d.docDate)" />
              <span class="font-weight-medium text-left" style="min-width:6.5rem">{{ d.docDate }}</span>
              <v-chip size="x-small" label>{{ d.total }}</v-chip>
              <v-spacer />
              <v-btn
                size="x-small" variant="tonal" prepend-icon="mdi-clipboard-text-search-outline" class="mr-2"
                :loading="busy" @click.stop="reviewDate(d.docDate)"
              >{{ $t('files.batch.review') }}</v-btn>
              <v-btn
                size="x-small" variant="tonal" color="info" prepend-icon="mdi-file-compare" class="mr-2"
                :loading="busy" @click.stop="diffDate(d.docDate)"
              >{{ $t('files.diff.action') }}</v-btn>
              <v-chip v-if="d.uploaded" size="x-small" color="grey" label>{{ d.uploaded }} {{ $t('files.status.uploaded') }}</v-chip>
              <v-chip v-if="d.analyzed" size="x-small" color="warning" label>{{ d.analyzed }} {{ $t('files.status.analyzed') }}</v-chip>
              <v-chip v-if="d.committed" size="x-small" color="success" label>{{ d.committed }} {{ $t('files.status.committed') }}</v-chip>
            </div>
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <v-progress-linear v-if="!dateDocs[d.docDate]" indeterminate color="primary" />
            <v-table v-else density="compact">
              <thead><tr>
                <th style="width:40px"></th><th>{{ $t('files.col.type') }}</th><th>{{ $t('files.col.number') }}</th>
                <th>{{ $t('files.col.status') }}</th><th>{{ $t('files.col.version') }}</th><th></th>
              </tr></thead>
              <tbody>
                <tr v-for="doc in dateDocs[d.docDate]" :key="doc.docFileId">
                  <td><v-checkbox-btn :model-value="selected.has(doc.docFileId)" density="compact" @update:model-value="toggle(doc.docFileId)" /></td>
                  <td><v-chip size="x-small" label>{{ doc.docType }}</v-chip></td>
                  <td class="text-caption">{{ doc.docNumber }}</td>
                  <td>
                    <v-chip size="x-small" :color="statusColor(doc.status)" label>{{ doc.status }}</v-chip>
                    <v-chip v-if="doc.staleBooking" size="x-small" color="deep-purple" label class="ml-1" prepend-icon="mdi-sync-alert" :title="$t('files.reconcile.staleHint')">{{ $t('files.reconcile.stale') }}</v-chip>
                  </td>
                  <td>v{{ doc.version }}</td>
                  <td class="text-no-wrap">
                    <v-btn size="x-small" variant="text" icon="mdi-clipboard-text-search-outline" :title="$t('files.batch.review')" @click="reviewOne(doc)" />
                    <v-btn v-if="canReconcile(doc)" size="x-small" variant="text" color="deep-purple" icon="mdi-sync-alert" :title="$t('files.reconcile.action')" @click="reconcileOne(doc)" />
                    <v-btn size="x-small" variant="text" icon="mdi-download" @click="download(downloadUrl(doc))" />
                  </td>
                </tr>
              </tbody>
            </v-table>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
      <p v-if="!datesLoading && !dates.length" class="text-body-2 text-grey text-center py-6">{{ $t('files.batch.noDocs') }}</p>
    </div>

    <!-- Review & Commit dialog -->
    <v-dialog v-model="reviewOpen" max-width="1100" scrollable>
      <v-card>
        <v-card-title class="d-flex align-center">
          <span class="text-subtitle-1">
            {{ $t('files.review.title') }}
            <span v-if="reviewScope" class="text-grey"> — {{ reviewScope }}</span>
            <span class="text-caption text-grey"> ({{ analyzeResults.length }})</span>
          </span>
          <v-spacer />
          <div class="d-flex ga-2 flex-wrap">
            <v-chip size="small" color="success" label>{{ $t('files.review.ok') }}: {{ reviewCounts.ok }}</v-chip>
            <v-chip v-if="reviewCounts.pending" size="small" color="grey" label>{{ $t('files.review.notAnalyzed') }}: {{ reviewCounts.pending }}</v-chip>
            <v-chip v-if="reviewCounts.done" size="small" color="success" variant="outlined" label>{{ $t('files.status.committed') }}: {{ reviewCounts.done }}</v-chip>
            <v-chip v-if="reviewCounts.warn" size="small" color="warning" label>{{ $t('files.review.withWarnings') }}: {{ reviewCounts.warn }}</v-chip>
            <v-chip v-if="reviewCounts.dup" size="small" color="orange" label>{{ $t('files.review.duplicate') }}: {{ reviewCounts.dup }}</v-chip>
            <v-chip v-if="reviewCounts.err" size="small" color="error" label>{{ $t('files.review.failed') }}: {{ reviewCounts.err }}</v-chip>
          </div>
        </v-card-title>
        <v-card-text style="max-height:60vh">
          <v-table density="compact">
            <thead><tr>
              <th style="width:40px">
                <v-checkbox-btn :model-value="allReviewSelected" :indeterminate="someReviewSelected" density="compact" @update:model-value="toggleAllReview" />
              </th>
              <th style="width:36px"></th>
              <th>{{ $t('files.col.type') }}</th><th>{{ $t('files.col.number') }}</th><th>{{ $t('files.col.kind') }}</th>
              <th class="text-center">{{ $t('files.col.matched') }}</th><th>{{ $t('files.review.warnings') }}</th>
            </tr></thead>
            <tbody>
              <template v-for="r in analyzeResults" :key="r.docFileId">
              <tr :class="r.error ? 'bg-red-lighten-5' : ''">
                <td>
                  <v-checkbox-btn :model-value="commitSel.has(r.docFileId)" :disabled="!r.committable" density="compact" @update:model-value="toggleCommit(r.docFileId)" />
                </td>
                <td>
                  <v-btn v-if="(r.lines || []).length" :icon="expandedDocs.has(r.docFileId) ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="x-small" variant="text" @click="toggleExpand(r.docFileId)" />
                </td>
                <td><v-chip size="x-small" label>{{ r.docType }}</v-chip></td>
                <td class="text-caption">{{ r.docNumber }}<span v-if="r.reused" class="text-grey"> · {{ $t('files.review.reused') }}</span></td>
                <td class="text-caption">{{ r.docKind }}<span v-if="r.direction" class="text-grey"> / {{ r.direction }}</span></td>
                <td class="text-center">
                  <span v-if="r.analyzed === false" class="text-grey">—</span>
                  <span v-else :class="r.unmatched ? 'text-error font-weight-medium' : 'text-success'">{{ r.matched }}/{{ r.total }}</span>
                </td>
                <td class="text-caption">
                  <div v-if="r.error" class="text-error">{{ r.error }}</div>
                  <v-chip size="x-small" :color="statusColor(r.status)" label class="mr-1 mb-1">{{ r.status }}</v-chip>
                  <v-chip v-if="(r.booked || []).length" size="x-small" color="success" variant="outlined" label class="mr-1 mb-1">{{ (r.booked || []).join(', ') }}</v-chip>
                  <span v-if="r.analyzed === false" class="text-grey">{{ r.hasText ? $t('files.review.notAnalyzedText') : $t('files.review.notAnalyzed') }}</span>
                  <v-chip v-if="r.duplicate" size="x-small" color="orange" label class="mr-1 mb-1">{{ $t('files.review.duplicate') }}</v-chip>
                  <v-chip v-if="r.draftSource === 'parsed'" size="x-small" color="primary" label class="mr-1 mb-1" :title="$t('files.review.parsedHint')">{{ $t('files.review.parsed') }}</v-chip>
                  <div v-for="(w, i) in r.warnings" :key="i" :class="/VERIFY/i.test(w) ? 'text-error font-weight-medium' : 'text-warning'">⚠ {{ w }}</div>
                </td>
              </tr>
              <tr v-if="expandedDocs.has(r.docFileId)">
                <td colspan="6" class="pa-0">
                  <v-table density="compact" class="bg-grey-lighten-5">
                    <thead><tr>
                      <th style="width:44px">#</th>
                      <th>{{ $t('docImport.description') }}</th>
                      <th>{{ $t('docImport.product') }}</th>
                      <th class="text-end">{{ $t('files.col.qty') }}</th>
                      <th class="text-end">{{ $t('files.col.price') }}</th>
                      <th>{{ $t('files.review.warnings') }}</th>
                    </tr></thead>
                    <tbody>
                      <tr v-for="l in r.lines" :key="l.index" :class="l.severity === 'error' ? 'bg-red-lighten-5' : l.severity === 'warning' ? 'bg-amber-lighten-5' : ''">
                        <td class="text-caption">{{ l.index + 1 }}</td>
                        <td class="text-caption">{{ l.sourceText }}</td>
                        <td class="text-caption">
                          <span v-if="l.matched">{{ l.productName }}</span>
                          <v-chip v-else-if="l.willCreate" size="x-small" color="info" label>{{ $t('files.review.willCreate') }}</v-chip>
                          <v-chip v-else size="x-small" color="error" label>{{ $t('docImport.unmatchedN', { n: 1 }) }}</v-chip>
                          <v-chip v-if="l.matchedBy" size="x-small" variant="text" class="ml-1">{{ l.matchedBy }}</v-chip>
                        </td>
                        <td class="text-caption text-end">{{ l.quantity ?? '—' }}</td>
                        <td class="text-caption text-end">{{ l.unitPrice ?? '—' }}</td>
                        <td class="text-caption">
                          <div v-for="(m, i) in l.messages" :key="i" :class="l.severity === 'error' ? 'text-error' : 'text-warning'">{{ m }}</div>
                        </td>
                      </tr>
                    </tbody>
                  </v-table>
                </td>
              </tr>
              </template>
            </tbody>
          </v-table>
        </v-card-text>
        <v-divider />
        <v-card-actions class="flex-wrap ga-2 px-4">
          <v-checkbox v-model="options.adjustStock" :label="$t('files.batch.adjustStock')" density="compact" hide-details />
          <v-checkbox v-model="options.allowDuplicate" :label="$t('files.batch.allowDuplicate')" density="compact" hide-details />
          <v-spacer />
          <!-- A document that has never been analysed has no mapping, so it cannot be committed and
               its checkbox is disabled. Saying so is not enough: without this the only way forward
               was to close the dialog, re-select, Analyze, and open the review again. -->
          <v-btn
            v-if="reviewCounts.pending" color="warning" variant="tonal" :loading="busy"
            prepend-icon="mdi-magnify-scan" @click="analyzePendingInReview"
          >{{ $t('files.review.analyzePending', { n: reviewCounts.pending }) }}</v-btn>
          <v-btn variant="text" @click="reviewOpen = false">{{ $t('common.close') }}</v-btn>
          <v-btn color="primary" :loading="busy" :disabled="!commitSel.size" prepend-icon="mdi-database-check" @click="commitReviewed">
            {{ $t('files.review.commitSelected', { n: commitSel.size }) }}
          </v-btn>
        </v-card-actions>
        <v-progress-linear v-if="busy" :model-value="progress" color="primary" height="4" />
      </v-card>
    </v-dialog>

    <!-- Diff: the snapshot compare for a day, as the report it dumps beside the file -->
    <v-dialog v-model="diffOpen" max-width="1100" scrollable>
      <v-card v-if="diff">
        <v-card-title class="d-flex align-center flex-wrap ga-2">
          <span class="text-subtitle-1">{{ $t('files.diff.title') }} — {{ diff.docDate }}</span>
          <v-spacer />
          <v-chip size="small" label>{{ diff.summary?.matched }} {{ $t('files.diff.matched') }}</v-chip>
          <v-chip v-if="diff.summary?.qtyMismatches" size="small" color="warning" label>{{ $t('files.compare.qty') }}: {{ diff.summary.qtyMismatches }}</v-chip>
          <v-chip v-if="diff.summary?.priceMismatches" size="small" color="info" label>{{ $t('files.compare.price') }}: {{ diff.summary.priceMismatches }}</v-chip>
          <v-chip v-if="diff.summary?.missingFromLgr" size="small" color="error" label>{{ $t('files.compare.missing') }}: {{ diff.summary.missingFromLgr }}</v-chip>
        </v-card-title>
        <v-card-text style="max-height:62vh">
          <pre class="text-caption" style="white-space:pre; overflow-x:auto; font-family:ui-monospace,Menlo,Consolas,monospace">{{ diff.txt }}</pre>
        </v-card-text>
        <v-divider />
        <v-card-actions>
          <span class="text-caption text-grey ml-2">{{ diff.fileName }}</span>
          <v-spacer />
          <v-btn variant="text" @click="diffOpen = false">{{ $t('common.close') }}</v-btn>
          <v-btn variant="tonal" prepend-icon="mdi-download" @click="download(diffUrl('txt'))">.txt</v-btn>
          <v-btn color="primary" variant="tonal" prepend-icon="mdi-download" @click="download(diffUrl('csv'))">.csv</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete + rollback dialog (manifest → confirm) -->
    <v-dialog v-model="deleteOpen" max-width="1000" scrollable>
      <v-card v-if="deletePlan">
        <v-card-title class="d-flex align-center">
          <span class="text-subtitle-1">{{ $t('files.delete.title') }}</span>
          <v-spacer />
          <div class="d-flex ga-2">
            <v-chip size="small" label>{{ $t('files.delete.docs') }}: {{ deletePlan.totals.docs }}</v-chip>
            <v-chip v-if="deletePlan.totals.invoices" size="small" color="warning" label>{{ $t('files.delete.voidInvoices') }}: {{ deletePlan.totals.invoices }}</v-chip>
            <v-chip v-if="deletePlan.totals.movements" size="small" color="warning" label>{{ $t('files.delete.reverseMovements') }}: {{ deletePlan.totals.movements }}</v-chip>
            <v-chip v-if="deletePlan.totals.products" size="small" color="error" label>{{ $t('files.delete.products') }}: {{ deletePlan.totals.products }}</v-chip>
          </div>
        </v-card-title>
        <v-card-text style="max-height:60vh">
          <v-alert v-if="deletePlan.executed" :type="(deletePlan.warnings || []).length ? 'warning' : 'success'" density="compact" variant="tonal" class="mb-3">
            {{ $t('files.delete.done', { n: (deletePlan.deleted || []).length }) }}
            <span v-if="(deletePlan.reversals || []).length"> · {{ $t('files.delete.reversalsBooked') }}: {{ (deletePlan.reversals || []).join(', ') }}</span>
            <div v-for="(w, i) in deletePlan.warnings || []" :key="i" class="text-caption">⚠ {{ w }}</div>
          </v-alert>
          <v-alert v-else type="warning" density="compact" variant="tonal" class="mb-3">{{ $t('files.delete.warning') }}</v-alert>

          <v-alert v-if="hasProvenanceMismatch" type="error" density="compact" variant="tonal" class="mb-3">
            {{ $t('files.delete.provenance') }}
          </v-alert>

          <v-table density="compact">
            <thead><tr>
              <th>{{ $t('files.col.type') }}</th><th>{{ $t('files.col.number') }}</th><th>{{ $t('files.col.date') }}</th>
              <th>{{ $t('files.delete.willRollBack') }}</th>
            </tr></thead>
            <tbody>
              <tr v-for="p in deletePlan.plans" :key="p.docFileId">
                <td><v-chip size="x-small" label>{{ p.docType }}</v-chip></td>
                <td class="text-caption">{{ p.docNumber }}</td>
                <td class="text-caption">{{ p.docDate }}</td>
                <td class="text-caption">
                  <span v-if="p.blocked" class="text-error">{{ p.blocked }}</span>
                  <template v-else>
                    <v-chip v-for="i in p.invoices" :key="i.id" size="x-small" :color="i.action === 'void' ? 'warning' : 'grey'" label class="mr-1 mb-1">{{ i.number }} · {{ i.action }}</v-chip>
                    <v-chip v-for="m in p.movements" :key="m.id" size="x-small" :color="m.action === 'reverse' ? 'warning' : 'grey'" label class="mr-1 mb-1">{{ m.number }} · {{ m.action }}</v-chip>
                    <v-chip v-for="pr in p.products" :key="pr.id" size="x-small" :color="pr.action === 'deactivate' ? 'error' : 'grey'" label class="mr-1 mb-1">{{ pr.sku }} · {{ pr.action }}</v-chip>
                    <span v-if="!p.invoices.length && !p.movements.length" class="text-grey">{{ $t('files.delete.nothingBooked') }}</span>
                  </template>
                  <div v-for="(w, i) in p.warnings" :key="i" class="text-warning">⚠ {{ w }}</div>
                </td>
              </tr>
            </tbody>
          </v-table>

          <div v-if="(deletePlan.stockImpact || []).length" class="mt-4">
            <div class="text-subtitle-2 mb-1">{{ $t('files.delete.stockImpact') }}</div>
            <v-table density="compact">
              <thead><tr>
                <th>{{ $t('files.col.sku') }}</th><th>{{ $t('files.col.name') }}</th>
                <th class="text-right">{{ $t('files.delete.current') }}</th><th class="text-right">Δ</th><th class="text-right">{{ $t('files.delete.after') }}</th>
              </tr></thead>
              <tbody>
                <tr v-for="s in (deletePlan.stockImpact || []).slice(0, 40)" :key="s.productId">
                  <td class="text-caption">{{ s.sku }}</td>
                  <td class="text-caption">{{ s.name }}</td>
                  <td class="text-right">{{ s.current }}</td>
                  <td class="text-right" :class="s.delta > 0 ? 'text-success' : 'text-error'">{{ s.delta > 0 ? '+' : '' }}{{ s.delta }}</td>
                  <td class="text-right" :class="s.negative ? 'text-error font-weight-bold' : ''">{{ s.after }}</td>
                </tr>
              </tbody>
            </v-table>
          </div>
        </v-card-text>
        <v-divider />
        <v-card-actions class="flex-wrap ga-2 px-4">
          <v-checkbox v-model="delOptions.rollback" :label="$t('files.delete.optRollback')" density="compact" hide-details @update:model-value="planDelete" />
          <v-checkbox v-model="delOptions.removeProducts" :label="$t('files.delete.optProducts')" density="compact" hide-details @update:model-value="planDelete" />
          <v-checkbox v-if="hasProvenanceMismatch" v-model="delOptions.force" :label="$t('files.delete.optForce')" density="compact" hide-details color="error" @update:model-value="planDelete" />
          <v-spacer />
          <v-btn variant="text" @click="deleteOpen = false">{{ $t('common.close') }}</v-btn>
          <v-btn v-if="!deletePlan.executed" color="error" :loading="busy" prepend-icon="mdi-delete-forever" @click="confirmDelete">
            {{ $t('files.delete.confirm', { n: deletePlan.totals.docs }) }}
          </v-btn>
        </v-card-actions>
        <v-progress-linear v-if="busy" :model-value="progress" color="error" height="4" />
      </v-card>
    </v-dialog>

    <!-- Versions dialog -->
    <v-dialog v-model="versionsOpen" max-width="640">
      <v-card>
        <v-card-title class="text-subtitle-1">{{ $t('files.versions') }} — {{ activeDoc?.originalName }}</v-card-title>
        <v-list density="compact">
          <v-list-item v-if="versionData?.current" :title="`v${versionData.current.version} · ${versionData.current.name}`" :subtitle="$t('files.currentVersion')">
            <template #append><v-btn size="x-small" variant="text" icon="mdi-download" @click="download(downloadUrl(activeDoc))" /></template>
          </v-list-item>
          <v-divider />
          <v-list-item v-for="v in versionData?.versions || []" :key="v.name" :title="v.name" :subtitle="new Date(v.archivedAt).toLocaleString()">
            <template #append><v-btn size="x-small" variant="text" icon="mdi-download" @click="download(downloadUrl(activeDoc, v.name))" /></template>
          </v-list-item>
          <v-list-item v-if="!(versionData?.versions || []).length" :title="$t('files.noVersions')" />
        </v-list>
        <v-card-actions><v-spacer /><v-btn variant="text" @click="versionsOpen = false">{{ $t('common.close') }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Reconcile dialog — the per-product delta between what this version SAYS and what is BOOKED -->
    <v-dialog v-model="reconcileOpen" max-width="880" scrollable>
      <v-card>
        <v-card-title class="text-subtitle-1">
          {{ $t('files.reconcile.title') }} — {{ reconcileDoc?.docType }} {{ reconcileDoc?.docNumber }}
          <v-chip size="x-small" label class="ml-2">v{{ reconcileResult?.version ?? reconcileDoc?.version }}</v-chip>
        </v-card-title>
        <v-card-text>
          <!-- An unmatched line makes the delta set incomplete: those products read as "now zero"
               when they are really "unknown", so applying them could reverse a correct booking. -->
          <v-alert v-if="reconcileResult?.unmatchedLines" type="warning" variant="tonal" density="compact" class="mb-3">
            {{ $t('files.reconcile.unmatchedBlock', { n: reconcileResult.unmatchedLines }) }}
          </v-alert>
          <v-alert v-if="!(reconcileResult?.deltas || []).length" type="success" variant="tonal" density="compact">
            {{ $t('files.reconcile.noChange') }}
          </v-alert>
          <template v-else>
            <v-alert type="info" variant="tonal" density="compact" class="mb-3">
              {{ $t('files.reconcile.summary', {
                c: reconcileResult.creates, u: reconcileResult.updates, d: reconcileResult.deletes,
              }) }}
              <span v-if="(reconcileResult.bookedMovements || []).length" class="text-caption d-block mt-1">
                {{ $t('files.reconcile.booked') }}: {{ reconcileResult.bookedMovements.join(', ') }}
              </span>
            </v-alert>
            <v-table density="compact">
              <thead><tr>
                <th>{{ $t('files.reconcile.matched') }}</th>
                <th class="text-right">{{ $t('files.reconcile.bookedNet') }}</th>
                <th class="text-right">{{ $t('files.reconcile.newNet') }}</th>
                <th class="text-right">{{ $t('files.reconcile.delta') }}</th>
                <th>{{ $t('files.reconcile.change') }}</th>
              </tr></thead>
              <tbody>
                <tr v-for="d in reconcileResult.deltas" :key="d.productId">
                  <td><span class="text-caption text-grey mr-1">{{ d.sku }}</span>{{ d.name }}</td>
                  <td class="text-right">{{ d.bookedNet }}</td>
                  <td class="text-right">{{ d.newNet }}</td>
                  <td class="text-right font-weight-medium">{{ d.delta > 0 ? '+' : '' }}{{ d.delta }}</td>
                  <td><v-chip size="x-small" :color="changeColor(d.change)" label>{{ d.change }}</v-chip></td>
                </tr>
              </tbody>
            </v-table>
          </template>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="reconcileOpen = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn
            v-if="(reconcileResult?.deltas || []).length && !reconcileResult?.unmatchedLines" color="deep-purple" variant="flat"
            :loading="busy" prepend-icon="mdi-sync" @click="applyReconcile"
          >{{ $t('files.reconcile.execute') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { downloadAsSession } from 'ui-shared/composables/useSessionDownload'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import HubPageHeader from 'ui-shell/components/HubPageHeader'
import { useAppStore } from '../store/app.store'

const { t } = useI18n()
const route = useRoute()
const appStore = useAppStore()
const { showError, showSuccess } = useSnackbar()

const viewMode = ref<'flat' | 'date'>('flat')
const items = ref<any[]>([])
const total = ref(0)
const loading = ref(false)
const page = ref(0)
const size = ref(25)
const search = ref('')
const docType = ref<string | null>(null)
const docDate = ref('')
const statusFilter = ref<string | null>(null)

const selected = reactive(new Set<string>())
const expandedDocs = reactive(new Set<string>())
const busy = ref(false)
const progress = ref(0)
/** Last line the running job reported ("12/42 3000016320") — a long batch must not look frozen. */
const jobLabel = ref('')
const options = reactive({ force: false, adjustStock: true, allowDuplicate: false })

const typeItems = ['invoice', 'cash_register', 'goods_receipt', 'correction', 'transfer_note', 'issue_note', 'store_operations', 'store_availability', 'unknown']
const statusItems = ['uploaded', 'analyzed', 'committed', 'superseded']
const headers = [
  { title: '', key: 'select', sortable: false, width: 40 },
  { title: t('files.col.type'), key: 'docType' },
  { title: t('files.col.number'), key: 'docNumber' },
  { title: t('files.col.date'), key: 'docDate' },
  { title: t('files.col.status'), key: 'status' },
  { title: t('files.col.version'), key: 'version', sortable: false },
  { title: '', key: 'actions', sortable: false },
]

function changeColor(c: string) {
  return c === 'create' ? 'success' : c === 'delete' ? 'error' : 'info'
}
function statusColor(s: string) {
  return { uploaded: 'grey', extracted: 'info', analyzed: 'warning', committed: 'success', superseded: 'error' }[s] || 'grey'
}
/** The files API, relative to the API base like every `httpClient` call. */
function base() {
  return `${appStore.orgUrl()}/files`
}
function downloadUrl(item: any, version?: string) {
  const v = version ? `?version=${encodeURIComponent(version)}` : ''
  return `${base()}/${item.docFileId || item._id}/download${v}`
}
/**
 * ⚠ Downloads go through this tab's session, never a plain link: a link carries only the `auth`
 * cookie, which names whichever org this browser entered last (each tab has its own org).
 */
async function download(path: string) {
  try {
    await downloadAsSession(path)
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}
const filterParams = () => ({ search: search.value || undefined, docType: docType.value || undefined, status: statusFilter.value || undefined })

function toggle(id: string) { selected.has(id) ? selected.delete(id) : selected.add(id) }
function clearSelection() { selected.clear() }

// ── flat ──
async function reload() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/files`, {
      params: { page: page.value, size: size.value, ...filterParams(), docDate: docDate.value || undefined },
    })
    items.value = (data.docFiles || []).map((d: any) => ({ ...d, docFileId: d._id }))
    total.value = data.total || 0
  } catch (e: any) { showError(e?.response?.data?.message || t('common.operationFailed')) } finally { loading.value = false }
}
function onOptions(opts: any) { page.value = (opts.page || 1) - 1; size.value = opts.itemsPerPage || 25; reload() }

// ── by date ──
const dates = ref<any[]>([])
const datesLoading = ref(false)
const expanded = ref<string[]>([])
const dateDocs = reactive<Record<string, any[]>>({})
async function loadDates() {
  datesLoading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/files/dates`, { params: filterParams() })
    dates.value = data.dates || []
  } catch (e: any) { showError(e?.response?.data?.message || t('common.operationFailed')) } finally { datesLoading.value = false }
}
async function loadDateDocs(date: string) {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/files`, { params: { docDate: date, size: 500, ...filterParams() } })
    dateDocs[date] = (data.docFiles || []).map((d: any) => ({ ...d, docFileId: d._id }))
  } catch { dateDocs[date] = [] }
}
// Lazy-load a date's documents when its panel opens.
watch(expanded, (open) => { for (const date of open) if (!dateDocs[date]) loadDateDocs(date) })
function dateAllSelected(date: string) { const d = dateDocs[date]; return !!d?.length && d.every((x) => selected.has(x.docFileId)) }
function dateSomeSelected(date: string) { const d = dateDocs[date]; return !!d?.some((x) => selected.has(x.docFileId)) && !dateAllSelected(date) }
async function toggleDate(date: string) {
  if (!dateDocs[date]) await loadDateDocs(date)
  const d = dateDocs[date] || []
  const all = dateAllSelected(date)
  d.forEach((x) => (all ? selected.delete(x.docFileId) : selected.add(x.docFileId)))
}

function onViewChange() { reloadAll() }
function reloadAll() { selectedResetDocsCache(); viewMode.value === 'date' ? loadDates() : reload() }
function selectedResetDocsCache() { for (const k of Object.keys(dateDocs)) delete dateDocs[k] }

// ── background job poller ──
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/**
 * Poll a background job to completion.
 *
 * A fixed iteration cap used to abandon the job at ~10 minutes while the server carried on: a
 * 40-document batch that falls back to the model runs far longer, so the UI span forever and then
 * failed on work that was actually progressing. Give up only when the server itself stops making
 * progress (no change for STALL_MS), and say so, rather than on a wall-clock guess.
 */
const STALL_MS = 5 * 60 * 1000
async function runJob(url: string, body: any): Promise<any> {
  progress.value = 0
  jobLabel.value = ''
  const { data: started } = await httpClient.post(url, body)
  const taskId = started.taskId
  if (!taskId) return started
  let lastChange = Date.now()
  let seen = ''
  for (;;) {
    await sleep(2000)
    const { data: task } = await httpClient.get(`${appStore.orgUrl()}/files/task/${taskId}`)
    if (typeof task.progress === 'number') progress.value = task.progress
    const line = (task.logs || []).slice(-1)[0]
    jobLabel.value = typeof line === 'string' ? line : (line?.message || '')
    const stamp = `${task.progress}|${jobLabel.value}`
    if (stamp !== seen) { seen = stamp; lastChange = Date.now() }
    if (task.status === 'completed') return task.result
    if (task.status === 'failed') throw new Error(task.error || t('common.operationFailed'))
    if (Date.now() - lastChange > STALL_MS) throw new Error(t('files.batch.stalled', { s: Math.round(STALL_MS / 1000) }))
  }
}

// ── analyze → review → commit ──
const reviewOpen = ref(false)
const reconcileOpen = ref(false)
const reconcileDoc = ref<any>(null)
const reconcileResult = ref<any>(null)
/** The date whose documents the review is showing, when it was opened for a whole day. */
const reviewScope = ref('')
const analyzeResults = ref<any[]>([])
const commitSel = reactive(new Set<string>())
const reviewCounts = computed(() => ({
  ok: analyzeResults.value.filter((r) => r.committable && !r.error).length,
  // The review now covers a whole selection or a whole day, so it has to account for documents
  // that carry no analysis yet and for ones already booked — not only the commit candidates.
  pending: analyzeResults.value.filter((r) => r.analyzed === false && r.status !== 'committed').length,
  done: analyzeResults.value.filter((r) => r.status === 'committed').length,
  warn: analyzeResults.value.filter((r) => (r.warnings?.length || 0) > 0 || r.unmatched > 0).length,
  dup: analyzeResults.value.filter((r) => r.duplicate).length,
  err: analyzeResults.value.filter((r) => r.error).length,
}))
const allReviewSelected = computed(() => { const c = analyzeResults.value.filter((r) => r.committable); return !!c.length && c.every((r) => commitSel.has(r.docFileId)) })
const someReviewSelected = computed(() => commitSel.size > 0 && !allReviewSelected.value)
function toggleCommit(id: string) { commitSel.has(id) ? commitSel.delete(id) : commitSel.add(id) }
function toggleAllReview() {
  const c = analyzeResults.value.filter((r) => r.committable)
  const all = c.every((r) => commitSel.has(r.docFileId))
  commitSel.clear(); if (!all) c.forEach((r) => commitSel.add(r.docFileId))
}

function toggleExpand(id: string) { expandedDocs.has(id) ? expandedDocs.delete(id) : expandedDocs.add(id) }

/** Open the review gate on the current analyses. The reuse guard makes this instant for anything
 *  already analyzed, so it is also how a day gets committed without re-running a thing. */
/**
 * Open the review over what is already STORED — for the current selection, or for a whole date.
 * No job, no engine: this is a view, so it must never re-analyze or spend a sidecar call, and it
 * shows every document whatever its status (still uploaded, analyzed, already committed).
 */
async function openStoredReview(scope: { docFileIds?: string[]; docDate?: string }) {
  busy.value = true
  try {
    const { data } = await httpClient.post(`${appStore.orgUrl()}/files/analysis`, scope)
    reviewScope.value = scope.docDate || ''
    openReview(data.results || [])
  } catch (e: any) { showError(e?.response?.data?.message || e?.message || t('common.operationFailed')) } finally { busy.value = false }
}
const reviewSelected = () => openStoredReview({ docFileIds: [...selected] })
const reviewDate = (docDate: string) => openStoredReview({ docDate })
const reviewOne = (item: any) => openStoredReview({ docFileIds: [item.docFileId] })

/**
 * Analyse the rows in the open review that have never been analysed, then refresh it in place.
 *
 * Only those rows are sent — re-analysing the ones already done would spend sidecar calls to
 * reproduce what is on screen. The review reopens over the SAME set so nothing the user was
 * looking at disappears.
 */
async function analyzePendingInReview() {
  const pending = analyzeResults.value.filter((r: any) => r.analyzed === false && r.status !== 'committed')
  if (!pending.length) return
  const scope = reviewScope.value
    ? { docDate: reviewScope.value }
    : { docFileIds: analyzeResults.value.map((r: any) => r.docFileId) }
  busy.value = true
  try {
    await runJob(`${appStore.orgUrl()}/files/analyze-batch`, { docFileIds: pending.map((r: any) => r.docFileId), force: false })
  } catch (e: any) {
    showError(e?.response?.data?.message || e?.message || t('common.operationFailed')); busy.value = false; return
  }
  busy.value = false
  await openStoredReview(scope)
}

/** Extract text for the selection without analyzing. Analyze does it on demand anyway, but as a
 *  separate step it can be watched, and it is the slow half for a scanned document. */
async function ocrSelected() {
  busy.value = true
  try {
    const res = await runJob(`${appStore.orgUrl()}/files/ocr-batch`, { docFileIds: [...selected], force: options.force })
    const rows = res.results || []
    showSuccess(t('files.batch.ocrDone', { ok: rows.filter((r: any) => r.ok).length, skip: rows.filter((r: any) => r.skipped).length }))
    await reloadAll()
  } catch (e: any) { showError(e?.response?.data?.message || e?.message || t('common.operationFailed')) } finally { busy.value = false }
}

/** The one-click run: text, then analysis, both in the canonical order (receipts before the
 *  invoices that sell what they create), stopping at the review gate. Committing stays manual. */
async function processSelected() {
  busy.value = true
  try {
    await runJob(`${appStore.orgUrl()}/files/ocr-batch`, { docFileIds: [...selected], force: false })
    const res = await runJob(`${appStore.orgUrl()}/files/analyze-batch`, { docFileIds: [...selected], force: options.force })
    openReview(res.results || [])
  } catch (e: any) { showError(e?.response?.data?.message || e?.message || t('common.operationFailed')) } finally { busy.value = false }
}

function openReview(results: any[]) {
  analyzeResults.value = results
  // Pre-select only what is genuinely clean. The server withholds its recommendation from any
  // document carrying a blocking warning, however well its lines matched.
  commitSel.clear()
  expandedDocs.clear()
  analyzeResults.value.forEach((r) => { if (r.recommended) commitSel.add(r.docFileId) })
  // Anything needing attention opens already expanded — that is the point of the review step.
  analyzeResults.value.forEach((r) => { if (r.hasBlocking || r.unmatched) expandedDocs.add(r.docFileId) })
  reviewOpen.value = true
}

async function analyzeSelected() {
  busy.value = true
  try {
    const res = await runJob(`${appStore.orgUrl()}/files/analyze-batch`, { docFileIds: [...selected], force: options.force })
    openReview(res.results || [])
  } catch (e: any) { showError(e?.response?.data?.message || e?.message || t('common.operationFailed')) } finally { busy.value = false }
}

/** Only a MOVEMENT document can be reconciled — that is the only booking a delta can be applied to. */
const RECONCILABLE = new Set(['goods_receipt', 'correction', 'transfer_note', 'issue_note', 'store_operations'])
function canReconcile(item: any) {
  return !!item.staleBooking && RECONCILABLE.has(item.docType)
}

/**
 * Apply a re-uploaded document's changes to what it already booked.
 *
 * Always previewed first: the dry run names the per-product delta, and nothing is written until the
 * user confirms it. Committing instead would double-book — the original movement is still there.
 */
async function reconcileOne(item: any) {
  busy.value = true
  try {
    const preview = await runJob(`${appStore.orgUrl()}/files/${item.docFileId}/reconcile?execute=false`, {})
    reconcileDoc.value = item
    reconcileResult.value = preview
    reconcileOpen.value = true
  } catch (e: any) { showError(e?.response?.data?.message || e?.message || t('common.operationFailed')) } finally { busy.value = false }
}

async function applyReconcile() {
  if (!reconcileDoc.value) return
  busy.value = true
  try {
    const res = await runJob(`${appStore.orgUrl()}/files/${reconcileDoc.value.docFileId}/reconcile?execute=true`, {})
    reconcileResult.value = res
    if (res.blocked) { showError(res.blockedReason || t('files.reconcile.unmatchedBlock', { n: res.unmatchedLines || 0 })); reconcileResult.value = res; return }
    if (res.verified === false) showError(t('files.reconcile.unverified'))
    else showSuccess(t('files.reconcile.done', { n: (res.bookedNow || []).length }))
    reconcileOpen.value = false
    await reloadAll()
  } catch (e: any) { showError(e?.response?.data?.message || e?.message || t('common.operationFailed')) } finally { busy.value = false }
}

/** Batch: preview every stale document in the selection, one after another. */
async function reconcileSelected() {
  const stale = items.value.filter((i: any) => selected.has(i.docFileId) && canReconcile(i))
  if (!stale.length) { showError(t('files.reconcile.noneStale')); return }
  await reconcileOne(stale[0])
}

async function commitReviewed() {
  busy.value = true
  try {
    const res = await runJob(`${appStore.orgUrl()}/files/commit-batch`, {
      docFileIds: [...commitSel], adjustStock: options.adjustStock, allowDuplicate: options.allowDuplicate,
    })
    const results = res.results || []
    const ok = results.filter((r: any) => r.ok).length
    const failed = results.filter((r: any) => !r.ok)
    if (failed.length) showError(t('files.review.commitPartial', { ok, fail: failed.length }))
    else showSuccess(t('files.review.commitDone', { n: ok }))
    reviewOpen.value = false
    clearSelection()
    reloadAll()
  } catch (e: any) { showError(e?.response?.data?.message || e?.message || t('common.operationFailed')) } finally { busy.value = false }
}

// ── the day's snapshot diff, as the report it dumps beside the file ──
const diffOpen = ref(false)
const diff = ref<any>(null)
const diffUrl = (format: 'txt' | 'csv') => `${base()}/${diff.value?.docFileId}/compare/download?format=${format}`

/** Run (or re-run) the compare for a date and show the report, with the dumps downloadable. */
async function diffDate(docDate: string) {
  busy.value = true
  try {
    // The newest snapshot of the day is the one that describes how it ended.
    const { data } = await httpClient.get(`${appStore.orgUrl()}/files`, { params: { docDate, docType: 'store_availability', size: 20 } })
    const snaps = (data.docFiles || []).slice().sort((a: any, b: any) => String(b.docNumber).localeCompare(String(a.docNumber)))
    if (!snaps.length) { showError(t('files.diff.noSnapshot', { d: docDate })); return }
    const snap = snaps[0]
    const { data: res } = await httpClient.post(`${appStore.orgUrl()}/files/${snap._id}/compare`)
    diff.value = { docDate, docFileId: snap._id, fileName: snap.originalName, summary: res.summary, txt: res.txt }
    diffOpen.value = true
  } catch (e: any) {
    showError(e?.response?.data?.message || e?.message || t('common.operationFailed'))
  } finally { busy.value = false }
}

// ── delete + rollback (manifest first, then an explicit confirm) ──
const deleteOpen = ref(false)
const deletePlan = ref<any>(null)
const delOptions = reactive({ rollback: true, removeProducts: false, force: false })
const hasProvenanceMismatch = computed(() => (deletePlan.value?.plans || []).some((p: any) => p.provenanceMismatch))

async function runDelete(execute: boolean) {
  busy.value = true
  try {
    const res = await runJob(`${appStore.orgUrl()}/files/delete-batch`, {
      docFileIds: [...selected], rollback: delOptions.rollback, removeProducts: delOptions.removeProducts,
      force: delOptions.force, execute,
    })
    deletePlan.value = res
    deleteOpen.value = true
    return res
  } catch (e: any) {
    showError(e?.response?.data?.message || e?.message || t('common.operationFailed'))
    return null
  } finally { busy.value = false }
}
/** Dry run — books nothing, just shows what removal would undo. */
const planDelete = () => runDelete(false)

async function confirmDelete() {
  const res = await runDelete(true)
  if (!res) return
  if ((res.warnings || []).length) showError(t('files.delete.partial', { n: (res.deleted || []).length, w: res.warnings.length }))
  else showSuccess(t('files.delete.done', { n: (res.deleted || []).length }))
  clearSelection()
  reloadAll()
}

// ── versions ──
const versionsOpen = ref(false)
const activeDoc = ref<any>(null)
const versionData = ref<any>(null)
async function openVersions(item: any) {
  activeDoc.value = item; versionsOpen.value = true; versionData.value = null
  try { const { data } = await httpClient.get(`${appStore.orgUrl()}/files/${item._id}/versions`); versionData.value = data } catch { /* ignore */ }
}

onMounted(async () => {
  if (!appStore.currentOrg?.id) await appStore.fetchProfile()
  // Arriving from the upload page: open that day straight away, which is the batch the user just
  // uploaded and wants to run.
  const day = String(route.query.docDate || '')
  if (day) {
    viewMode.value = 'date'
    await loadDates()
    expanded.value = [day]
    return
  }
  reload()
})
</script>
