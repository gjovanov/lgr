<template>
  <v-container fluid>
    <v-row justify="center" class="mt-8">
      <v-col cols="12" md="8" lg="6">
        <v-card class="text-center pa-8" elevation="2">
          <v-icon size="80" color="#5C6BC0" class="mb-4">mdi-file-document-multiple</v-icon>
          <h1 class="text-h4 mb-2">Documents</h1>
          <p class="text-body-1 text-grey mb-6">Document management, workspaces, e-signatures</p>
          <v-chip color="info" variant="tonal" class="mb-4">
            <v-icon start>mdi-api</v-icon>
            API Ready
          </v-chip>
          <p class="text-body-2 text-grey-darken-1">
            The API for this module is fully operational. The UI is coming soon.
          </p>
          <v-btn
            class="mt-6"
            color="primary"
            variant="tonal"
            href="/"
            prepend-icon="mdi-arrow-left"
          >
            Back to App Hub
          </v-btn>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>
