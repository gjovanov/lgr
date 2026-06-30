<template>
  <DocumentForm :config="DOCUMENT_CONFIGS.proforma" />
</template>

<script setup lang="ts">
import DocumentForm from '../components/document-form/DocumentForm.vue'
import { DOCUMENT_CONFIGS } from '../composables/document-form/configs'
</script>
