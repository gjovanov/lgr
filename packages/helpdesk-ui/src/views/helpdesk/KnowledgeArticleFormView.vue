<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <v-btn icon="mdi-arrow-left" variant="text" @click="$router.back()" />
      <h1 class="text-h5 ml-2">{{ isEdit ? t('helpdesk.editArticle') : t('helpdesk.newArticle') }}</h1>
      <v-spacer />
      <v-btn v-if="isEdit && article && !article.isPublished" color="success" variant="tonal" @click="doPublish">
        <v-icon start>mdi-publish</v-icon>{{ t('helpdesk.publish') }}
      </v-btn>
      <v-chip v-if="article?.isPublished" color="success" class="ml-2">{{ t('helpdesk.published') }}</v-chip>
    </div>

    <v-card>
      <v-card-text>
        <v-form ref="formRef">
          <v-row>
            <v-col cols="12" md="8">
              <v-text-field v-model="form.name" :label="t('common.name')" :rules="[rules.required]" />
            </v-col>
            <v-col cols="12" md="4">
              <v-select v-model="form.accessLevel" :label="t('helpdesk.accessLevel')" :items="accessLevels" />
            </v-col>
            <v-col cols="12">
              <v-textarea v-model="form.content" :label="t('helpdesk.content')" rows="12" auto-grow />
            </v-col>
            <v-col cols="12" md="6">
              <v-autocomplete
                v-model="form.parentId"
                :label="t('helpdesk.parentArticle')"
                :items="otherArticles"
                item-title="name"
                :item-value="(a: any) => a._id || a.id"
                clearable
              />
            </v-col>
            <v-col cols="12" md="6">
              <TagInput v-model="form.tags" type="knowledge" :org-url="appStore.orgUrl()" />
            </v-col>
          </v-row>
        </v-form>
      </v-card-text>
      <v-card-actions>
        <div v-if="article" class="text-caption text-medium-emphasis ml-4">
          v{{ article.version }}
        </div>
        <v-spacer />
        <v-btn @click="$router.back()">{{ t('common.cancel') }}</v-btn>
        <v-btn color="primary" :loading="store.loading" @click="save">{{ t('common.save') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../../store/app.store'
import { useHelpdeskStore } from '../../store/helpdesk.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import TagInput from 'ui-shared/components/TagInput.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const store = useHelpdeskStore()
const { showSuccess, showError } = useSnackbar()

const formRef = ref()
const isEdit = computed(() => !!route.params.id)
const article = ref<any>(null)
const otherArticles = ref<any[]>([])

const accessLevels = ['internal', 'public', 'restricted']

const emptyForm = () => ({
  name: '',
  content: '',
  parentId: '',
  accessLevel: 'internal',
  tags: [] as string[],
})
const form = ref(emptyForm())

const rules = { required: (v: any) => (v !== '' && v !== null && v !== undefined) || t('validation.required') }

async function fetchLookups() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/helpdesk/knowledge`, { params: { size: 200 } })
    otherArticles.value = (data.articles || []).filter((a: any) => (a._id || a.id) !== route.params.id)
  } catch { /* */ }
}

async function loadArticle() {
  if (!isEdit.value) return
  try {
    article.value = await store.fetchKnowledgeArticle(route.params.id as string)
    form.value = {
      name: article.value.name || '',
      content: article.value.content || '',
      parentId: article.value.parentId || '',
      accessLevel: article.value.accessLevel || 'internal',
      tags: article.value.tags || [],
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function save() {
  const { valid } = await formRef.value.validate()
  if (!valid) return
  try {
    if (isEdit.value) {
      article.value = await store.updateKnowledgeArticle(route.params.id as string, form.value)
    } else {
      const created = await store.createKnowledgeArticle(form.value)
      router.replace({ name: 'helpdesk.knowledge.edit', params: { id: created._id || created.id } })
      article.value = created
    }
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

async function doPublish() {
  try {
    article.value = await store.publishKnowledgeArticle(route.params.id as string)
    showSuccess(t('common.savedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(async () => {
  await fetchLookups()
  await loadArticle()
})
</script>
