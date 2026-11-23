<template>
  <!-- Keyed on the document (FR-22.16): a different proforma in this same view mounts a fresh form,
       a new one the form just saved keeps it (`adopt`). -->
  <DocumentForm :key="formKey" :config="DOCUMENT_CONFIGS.proforma" @created="adopt" />
</template>

<script setup lang="ts">
import DocumentForm from '../components/document-form/DocumentForm.vue'
import { DOCUMENT_CONFIGS } from '../composables/document-form/configs'
import { useDocumentRouteKey } from '../composables/document-form/useDocumentRouteKey'

const { formKey, adopt } = useDocumentRouteKey()
</script>
