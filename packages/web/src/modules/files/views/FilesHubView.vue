<template>
  <v-container>
    <div class="mb-6">
      <h1 class="text-h4 mb-1">{{ $t('files.hub.title') }}</h1>
      <p class="text-body-2 text-grey">{{ $t('files.hub.subtitle') }}</p>
    </div>
    <v-row>
      <v-col v-for="card in cards" :key="card.name" cols="12" sm="6" md="4">
        <v-card class="files-card" height="200" @click="router.push({ name: card.name })">
          <v-card-text class="d-flex flex-column align-center justify-center text-center" style="height: 100%">
            <v-avatar :color="card.color" size="64" class="mb-3">
              <v-icon size="32" color="white">{{ card.icon }}</v-icon>
            </v-avatar>
            <h3 class="text-h6">{{ $t(card.titleKey) }}</h3>
            <p class="text-caption text-grey mt-1">{{ $t(card.descKey) }}</p>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '../store/app.store'

const router = useRouter()
const appStore = useAppStore()

const cards = [
  { name: 'files.upload', titleKey: 'files.upload.title', descKey: 'files.upload.subtitle', icon: 'mdi-cloud-upload', color: '#607d8b' },
  { name: 'files.documents', titleKey: 'files.documents.title', descKey: 'files.documents.subtitle', icon: 'mdi-file-document-multiple', color: '#2196f3' },
  { name: 'files.audit', titleKey: 'files.audit.title', descKey: 'files.audit.subtitle', icon: 'mdi-history', color: '#8e24aa' },
  { name: 'files.archives', titleKey: 'files.archives.title', descKey: 'files.archives.subtitle', icon: 'mdi-archive-outline', color: '#546e7a' },
]

onMounted(async () => {
  if (!appStore.currentOrg?.id) await appStore.fetchProfile()
})
</script>

<style scoped>
.files-card { cursor: pointer; transition: all 0.2s ease; border: 2px solid transparent; }
.files-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15); }
</style>
