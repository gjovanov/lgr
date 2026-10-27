<template>
  <v-container>
    <div class="d-flex align-center mb-2 flex-wrap ga-2">
      <h1 class="text-h5">{{ $t('servers.title') }}</h1>
      <v-spacer />
      <v-btn v-if="!notHere" color="primary" data-test="add-server" @click="openAdd">
        <v-icon start>mdi-plus</v-icon>
        {{ $t('servers.add') }}
      </v-btn>
    </div>
    <p class="text-body-2 text-medium-emphasis mb-4">{{ $t('servers.intro') }}</p>

    <!-- A master itself registers nowhere: the page is served by lgrai.app. -->
    <v-alert v-if="notHere" type="info" variant="tonal" data-test="servers-not-here">
      {{ $t('servers.notHere') }}
    </v-alert>

    <template v-else>
      <!-- FR-20.79: a move under way, or one that ended in the last day. -->
      <v-alert
        v-if="move && moveShown"
        :type="move.state === 'done' ? 'success' : move.state === 'aborted' ? 'warning' : 'info'"
        variant="tonal"
        class="mb-3"
        data-test="move-banner"
      >
        <template v-if="move.kind === 'promote'">
          <!-- FR-20.81 (P3-6d): the mirror made the home. -->
          <div v-if="LIVE.includes(move.state)">{{ $t('servers.promote.live', { state: $t(`servers.promote.state.${move.state}`) }) }}</div>
          <div v-else-if="move.state === 'done'">{{ $t('servers.promote.done') }}</div>
          <div v-else>{{ $t('servers.promote.state.aborted') }}<span v-if="move.error"> · {{ move.error }}</span></div>
        </template>
        <template v-else-if="move.kind === 'to_global'">
          <!-- FR-20.80 (P3-6c): back to lgrai.app. -->
          <div v-if="LIVE.includes(move.state)">
            {{ $t('servers.moveBack.live', { state: $t(`servers.moveBack.state.${move.state}`) }) }}
            <span v-if="move.state === 'copying' && move.waiting" data-test="move-back-waiting"> · {{ $t('servers.moveBack.waitingFor', { what: $t(`servers.moveBack.waiting.${move.waiting.on}`) }) }}</span>
          </div>
          <div v-else-if="move.state === 'done'">
            {{ $t('servers.moveBack.done') }}
            <div class="text-caption mt-1">{{ $t('servers.moveBack.desktopsNote') }}</div>
          </div>
          <div v-else>{{ $t('servers.moveBack.state.aborted') }}<span v-if="move.error"> · {{ move.error }}</span></div>
        </template>
        <template v-else>
          <div v-if="LIVE.includes(move.state)">{{ $t('servers.move.live', { name: nodeName(move.to), state: $t(`servers.move.state.${move.state}`) }) }}</div>
          <div v-else-if="move.state === 'done'">
            {{ $t('servers.move.done', { name: nodeName(move.to) }) }}
            <div class="text-caption mt-1">{{ $t('servers.move.desktopsNote') }}</div>
          </div>
          <div v-else>{{ $t('servers.move.state.aborted') }}<span v-if="move.error"> · {{ move.error }}</span></div>
        </template>
        <template v-if="ABORTABLE.includes(move.state)" #append>
          <v-btn size="small" variant="text" color="error" :loading="moveBusy" data-test="abort-move" @click="abortMove">{{ $t('servers.move.abort') }}</v-btn>
        </template>
      </v-alert>
      <!-- FR-20.81 (P3-6d): after a promotion, legal numbering waits for the site's last numbers. -->
      <v-card v-if="lastNumbers?.frozen" variant="outlined" color="warning" class="mb-3" data-test="last-numbers">
        <v-card-title class="text-subtitle-1 text-wrap">{{ $t('servers.lastNumbers.title') }}</v-card-title>
        <v-card-text>
          <p class="text-body-2 mb-3">{{ $t('servers.lastNumbers.intro') }}</p>
          <v-row v-for="s in lastNumbers.series" :key="s.prefix + s.year" dense align="center">
            <v-col cols="12" sm="6" class="text-body-2">
              {{ seriesLabel(s) }}
              <div class="text-caption text-medium-emphasis">{{ $t('servers.lastNumbers.here', { n: s.last }) }}</div>
            </v-col>
            <v-col cols="12" sm="6">
              <v-text-field v-model.number="siteNumbers[s.prefix + '|' + s.year]" type="number" :min="0" density="compact" hide-details :data-test="'last-' + s.prefix" />
            </v-col>
          </v-row>
          <v-checkbox v-model="lastNumbersConfirmed" :label="$t('servers.lastNumbers.confirm')" density="compact" hide-details class="mt-2" data-test="last-numbers-confirm" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn color="primary" :disabled="!lastNumbersConfirmed" :loading="lastNumbersBusy" data-test="last-numbers-save" @click="saveLastNumbers">{{ $t('servers.lastNumbers.save') }}</v-btn>
        </v-card-actions>
      </v-card>
      <!-- FR-20.84 (P3-6e): what a replaced server did after the cutoff, as it reached lgrai.app, for review. -->
      <v-card v-for="ex in fencedExports" :key="ex.id" variant="outlined" class="mb-3" data-test="fenced-export">
        <v-card-title class="text-subtitle-1 text-wrap">{{ $t('servers.fenced.title', { name: ex.nodeName || nodeName(ex.nodeId) }) }}</v-card-title>
        <v-card-text>
          <p class="text-body-2 mb-2">{{ $t('servers.fenced.intro') }}</p>
          <v-chip size="small" :color="ex.state === 'received' ? 'success' : ex.state === 'refused' ? 'error' : 'info'" variant="tonal" class="mb-2" data-test="fenced-state">
            <template v-if="ex.state === 'received'">{{ $t('servers.fenced.state.received', { when: fmtDate(ex.receivedAt) }) }}</template>
            <template v-else-if="ex.state === 'refused'">{{ $t('servers.fenced.state.refused') }}</template>
            <template v-else>{{ $t('servers.fenced.state.receiving', { pct: Math.floor((100 * ex.received) / Math.max(1, ex.size)) }) }}</template>
          </v-chip>
          <div v-if="ex.error" class="text-caption text-error mb-2">{{ ex.error }}</div>
          <template v-if="ex.summary">
            <div class="text-body-2">{{ $t('servers.fenced.counts', { documents: ex.summary.documents, deleted: ex.summary.deleted, files: ex.summary.files }) }}</div>
            <div v-if="ex.summary.missingFiles" class="text-caption text-warning">{{ $t('servers.fenced.missingFiles', { n: ex.summary.missingFiles }) }}</div>
            <v-alert v-if="ex.collisions" type="warning" variant="tonal" density="compact" class="my-2" data-test="fenced-collisions">
              {{ $t('servers.fenced.collisions', { n: ex.collisions }) }}
            </v-alert>
            <!-- FR-20.84 (P3-6e): the audited import, asked for here, run by lgrai.app. -->
            <div class="d-flex align-center flex-wrap ga-2 my-2" data-test="fenced-import">
              <template v-if="!ex.import">
                <v-btn v-if="ex.state === 'received'" color="primary" variant="tonal" size="small" data-test="fenced-import-start" @click="importOpen = ex">{{ $t('servers.fenced.import.action') }}</v-btn>
              </template>
              <v-chip v-else-if="ex.import.state !== 'done'" size="small" color="info" variant="tonal" data-test="fenced-import-running">{{ $t('servers.fenced.import.running') }}</v-chip>
              <template v-else>
                <v-chip size="small" color="success" variant="tonal" data-test="fenced-import-done">{{ $t('servers.fenced.import.done', { when: fmtDate(ex.import.doneAt) }) }}</v-chip>
                <span class="text-body-2">{{ $t('servers.fenced.import.counts', importCounts(ex.import.counts)) }}</span>
              </template>
              <span v-if="ex.import?.error" class="text-caption text-error">{{ ex.import.error }}</span>
            </div>
            <div class="text-subtitle-2 mt-3">{{ $t('servers.fenced.legalTitle') }}</div>
            <div v-if="!ex.legal.length" class="text-body-2 text-medium-emphasis">{{ $t('servers.fenced.noLegal') }}</div>
            <v-table v-else density="compact" class="mt-1" data-test="fenced-legal">
              <thead>
                <tr>
                  <th>{{ $t('servers.fenced.number') }}</th>
                  <th>{{ $t('servers.fenced.type') }}</th>
                  <th>{{ $t('servers.fenced.date') }}</th>
                  <th class="text-end">{{ $t('servers.fenced.total') }}</th>
                  <th>{{ $t('servers.fenced.onGlobalLabel') }}</th>
                  <th v-if="ex.import">{{ $t('servers.fenced.import.label') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="l in ex.legal" :key="l.id" :data-test="'fenced-' + l.onGlobal">
                  <td>{{ l.number || '—' }}</td>
                  <td>{{ docTypeLabel(l.type) }}</td>
                  <td>{{ fmtDate(l.issueDate, true) }}</td>
                  <td class="text-end">{{ l.total ?? '' }} {{ l.currency ?? '' }}</td>
                  <td>
                    <v-chip size="x-small" :color="l.onGlobal === 'collision' ? 'error' : l.onGlobal === 'same_id' ? 'info' : 'success'" variant="tonal">
                      {{ $t(`servers.fenced.onGlobal.${l.onGlobal}`, { number: l.collidesWith?.number ?? '' }) }}
                    </v-chip>
                  </td>
                  <td v-if="ex.import" :data-test="'fenced-outcome-' + (l.imported?.outcome ?? 'pending')">
                    <template v-if="l.imported">
                      <v-chip size="x-small" :color="l.imported.outcome === 'imported' ? 'success' : l.imported.outcome === 'failed' ? 'error' : 'warning'" variant="tonal">
                        {{ $t(`servers.fenced.outcome.${l.imported.outcome}`) }}
                      </v-chip>
                      <div v-if="l.imported.outcome !== 'imported' && l.imported.reason" class="text-caption text-medium-emphasis">
                        {{ te(`servers.fenced.reason.${l.imported.reason}`) ? $t(`servers.fenced.reason.${l.imported.reason}`) : l.imported.reason }}
                      </div>
                    </template>
                  </td>
                </tr>
              </tbody>
            </v-table>
            <div v-if="ex.summary.legalTruncated" class="text-caption text-medium-emphasis mt-1">{{ $t('servers.fenced.truncated') }}</div>
          </template>
        </v-card-text>
      </v-card>
      <!-- FR-20.69 (P3-3): while one of the org's servers is its home, its files on lgrai.app. -->
      <v-card v-if="mirror && mirror.home !== 'global'" variant="outlined" class="mb-3" data-test="mirror-files">
        <v-card-title class="text-subtitle-1">{{ $t('servers.files.title') }}</v-card-title>
        <v-card-text>
          <p class="text-body-2 mb-2">{{ $t('servers.files.intro', { name: nodeName(mirror.home) }) }}</p>
          <v-switch
            :model-value="mirror.files"
            :label="$t('servers.files.switch')"
            :hint="mirror.files ? '' : $t('servers.files.metadataOnly')"
            :persistent-hint="!mirror.files"
            :loading="mirrorBusy"
            :disabled="mirrorBusy"
            color="primary"
            density="compact"
            data-test="mirror-files-switch"
            @update:model-value="v => setMirrorFiles(!!v)"
          />
          <div class="text-body-2 mt-2" data-test="mirror-files-status">
            <template v-if="!mirror.referenced">{{ $t('servers.files.none') }}</template>
            <template v-else-if="mirror.complete">{{ $t('servers.files.complete', { count: mirror.referenced }) }}</template>
            <template v-else>{{ $t('servers.files.progress', { held: mirror.held, count: mirror.referenced }) }}</template>
            <span v-if="mirror.arriving"> {{ $t('servers.files.arriving', { count: mirror.arriving }) }}</span>
            <span v-if="mirror.files && mirror.waiting"> {{ $t('servers.files.waiting', { count: mirror.waiting }) }}</span>
          </div>
          <div v-if="mirror.missingOnMaster" class="text-body-2 text-warning mt-1">{{ $t('servers.files.missing', { count: mirror.missingOnMaster }) }}</div>
          <div v-if="mirror.failing" class="text-caption text-medium-emphasis mt-1">{{ $t('servers.files.failing', { count: mirror.failing }) }}</div>
        </v-card-text>
      </v-card>
      <v-switch
        v-model="includeRevoked"
        :label="$t('servers.includeRevoked')"
        density="compact"
        hide-details
        color="primary"
        class="mb-2"
      />
      <v-data-table
        :headers="headers"
        :items="items"
        :loading="loading"
        item-value="id"
        density="comfortable"
        :no-data-text="$t('servers.none')"
      >
        <template #item.name="{ item }">
          <div class="d-flex align-center ga-2">
            <span>{{ item.name }}</span>
            <v-chip v-if="item.ephemeral" size="x-small" variant="tonal" color="info">{{ $t('servers.ephemeral') }}</v-chip>
            <v-chip v-if="item.cloneAlarm" size="x-small" color="error" variant="flat" data-test="clone-alarm">{{ $t('servers.cloneAlarm') }}</v-chip>
          </div>
          <div class="text-caption text-medium-emphasis"><code>{{ item.id }}</code></div>
        </template>
        <template #item.linkLevel="{ item }">
          <v-chip size="small" variant="tonal" :color="item.linkLevel === 'full' ? 'primary' : undefined">
            {{ $t(`servers.linkLevel.${item.linkLevel}`) }}
          </v-chip>
        </template>
        <template #item.status="{ item }">
          <v-chip :color="item.status === 'active' ? 'success' : 'error'" size="small" variant="tonal">
            {{ item.status === 'active' ? $t('common.active') : $t('servers.revoked') }}
          </v-chip>
        </template>
        <template #item.os="{ item }">
          {{ item.os?.platform ? `${item.os.platform} ${item.os.version ?? ''}`.trim() : '—' }}
        </template>
        <template #item.version="{ item }">{{ item.health?.appVersion || item.versions?.app || '—' }}</template>
        <template #item.connected="{ item }">
          <div class="d-flex ga-1">
            <v-chip v-for="ch in ['interactive', 'bulk']" :key="ch" size="x-small" variant="tonal" :color="item.connected?.[ch] ? 'success' : undefined">
              {{ ch === 'interactive' ? 'I' : 'B' }} {{ item.connected?.[ch] ? $t('servers.live') : '—' }}
            </v-chip>
          </div>
        </template>
        <template #item.health="{ item }">
          <span v-if="item.health">
            <span v-if="typeof item.health.diskFreeBytes === 'number'">{{ $t('servers.diskFree', { gb: (item.health.diskFreeBytes / 2 ** 30).toFixed(1) }) }}</span>
            <span v-if="item.health.apiOk === false" class="text-error"> · {{ $t('servers.apiDown') }}</span>
            <!-- FR-20.20: an update that waits, and why; the alarm after seven nights kept out. -->
            <span v-if="item.health.update?.state === 'installing'"> · {{ $t('servers.updateInstalling', { version: item.health.update.available }) }}</span>
            <span v-if="item.health.update?.state === 'deferred'" :class="item.health.update.alarm ? 'text-error' : undefined">
              · {{ $t('servers.updateWaits', { version: item.health.update.available, reason: item.health.update.reason }) }}
              <template v-if="item.health.update.alarm"> · {{ $t('servers.updateAlarm', { n: item.health.update.blockedWindows }) }}</template>
            </span>
          </span>
          <span v-else class="text-medium-emphasis">—</span>
        </template>
        <template #item.relays="{ item }">
          <template v-if="item.status === 'active'">
            <v-switch
              v-for="kind in RELAY_KINDS"
              :key="kind"
              :model-value="!!item.relays?.[kind]"
              :label="$t(kind === 'mail' ? 'servers.relayMail' : 'servers.relayDocuments')"
              :hint="item.relays?.[kind + 'Chosen'] ? '' : $t('servers.relayDefault')"
              :persistent-hint="!item.relays?.[kind + 'Chosen']"
              :loading="relayBusy === item.id + ':' + kind"
              density="compact"
              color="primary"
              :data-test="'relay-' + kind"
              @update:model-value="v => setRelay(item, kind, !!v)"
            />
          </template>
        </template>
        <template #item.lastSeenAt="{ item }">
          {{ item.lastSeenAt ? new Date(item.lastSeenAt).toLocaleString() : '—' }}
        </template>
        <template #item.actions="{ item }">
          <v-btn
            v-if="item.status === 'active' && item.linkLevel === 'full' && !(move && LIVE.includes(move.state)) && (!mirror || mirror.home === 'global')"
            size="small"
            variant="text"
            color="primary"
            data-test="move-here"
            @click="openMove(item)"
          >
            {{ $t('servers.move.action') }}
          </v-btn>
          <v-btn
            v-if="item.status === 'active' && mirror?.home === item.id && !(move && LIVE.includes(move.state))"
            size="small"
            variant="text"
            color="primary"
            data-test="move-back"
            @click="openMoveBack(item)"
          >
            {{ $t('servers.moveBack.action') }}
          </v-btn>
          <v-btn
            v-if="mirror?.home === item.id && !item.connected?.interactive && !item.connected?.bulk && !(move && LIVE.includes(move.state))"
            size="small"
            variant="text"
            color="error"
            data-test="promote"
            @click="openPromote(item)"
          >
            {{ $t('servers.promote.action') }}
          </v-btn>
          <v-btn
            v-if="item.status === 'active'"
            size="small"
            variant="text"
            color="error"
            data-test="remove-server"
            @click="openRemove(item)"
          >
            {{ $t('servers.remove') }}
          </v-btn>
        </template>
      </v-data-table>
      <p class="text-caption text-medium-emphasis mt-2">{{ $t('servers.relayWhat') }}</p>
      <p class="text-caption text-medium-emphasis mt-1">{{ $t('servers.relayDocumentsWhat') }}</p>
    </template>

    <!-- ── Add a server: a code for the master's setup ──────────────────────────────────────── -->
    <v-dialog v-model="addOpen" max-width="520" @after-leave="stopPolling">
      <v-card>
        <v-card-title>{{ $t('servers.add') }}</v-card-title>
        <v-card-text>
          <div v-if="minted">
            <p class="text-body-2 mb-3">{{ $t('servers.addHint') }}</p>
            <div class="text-center py-2">
              <div class="text-h3 font-weight-bold" style="letter-spacing: .15em" data-test="server-code">{{ minted.code }}</div>
              <v-btn variant="text" size="small" class="mt-1" @click="copy(minted.code)">
                <v-icon start size="small">mdi-content-copy</v-icon>
                {{ $t('common.copy') }}
              </v-btn>
            </div>
            <v-progress-linear
              :model-value="countdownPercent"
              :color="countdownSeconds > 60 ? 'primary' : 'warning'"
              height="6"
              rounded
              class="mb-1"
            />
            <div class="text-caption text-medium-emphasis">
              {{ countdownSeconds > 0 ? $t('servers.expiresIn', { time: countdownLabel }) : $t('servers.expired') }}
            </div>
          </div>
          <div v-else class="text-center py-6">
            <v-progress-circular indeterminate color="primary" />
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="addOpen = false">{{ $t('common.close') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- ── Bring a fenced export into the books (FR-20.84) ───────────────────────────────────── -->
    <v-dialog :model-value="!!importOpen" max-width="560" @update:model-value="v => { if (!v) importOpen = null }">
      <v-card v-if="importOpen">
        <v-card-title class="text-wrap">{{ $t('servers.fenced.import.title', { name: importOpen.nodeName || nodeName(importOpen.nodeId) }) }}</v-card-title>
        <v-card-text>
          <p class="text-body-2 mb-2">{{ $t('servers.fenced.import.intro') }}</p>
          <ul class="text-body-2 ps-4">
            <li>{{ $t('servers.fenced.import.kept') }}</li>
            <li>{{ $t('servers.fenced.import.booked') }}</li>
            <li>{{ $t('servers.fenced.import.left') }}</li>
          </ul>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="importOpen = null">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="importBusy" data-test="fenced-import-confirm" @click="startImport">{{ $t('servers.fenced.import.confirm') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- ── Promote lgrai.app's copy (FR-20.81): evidence, not a confirmation ───────────────── -->
    <v-dialog v-model="promoteOpen" max-width="620">
      <v-card>
        <v-card-title class="text-wrap">{{ $t('servers.promote.title', { org: appStore.currentOrg?.name ?? '' }) }}</v-card-title>
        <v-card-text>
          <p class="text-body-2 mb-3">{{ $t('servers.promote.intro') }}</p>
          <div v-if="!promotePre" class="text-center py-4"><v-progress-circular indeterminate color="primary" /></div>
          <template v-else>
            <v-list density="compact" class="py-0" data-test="promote-checks">
              <v-list-item v-for="c in promotePre.checks" :key="c.name">
                <template #prepend>
                  <v-icon :color="c.ok ? 'success' : 'error'" size="small">{{ c.ok ? 'mdi-check-circle' : 'mdi-close-circle' }}</v-icon>
                </template>
                <v-list-item-title class="text-body-2 text-wrap">{{ $t(`servers.promote.check.${c.name}`) }}</v-list-item-title>
                <v-list-item-subtitle v-if="!c.ok && c.detail" class="text-wrap">{{ c.detail }}</v-list-item-subtitle>
              </v-list-item>
            </v-list>
            <v-alert type="warning" variant="tonal" density="compact" class="my-3" data-test="promote-loss">
              {{ promotePre.lossFrom ? $t('servers.promote.loss', { when: new Date(promotePre.lossFrom).toLocaleString() }) : $t('servers.promote.lossUnknown') }}
              <div v-if="promotePre.files.referenced > promotePre.files.held" class="mt-1">{{ $t('servers.promote.files', { missing: promotePre.files.referenced - promotePre.files.held }) }}</div>
            </v-alert>
            <div class="text-subtitle-2">{{ $t('servers.promote.hardware') }}</div>
            <v-radio-group v-model="promoteHardware" density="compact" hide-details>
              <v-radio value="off" :label="$t('servers.promote.hardwareOff')" data-test="hardware-off" />
              <v-radio value="destroyed" :label="$t('servers.promote.hardwareDestroyed')" data-test="hardware-destroyed" />
            </v-radio-group>
            <p v-if="promoteHardware === 'off' && !promotePre.silentLongEnough" class="text-caption text-error mt-1">
              {{ $t('servers.promote.silence', { since: promotePre.silenceSince ? new Date(promotePre.silenceSince).toLocaleString() : '—' }) }}
            </p>
            <v-checkbox v-model="promoteTills" :label="$t('servers.promote.tills')" density="compact" hide-details data-test="tills-disconnected" />
            <v-text-field v-model="promoteSlug" :label="$t('servers.promote.slug', { slug: appStore.currentOrg?.slug ?? '' })" density="compact" class="mt-2" data-test="promote-slug" />
          </template>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="promoteOpen = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" :disabled="!canPromote" :loading="moveBusy" data-test="start-promote" @click="startPromote">{{ $t('servers.promote.start') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- ── Move the org here (FR-20.79): every check at once, then the move ───────────────── -->
    <v-dialog v-model="moveOpen" max-width="620">
      <v-card>
        <v-card-title class="text-wrap">{{ moveBack ? $t('servers.moveBack.title', { org: appStore.currentOrg?.name ?? '' }) : $t('servers.move.title', { org: appStore.currentOrg?.name ?? '', name: moveTarget?.name }) }}</v-card-title>
        <v-card-text>
          <p class="text-body-2 mb-3">{{ moveBack ? $t('servers.moveBack.intro') : $t('servers.move.intro') }}</p>
          <div v-if="!preflight" class="text-center py-4">
            <v-progress-circular indeterminate color="primary" />
            <div class="text-caption mt-2">{{ $t('servers.move.checking') }}</div>
          </div>
          <template v-else>
            <div class="text-subtitle-2 mb-1">{{ $t('servers.move.checksTitle') }}</div>
            <v-list density="compact" class="py-0" data-test="move-checks">
              <v-list-item v-for="c in shownChecks" :key="c.name" :data-test="'check-' + c.name">
                <template #prepend>
                  <v-icon :color="c.ok ? 'success' : 'error'" size="small">{{ c.ok ? 'mdi-check-circle' : 'mdi-close-circle' }}</v-icon>
                </template>
                <v-list-item-title class="text-body-2 text-wrap">{{ $t(`servers.${moveBack ? 'moveBack' : 'move'}.check.${c.name}`) }}</v-list-item-title>
                <v-list-item-subtitle v-if="!c.ok && c.detail" class="text-wrap">{{ c.detail }}</v-list-item-subtitle>
              </v-list-item>
            </v-list>
            <!-- A move back: files the server cannot send stop it, unless the admin leaves them behind. -->
            <template v-if="moveBack">
              <p v-if="mirror && !mirror.files" class="text-caption text-medium-emphasis mt-2">{{ $t('servers.moveBack.filesNote') }}</p>
              <v-checkbox
                v-if="filesBlocking"
                v-model="allowMissingFiles"
                :label="$t('servers.moveBack.allowMissingFiles')"
                density="compact"
                hide-details
                data-test="allow-missing-files"
              />
            </template>
            <template v-if="preflight.missingCredentials?.length">
              <div class="text-subtitle-2 mt-3">{{ $t('servers.move.missingTitle') }}</div>
              <p class="text-caption text-medium-emphasis mb-1">{{ $t('servers.move.missingHint') }}</p>
              <v-checkbox
                v-for="p in preflight.missingCredentials"
                :key="p.identityId"
                v-model="allowMissing"
                :value="p.identityId"
                :label="p.email ? `${p.name} (${p.email})` : p.name"
                density="compact"
                hide-details
                data-test="allow-missing"
              />
            </template>
          </template>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="moveOpen = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :disabled="!canStart" :loading="moveBusy" data-test="start-move" @click="startMove">{{ moveBack ? $t('servers.moveBack.start') : $t('servers.move.start') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- ── Take this org off a server ──────────────────────────────────────────────────────── -->
    <v-dialog v-model="removeOpen" max-width="520">
      <v-card>
        <v-card-title>{{ $t('servers.removeTitle', { name: removeTarget?.name }) }}</v-card-title>
        <v-card-text>
          <p class="text-body-2 mb-3">{{ $t('servers.removeHint') }}</p>
          <v-text-field
            v-model="removeReason"
            :label="$t('servers.removeReason')"
            density="compact"
            variant="outlined"
            maxlength="200"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="removeOpen = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" :loading="saving" data-test="confirm-remove" @click="handleRemove">{{ $t('servers.remove') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { announceHomeChanged } from 'ui-shared/composables/useHomeChanged'
import { useAppStore } from '../../store/app.store'

/**
 * The Servers page (FR-20.2, plan step P2-1): the shop servers (masters) registered for this org,
 * a code to register another, and taking the org off one.
 *
 * ⚠ Gated SERVER-SIDE (`admin.settings`), like the Desktops page: portal routes have no client
 * guard. On a master every `/nodes` route is 404, and the page says servers are managed on
 * lgrai.app instead of showing an error.
 *
 * A plain `v-data-table`: an org has a handful of servers, never a page of them.
 *
 * FR-20.79 (P3-6a): "Move here" on a server linked at Full runs the move's preflight (every check
 * at once, the people without a local password the admin may let through), starts it, and the
 * banner follows it to the end. The server decides everything; the page only shows it.
 */

interface ServerRow {
  id: string
  name: string
  linkLevel: 'control' | 'full'
  status: 'active' | 'revoked'
  ephemeral: boolean
  os?: { platform?: string; version?: string }
  versions?: { app?: string }
  lastSeenAt?: string
  cloneAlarm?: boolean
  connected?: { interactive: boolean; bulk: boolean }
  health?: {
    appVersion?: string
    diskFreeBytes?: number
    apiOk?: boolean
    update?: { state?: string; available?: string; reason?: string; blockedWindows?: number; alarm?: boolean }
  } | null
}

const { t, te } = useI18n()
const appStore = useAppStore()
const { showSnackbar } = useSnackbar()

const base = () => `${appStore.orgUrl()}/nodes`
const items = ref<ServerRow[]>([])
const loading = ref(false)
const includeRevoked = ref(false)
const notHere = ref(false)

const headers = computed(() => [
  { title: t('servers.name'), key: 'name' },
  { title: t('servers.linkLevelLabel'), key: 'linkLevel' },
  { title: t('servers.status'), key: 'status' },
  { title: t('servers.os'), key: 'os', sortable: false },
  { title: t('servers.version'), key: 'version', sortable: false },
  { title: t('servers.connected'), key: 'connected', sortable: false },
  { title: t('servers.health'), key: 'health', sortable: false },
  { title: t('servers.lastSeen'), key: 'lastSeenAt' },
  { title: t('servers.relays'), key: 'relays', sortable: false },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
])

/**
 * FR-20.59 (P2-6, P2-6b): whether lgrai.app sends this org's mail, and reads its documents, on the
 * server's behalf. The page says what leaves the building before either is turned on (FR-20.90).
 */
const RELAY_KINDS = ['mail', 'documents'] as const
const relayBusy = ref<string | null>(null)
async function setRelay(item: any, kind: (typeof RELAY_KINDS)[number], on: boolean) {
  relayBusy.value = `${item.id}:${kind}`
  try {
    const { data } = await httpClient.put(`${base()}/${item.id}/relays`, { [kind]: on })
    Object.assign(item, { relays: data.node?.relays })
  } finally {
    relayBusy.value = null
  }
}

/**
 * FR-20.69 (P3-3): the org's files on lgrai.app's mirror while one of its servers is its home, and
 * the org's choice to keep them there too or its records only.
 */
interface MirrorFiles {
  home: string
  files: boolean
  referenced: number
  held: number
  arriving: number
  waiting: number
  missingOnMaster: number
  failing: number
  complete: boolean
}
const mirror = ref<MirrorFiles | null>(null)
const mirrorBusy = ref(false)
async function loadMirror() {
  try {
    mirror.value = (await httpClient.get(`${base()}/mirror`)).data.mirror
  } catch {
    mirror.value = null
  }
}
async function setMirrorFiles(on: boolean) {
  mirrorBusy.value = true
  try {
    mirror.value = (await httpClient.put(`${base()}/mirror`, { files: on })).data.mirror
    showSnackbar(t('servers.files.saved'), 'success')
  } finally {
    mirrorBusy.value = false
  }
}

async function load() {
  void loadMove()
  void loadMirror()
  void loadLastNumbers()
  void loadFencedExports()
  loading.value = true
  try {
    const { data } = await httpClient.get(base(), { params: { size: 100, ...(includeRevoked.value ? { includeRevoked: 'true' } : {}) } })
    items.value = data.nodes ?? []
  } catch (e: any) {
    if (e?.response?.status === 404) notHere.value = true
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(includeRevoked, load)

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    showSnackbar(t('common.copied'), 'success')
  } catch { /* the code stays on screen */ }
}

// ── Add ─────────────────────────────────────────────────────────────────────────────────────
const addOpen = ref(false)
const minted = ref<{ id: string; code: string; expiresAt: string } | null>(null)
const countdownSeconds = ref(0)
let countdownTimer: ReturnType<typeof setInterval> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
const countdownPercent = computed(() => Math.max(0, Math.min(100, (countdownSeconds.value / 600) * 100)))
const countdownLabel = computed(() => `${Math.floor(countdownSeconds.value / 60)}:${String(countdownSeconds.value % 60).padStart(2, '0')}`)

async function openAdd() {
  minted.value = null
  addOpen.value = true
  try {
    minted.value = (await httpClient.post(`${base()}/enrollment-codes`, {})).data
  } catch {
    addOpen.value = false
    return
  }
  const expiry = new Date(minted.value!.expiresAt).getTime()
  const tick = () => { countdownSeconds.value = Math.max(0, Math.round((expiry - Date.now()) / 1000)) }
  tick()
  countdownTimer = setInterval(tick, 1000)
  // Closes by itself once the server's setup has used the code.
  pollTimer = setInterval(async () => {
    if (!minted.value) return
    try {
      const { data } = await httpClient.get(`${base()}/enrollment-codes/${minted.value.id}`)
      if (data.state === 'used') {
        showSnackbar(t('servers.registered', { name: data.usedBy ?? '' }), 'success', 6000)
        addOpen.value = false
        await load()
      }
    } catch { /* transient: the countdown keeps running */ }
  }, 3000)
}

function stopPolling() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  minted.value = null
}
onUnmounted(() => {
  stopPolling()
  if (moveTimer) { clearInterval(moveTimer); moveTimer = null }
})

// ── Move here (FR-20.79) ────────────────────────────────────────────────────────────────────
interface MoveRow { id: string; kind?: string; state: string; to: string; endedAt?: string | null; error?: string | null; waiting?: { on: string } | null }
interface Preflight { ok: boolean; checks: Array<{ name: string; ok: boolean; detail?: string }>; missingCredentials?: Array<{ identityId: string; name: string; email?: string }> }

const LIVE = ['freezing', 'copying', 'verifying', 'flipped']
const ABORTABLE = ['freezing', 'copying', 'verifying']
const moveBase = () => `${appStore.orgUrl()}/moves`
const move = ref<MoveRow | null>(null)
const moveOpen = ref(false)
const moveTarget = ref<ServerRow | null>(null)
const preflight = ref<Preflight | null>(null)
const allowMissing = ref<string[]>([])
/** FR-20.80 (P3-6c): the dialog is a move back to lgrai.app, and files may be left behind. */
const moveBack = ref(false)
const allowMissingFiles = ref(false)
const moveBusy = ref(false)
let moveTimer: ReturnType<typeof setInterval> | null = null

const nodeName = (id: string) => items.value.find(i => i.id === id)?.name ?? id
/** A live move, or one that ended within a day. */
const moveShown = computed(() => !!move.value && (LIVE.includes(move.value.state) || (!!move.value.endedAt && Date.now() - new Date(move.value.endedAt).getTime() < 24 * 3600_000)))
/** The credentials check is the admin's to settle here: every person listed, ticked. */
const shownChecks = computed(() => (preflight.value?.checks ?? []).map(c => (
  c.name === 'credentials' ? { ...c, ok: credentialsSettled.value }
    : c.name === 'files' && moveBack.value ? { ...c, ok: c.ok || allowMissingFiles.value }
      : c
)))
/** A move back that files the server cannot send stand in the way of. */
const filesBlocking = computed(() => !!preflight.value?.checks.find(c => c.name === 'files' && !c.ok))
const credentialsSettled = computed(() => (preflight.value?.missingCredentials ?? []).every(p => allowMissing.value.includes(p.identityId)))
const canStart = computed(() => !!preflight.value && shownChecks.value.every(c => c.ok))

let wasLive: boolean | null = null
async function loadMove() {
  try {
    const { data } = await httpClient.get(`${moveBase()}/current`)
    move.value = data.move
  } catch { move.value = null }
  const live = !!move.value && LIVE.includes(move.value.state)
  // A move starting or ending changes where the org is written: the banner above looks again now.
  if (wasLive !== null && live !== wasLive) announceHomeChanged()
  wasLive = live
  if (live && !moveTimer) moveTimer = setInterval(loadMove, 3000)
  if (!live && moveTimer) {
    clearInterval(moveTimer)
    moveTimer = null
    if (move.value?.state === 'done') {
      showSnackbar(move.value.kind === 'promote' ? t('servers.promote.done') : move.value.kind === 'to_global' ? t('servers.moveBack.done') : t('servers.move.done', { name: nodeName(move.value.to) }), 'success', 6000)
      // Where the org lives changed: the files card, the actions and the numbering follow.
      void loadMirror()
      void loadLastNumbers()
    }
  }
}

// ── Promote lgrai.app's copy (FR-20.81) ────────────────────────────────────────────────────
interface PromotePre {
  ok: boolean
  checks: Array<{ name: string; ok: boolean; detail?: string }>
  lossFrom: string | null
  silenceSince: string | null
  silentLongEnough: boolean
  files: { referenced: number; held: number }
}
const promoteOpen = ref(false)
const promotePre = ref<PromotePre | null>(null)
const promoteHardware = ref<'off' | 'destroyed' | null>(null)
const promoteTills = ref(false)
const promoteSlug = ref('')
const canPromote = computed(() =>
  !!promotePre.value?.ok && !!promoteHardware.value && promoteTills.value && promoteSlug.value === appStore.currentOrg?.slug
  && (promoteHardware.value === 'destroyed' || promotePre.value.silentLongEnough))

async function openPromote(item: ServerRow) {
  moveTarget.value = item
  promotePre.value = null
  promoteHardware.value = null
  promoteTills.value = false
  promoteSlug.value = ''
  promoteOpen.value = true
  try {
    promotePre.value = (await httpClient.post(`${moveBase()}/promote/preflight`, {})).data
  } catch {
    promoteOpen.value = false
  }
}

async function startPromote() {
  moveBusy.value = true
  try {
    const { data } = await httpClient.post(`${moveBase()}/promote`, { hardware: promoteHardware.value, tillsDisconnected: promoteTills.value, slug: promoteSlug.value })
    move.value = data.move
    promoteOpen.value = false
    showSnackbar(t('servers.promote.started'), 'warning')
    await loadMove()
  } catch (e: any) {
    if (e?.response?.data?.checks) promotePre.value = { ...(promotePre.value as PromotePre), checks: e.response.data.checks, ok: false }
    else showSnackbar(e?.response?.data?.message ?? t('common.operationFailed'), 'error')
  } finally {
    moveBusy.value = false
  }
}

// ── The site's last numbers, after a promotion (FR-20.81) ───────────────────────────────────
interface SeriesRow { prefix: string; year: number; last: number }
const lastNumbers = ref<{ frozen: boolean; series: SeriesRow[] } | null>(null)
const siteNumbers = ref<Record<string, number>>({})
const lastNumbersConfirmed = ref(false)
const lastNumbersBusy = ref(false)
const seriesLabel = (s: SeriesRow) => s.prefix.startsWith('UNP-')
  ? t('servers.lastNumbers.series.UNP', { device: s.prefix.slice(4) })
  : t(`servers.lastNumbers.series.${s.prefix}`, { year: s.year })

async function loadLastNumbers() {
  try {
    const { data } = await httpClient.get(`${moveBase()}/last-numbers`)
    lastNumbers.value = data
    // Offered at lgrai.app's own: a person reads the site's off its last documents and corrects them.
    siteNumbers.value = Object.fromEntries((data.series ?? []).map((s: SeriesRow) => [`${s.prefix}|${s.year}`, s.last]))
  } catch {
    lastNumbers.value = null
  }
}

async function saveLastNumbers() {
  if (!lastNumbers.value) return
  lastNumbersBusy.value = true
  try {
    const series = lastNumbers.value.series.map(s => ({ prefix: s.prefix, year: s.year, last: Math.max(0, Math.floor(Number(siteNumbers.value[`${s.prefix}|${s.year}`] ?? s.last))) }))
    await httpClient.post(`${moveBase()}/last-numbers`, { series })
    showSnackbar(t('servers.lastNumbers.saved'), 'success')
    announceHomeChanged()
    lastNumbersConfirmed.value = false
    await loadLastNumbers()
  } catch (e: any) {
    showSnackbar(e?.response?.data?.message ?? t('common.operationFailed'), 'error')
  } finally {
    lastNumbersBusy.value = false
  }
}

// ── What a replaced server did after the cutoff (FR-20.84, P3-6e) ────────────────────────────
interface FencedLegal {
  id: string
  number?: string
  type?: string
  issueDate?: string
  total?: number
  currency?: string
  onGlobal: 'absent' | 'same_id' | 'collision'
  collidesWith?: { number: string }
  imported?: { outcome: 'imported' | 'skipped' | 'failed'; reason?: string; detail?: string }
}
interface FencedExportRow {
  id: string
  nodeId: string
  nodeName: string | null
  import: { state: 'requested' | 'running' | 'done'; requestedAt: string | null; doneAt: string | null; counts: Record<string, number> | null; error: string | null } | null
  state: 'receiving' | 'received' | 'refused'
  size: number
  received: number
  receivedAt: string | null
  error: string | null
  summary: { documents: number; deleted: number; files: number; missingFiles: number; legalTruncated: boolean } | null
  legal: FencedLegal[]
  collisions: number
}
const fencedExports = ref<FencedExportRow[]>([])
const fmtDate = (v?: string | null, day = false) => (v ? (day ? new Date(v).toLocaleDateString() : new Date(v).toLocaleString()) : '—')
const docTypeLabel = (type?: string) => (type && te(`invoicing.docType.${type}`) ? t(`invoicing.docType.${type}`) : (type ?? ''))

let fencedTimer: ReturnType<typeof setTimeout> | null = null
async function loadFencedExports() {
  try {
    fencedExports.value = (await httpClient.get(`${moveBase()}/fenced-exports`)).data.exports ?? []
  } catch {
    fencedExports.value = []
  }
  // While an import runs, its outcomes come in: look again until it is done.
  if (fencedTimer) clearTimeout(fencedTimer)
  fencedTimer = fencedExports.value.some(e => e.import && e.import.state !== 'done') ? setTimeout(loadFencedExports, 4000) : null
}
onUnmounted(() => {
  if (fencedTimer) clearTimeout(fencedTimer)
})

/** The import's counts as three numbers: in the books, left for a person, not booked. */
function importCounts(counts: Record<string, number> | null) {
  const sum = (prefix: string) => Object.entries(counts ?? {}).filter(([k]) => k === prefix || k.startsWith(`${prefix}:`)).reduce((n, [, v]) => n + v, 0)
  return { imported: sum('imported'), skipped: sum('skipped'), failed: sum('failed') }
}

const importOpen = ref<FencedExportRow | null>(null)
const importBusy = ref(false)
async function startImport() {
  if (!importOpen.value) return
  importBusy.value = true
  try {
    fencedExports.value = (await httpClient.post(`${moveBase()}/fenced-exports/${importOpen.value.id}/import`, {})).data.exports ?? fencedExports.value
    importOpen.value = null
    showSnackbar(t('servers.fenced.import.started'), 'success')
    void loadFencedExports()
  } catch (e: any) {
    showSnackbar(e?.response?.data?.message ?? t('common.operationFailed'), 'error')
  } finally {
    importBusy.value = false
  }
}

async function openMoveBack(item: ServerRow) {
  moveTarget.value = item
  moveBack.value = true
  preflight.value = null
  allowMissing.value = []
  allowMissingFiles.value = false
  moveOpen.value = true
  try {
    preflight.value = (await httpClient.post(`${moveBase()}/preflight`, { to: 'global' })).data
  } catch {
    moveOpen.value = false
  }
}

async function openMove(item: ServerRow) {
  moveTarget.value = item
  moveBack.value = false
  preflight.value = null
  allowMissing.value = []
  moveOpen.value = true
  try {
    preflight.value = (await httpClient.post(`${moveBase()}/preflight`, { nodeId: item.id })).data
  } catch {
    moveOpen.value = false
  }
}

async function startMove() {
  if (!moveTarget.value) return
  moveBusy.value = true
  try {
    const { data } = await httpClient.post(`${moveBase()}/`, moveBack.value
      ? { to: 'global', allowMissingFiles: allowMissingFiles.value }
      : { nodeId: moveTarget.value.id, allowMissing: allowMissing.value })
    move.value = data.move
    moveOpen.value = false
    showSnackbar(t('servers.move.started'), 'success')
    await loadMove()
  } catch (e: any) {
    // The checks changed under the dialog: show them as the server sees them now.
    if (e?.response?.data?.checks) preflight.value = { ok: false, checks: e.response.data.checks, missingCredentials: e.response.data.missingCredentials ?? [] }
  } finally {
    moveBusy.value = false
  }
}

async function abortMove() {
  if (!move.value) return
  moveBusy.value = true
  try {
    await httpClient.post(`${moveBase()}/${move.value.id}/abort`, {})
    showSnackbar(t('servers.move.aborted'), 'success')
    await loadMove()
  } catch { /* the shared client shows the error */ } finally {
    moveBusy.value = false
  }
}

// ── Remove ──────────────────────────────────────────────────────────────────────────────────
const removeOpen = ref(false)
const removeTarget = ref<ServerRow | null>(null)
const removeReason = ref('')
const saving = ref(false)

function openRemove(item: ServerRow) {
  removeTarget.value = item
  removeReason.value = ''
  removeOpen.value = true
}

async function handleRemove() {
  if (!removeTarget.value) return
  saving.value = true
  try {
    await httpClient.post(`${base()}/${removeTarget.value.id}/revoke`, removeReason.value ? { reason: removeReason.value } : {})
    showSnackbar(t('servers.removed', { name: removeTarget.value.name }), 'success')
    removeOpen.value = false
    await load()
  } catch { /* the shared client shows the error */ } finally {
    saving.value = false
  }
}
</script>
