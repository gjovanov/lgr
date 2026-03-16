<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon variant="text" @click="router.back()"><v-icon>mdi-arrow-left</v-icon></v-btn>
      <h1 class="text-h5 ml-2">{{ $t('warehouse.bulkPriceAdjustment') || 'Bulk Price Adjustment' }}</h1>
    </div>

    <v-card>
      <v-card-text>
        <v-tabs v-model="mode">
          <v-tab value="byProductTags">{{ $t('warehouse.byProductTags') || 'By Product Tags' }}</v-tab>
          <v-tab value="byCustomPriceTags">{{ $t('warehouse.byCustomPriceTags') || 'By Custom Price Tags' }}</v-tab>
        </v-tabs>

        <v-tabs-window v-model="mode" class="mt-4">
          <!-- Mode 1: By Product Tags -->
          <v-tabs-window-item value="byProductTags">
            <p class="text-body-2 text-medium-emphasis mb-4">
              Select product tags and adjust the selling price by a percentage. Optionally adjust all custom prices too.
            </p>
            <v-row>
              <v-col cols="12" md="6">
                <TagInput v-model="productTags" type="product" :org-url="orgUrl()" label="Product Tags" />
              </v-col>
              <v-col cols="12" md="3">
                <v-text-field v-model.number="sellingPercent" label="Selling Price %" type="number" step="0.1" suffix="%" hint="Negative = decrease" persistent-hint />
              </v-col>
              <v-col cols="12" md="3">
                <v-switch v-model="alsoAdjustCustom" label="Also adjust custom prices" color="primary" />
              </v-col>
            </v-row>
            <v-row v-if="alsoAdjustCustom">
              <v-col cols="12" md="3" offset-md="6">
                <v-text-field v-model.number="customPercent" label="Custom Price %" type="number" step="0.1" suffix="%" hint="Defaults to selling %" persistent-hint />
              </v-col>
            </v-row>
          </v-tabs-window-item>

          <!-- Mode 2: By Custom Price Tags -->
          <v-tabs-window-item value="byCustomPriceTags">
            <p class="text-body-2 text-medium-emphasis mb-4">
              Select custom price tags (e.g., "loyal-customers"). Only custom prices with matching tags will be adjusted.
            </p>
            <v-row>
              <v-col cols="12" md="6">
                <TagInput v-model="customPriceTags" type="contact" :org-url="orgUrl()" label="Custom Price Tags" />
              </v-col>
              <v-col cols="12" md="3">
                <v-text-field v-model.number="customPriceTagPercent" label="Adjust %" type="number" step="0.1" suffix="%" hint="Negative = decrease" persistent-hint />
              </v-col>
            </v-row>
          </v-tabs-window-item>
        </v-tabs-window>

        <v-divider class="my-4" />

        <div class="d-flex justify-end ga-2">
          <v-btn variant="text" @click="router.back()">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="loading" :disabled="!canSubmit" @click="confirmDialog = true">
            {{ $t('warehouse.applyAdjustment') || 'Apply Adjustment' }}
          </v-btn>
        </div>
      </v-card-text>
    </v-card>

    <!-- Confirmation Dialog -->
    <v-dialog v-model="confirmDialog" max-width="450">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>
          <template v-if="mode === 'byProductTags'">
            Adjust selling price by <strong>{{ sellingPercent }}%</strong> for products tagged
            <strong>{{ productTags.join(', ') }}</strong>.
            <span v-if="alsoAdjustCustom"> Also adjust custom prices by <strong>{{ effectiveCustomPercent }}%</strong>.</span>
          </template>
          <template v-else>
            Adjust custom prices by <strong>{{ customPriceTagPercent }}%</strong> for tag
            <strong>{{ customPriceTags.join(', ') }}</strong>.
          </template>
          <p class="mt-2 text-warning" v-if="isDecrease">This is a price <strong>decrease</strong> operation.</p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="confirmDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="loading" @click="doAdjust">{{ $t('common.confirm') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Result -->
    <v-alert v-if="result" type="success" class="mt-4" closable @click:close="result = null">
      Updated <strong>{{ result.productsUpdated }}</strong> products, adjusted <strong>{{ result.pricesAdjusted }}</strong> prices.
    </v-alert>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import TagInput from 'ui-shared/components/TagInput.vue'

const router = useRouter()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const mode = ref('byProductTags')
const loading = ref(false)
const confirmDialog = ref(false)
const result = ref<{ productsUpdated: number; pricesAdjusted: number } | null>(null)

// Mode 1 state
const productTags = ref<string[]>([])
const sellingPercent = ref(0)
const alsoAdjustCustom = ref(false)
const customPercent = ref(0)

// Mode 2 state
const customPriceTags = ref<string[]>([])
const customPriceTagPercent = ref(0)

const effectiveCustomPercent = computed(() => customPercent.value || sellingPercent.value)

const isDecrease = computed(() => {
  if (mode.value === 'byProductTags') return sellingPercent.value < 0
  return customPriceTagPercent.value < 0
})

const canSubmit = computed(() => {
  if (mode.value === 'byProductTags') {
    return productTags.value.length > 0 && sellingPercent.value !== 0
  }
  return customPriceTags.value.length > 0 && customPriceTagPercent.value !== 0
})

function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

async function doAdjust() {
  loading.value = true
  try {
    const payload: any = {}
    if (mode.value === 'byProductTags') {
      payload.productTagFilters = productTags.value
      payload.sellingPricePercent = sellingPercent.value
      payload.adjustCustomPrices = alsoAdjustCustom.value
      if (alsoAdjustCustom.value) {
        payload.customPricePercent = effectiveCustomPercent.value
      }
    } else {
      payload.customPriceTagFilters = customPriceTags.value
      payload.customPricePercent = customPriceTagPercent.value
    }

    const { data } = await httpClient.post(`${orgUrl()}/warehouse/bulk-pricing/adjust`, payload)
    result.value = data
    confirmDialog.value = false
    showSuccess(`Updated ${data.productsUpdated} products, adjusted ${data.pricesAdjusted} prices`)
  } catch (e: any) {
    showError(e?.response?.data?.message || 'Operation failed')
  } finally { loading.value = false }
}
</script>
