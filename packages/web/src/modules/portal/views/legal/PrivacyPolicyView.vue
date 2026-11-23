<template>
  <v-app>
    <v-main>
      <v-container class="legal-container py-12" style="max-width: 800px">
        <router-link to="/landing" class="text-body-2 text-primary text-decoration-none d-inline-flex align-center mb-6">
          <v-icon size="small" class="mr-1">mdi-arrow-left</v-icon>
          Back to home
        </router-link>

        <h1 class="text-h3 font-weight-bold mb-2">Privacy Policy</h1>
        <p class="text-body-2 text-medium-emphasis mb-8">Last updated: February 2026</p>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">1. Introduction</h2>
          <p class="text-body-1 mb-3">
            LGR ("Ledger") is an AI-powered multi-tenant ERP platform providing accounting, invoicing,
            warehouse management, payroll, HR, CRM, and manufacturing modules for growing businesses.
            This Privacy Policy explains how we collect, use, store, and protect your personal data
            when you use our platform at <strong>lgrai.app</strong>.
          </p>
          <p class="text-body-1">
            By using LGR, you agree to the practices described in this policy. If you do not agree,
            please do not use the service.
          </p>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">2. Data We Collect</h2>

          <h3 class="text-h6 font-weight-bold mb-2">2.1 Account Information</h3>
          <p class="text-body-1 mb-4">
            When you register, we collect your email address, full name, and username. This data is
            required to create and manage your account.
          </p>

          <h3 class="text-h6 font-weight-bold mb-2">2.2 Organization and Business Data</h3>
          <p class="text-body-1 mb-4">
            Depending on which modules you use, LGR may store the following on your behalf:
            financial records and journal entries, invoices and payment records, employee and payroll
            data, customer and contact information (CRM), warehouse inventory and stock movements,
            and HR records including leave and timesheets. You are the data controller for this
            information; LGR acts as a data processor.
          </p>

          <h3 class="text-h6 font-weight-bold mb-2">2.3 OAuth / Social Sign-In Data</h3>
          <p class="text-body-1 mb-4">
            When you sign in using Google, Facebook, GitHub, or LinkedIn, we receive your email
            address, display name, and profile picture from the provider. We do not receive or
            store your password from these services.
          </p>

          <h3 class="text-h6 font-weight-bold mb-2">2.4 Billing Data</h3>
          <p class="text-body-1 mb-4">
            Payments are processed by <strong>Stripe</strong>. We do not store your credit card
            numbers, CVV, or full card details on our servers. Stripe provides us with a tokenized
            reference, your billing email, and subscription status. Please refer to
            <a href="https://stripe.com/privacy" target="_blank" rel="noopener" class="text-primary">Stripe's Privacy Policy</a>
            for details on how they handle your payment information.
          </p>

          <h3 class="text-h6 font-weight-bold mb-2">2.5 Usage and Technical Data</h3>
          <p class="text-body-1">
            We may collect IP addresses, browser type, operating system, and pages visited for
            analytics and security purposes.
          </p>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">3. Cookies and Local Storage</h2>
          <p class="text-body-1">
            LGR uses a JWT authentication token stored in your browser's <strong>localStorage</strong>
            to maintain your session. We do not use third-party tracking cookies. No advertising
            cookies are set.
          </p>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">4. How We Use Your Data</h2>
          <p class="text-body-1 mb-3">We use the data we collect to:</p>
          <ul class="text-body-1 ml-6 mb-3">
            <li class="mb-1">Provide, operate, and maintain the LGR platform</li>
            <li class="mb-1">Authenticate your identity and manage your account</li>
            <li class="mb-1">Process billing and manage subscriptions</li>
            <li class="mb-1">Provide customer support</li>
            <li class="mb-1">Send service-related communications (e.g., security alerts, billing notices)</li>
            <li class="mb-1">Improve and develop new features</li>
            <li class="mb-1">Comply with legal obligations</li>
          </ul>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">5. Multi-Tenant Data Isolation</h2>
          <p class="text-body-1">
            LGR is a multi-tenant platform. Each organization's data is logically isolated at the
            database level. Users from one organization cannot access data belonging to another
            organization. All API requests are scoped to the authenticated user's current
            organization context.
          </p>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">6. Data Sharing</h2>
          <p class="text-body-1 mb-3">We do not sell your personal data. We may share data with:</p>
          <ul class="text-body-1 ml-6">
            <li class="mb-1"><strong>Stripe</strong> for payment processing</li>
            <li class="mb-1"><strong>OAuth providers</strong> (Google, Facebook, GitHub, LinkedIn) during authentication</li>
            <li class="mb-1"><strong>Law enforcement</strong> when required by law or valid legal process</li>
          </ul>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">7. Data Retention</h2>
          <p class="text-body-1">
            We retain your account data for as long as your account is active. Organization and
            business data is retained for the duration of the organization's subscription. Upon
            account or organization deletion, your data is permanently removed from our systems
            within 30 days. Backups containing deleted data are purged within 90 days.
          </p>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">8. Security</h2>
          <p class="text-body-1">
            We employ industry-standard security measures including encryption in transit (TLS),
            hashed passwords, scoped API access, and regular security reviews. While no system
            is 100% secure, we take reasonable precautions to protect your data.
          </p>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">9. Your Rights (GDPR)</h2>
          <p class="text-body-1 mb-3">If you are located in the European Economic Area, you have the right to:</p>
          <ul class="text-body-1 ml-6">
            <li class="mb-1"><strong>Access</strong> the personal data we hold about you</li>
            <li class="mb-1"><strong>Rectify</strong> inaccurate or incomplete data</li>
            <li class="mb-1"><strong>Erase</strong> your personal data ("right to be forgotten")</li>
            <li class="mb-1"><strong>Restrict</strong> processing of your data</li>
            <li class="mb-1"><strong>Port</strong> your data to another service</li>
            <li class="mb-1"><strong>Object</strong> to processing of your data</li>
          </ul>
          <p class="text-body-1 mt-3">
            To exercise any of these rights, please contact us at
            <a href="mailto:privacy@lgrai.app" class="text-primary">privacy@lgrai.app</a>.
          </p>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">10. Changes to This Policy</h2>
          <p class="text-body-1">
            We may update this Privacy Policy from time to time. We will notify you of material
            changes by posting the updated policy on this page and updating the "Last updated"
            date. Continued use of LGR after changes constitutes acceptance of the revised policy.
          </p>
        </section>

        <section>
          <h2 class="text-h5 font-weight-bold mb-3">11. Contact Us</h2>
          <p class="text-body-1">
            If you have questions or concerns about this Privacy Policy, please contact us at
            <a href="mailto:privacy@lgrai.app" class="text-primary">privacy@lgrai.app</a>.
          </p>
        </section>
      </v-container>
    </v-main>
  </v-app>
</template>

<script setup lang="ts">
</script>

<style scoped>
.legal-container {
  line-height: 1.7;
}
</style>
