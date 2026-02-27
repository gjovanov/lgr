<template>
  <v-app>
    <v-main>
      <v-container class="legal-container py-12" style="max-width: 800px">
        <router-link to="/landing" class="text-body-2 text-primary text-decoration-none d-inline-flex align-center mb-6">
          <v-icon size="small" class="mr-1">mdi-arrow-left</v-icon>
          Back to home
        </router-link>

        <h1 class="text-h3 font-weight-bold mb-2">Terms of Service</h1>
        <p class="text-body-2 text-medium-emphasis mb-8">Last updated: February 2026</p>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">1. Introduction</h2>
          <p class="text-body-1 mb-3">
            These Terms of Service ("Terms") govern your access to and use of LGR ("Ledger"),
            an AI-powered multi-tenant ERP platform operated at <strong>lgrai.app</strong>.
            By creating an account or using LGR, you agree to be bound by these Terms.
          </p>
          <p class="text-body-1">
            If you are using LGR on behalf of an organization, you represent that you have the
            authority to bind that organization to these Terms.
          </p>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">2. Service Description</h2>
          <p class="text-body-1">
            LGR is a cloud-based ERP platform that provides accounting, invoicing, warehouse
            management, payroll, HR, CRM, and manufacturing modules. The platform supports
            multi-tenant organizations, AI-powered document recognition, cloud storage
            integrations, and multi-language support.
          </p>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">3. Eligibility</h2>
          <p class="text-body-1">
            You must be at least 18 years old and capable of entering into a legally binding
            agreement to use LGR. If you are using the service on behalf of a business entity,
            you must have the legal authority to accept these Terms on behalf of that entity.
          </p>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">4. Account Responsibilities</h2>
          <p class="text-body-1 mb-3">You are responsible for:</p>
          <ul class="text-body-1 ml-6">
            <li class="mb-1">Maintaining the confidentiality of your login credentials</li>
            <li class="mb-1">All activity that occurs under your account</li>
            <li class="mb-1">Providing accurate and up-to-date account information</li>
            <li class="mb-1">Notifying us promptly of any unauthorized access at <a href="mailto:legal@lgrai.app" class="text-primary">legal@lgrai.app</a></li>
          </ul>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">5. Multi-Tenant Terms</h2>
          <p class="text-body-1 mb-3">
            LGR operates as a multi-tenant platform where each organization's data is logically
            isolated. As an organization owner or administrator, you are responsible for:
          </p>
          <ul class="text-body-1 ml-6">
            <li class="mb-1">Managing user access and permissions within your organization</li>
            <li class="mb-1">Ensuring that invited users comply with these Terms</li>
            <li class="mb-1">The accuracy of data entered into the platform by your organization's users</li>
          </ul>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">6. Data Ownership</h2>
          <p class="text-body-1">
            You retain full ownership of all data you and your organization enter into LGR,
            including financial records, invoices, employee data, customer information, and
            inventory data. LGR does not claim any ownership rights over your data. We act
            as a data processor on your behalf. You may export or delete your data at any time.
          </p>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">7. Acceptable Use</h2>
          <p class="text-body-1 mb-3">You agree not to:</p>
          <ul class="text-body-1 ml-6">
            <li class="mb-1">Use LGR for any unlawful purpose or in violation of any applicable laws</li>
            <li class="mb-1">Attempt to gain unauthorized access to other organizations' data</li>
            <li class="mb-1">Interfere with or disrupt the platform's infrastructure</li>
            <li class="mb-1">Reverse-engineer, decompile, or disassemble the platform</li>
            <li class="mb-1">Use automated tools to scrape or extract data from the platform</li>
            <li class="mb-1">Upload malicious content, viruses, or harmful code</li>
            <li class="mb-1">Resell or sublicense access to the platform without written consent</li>
          </ul>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">8. Intellectual Property</h2>
          <p class="text-body-1">
            The LGR platform, including its source code, design, logos, trademarks, and
            documentation, is the intellectual property of LGR (Ledger) and is protected by
            applicable intellectual property laws. These Terms do not grant you any rights to
            use our trademarks, logos, or branding without prior written consent.
          </p>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">9. Billing and Subscriptions</h2>
          <p class="text-body-1 mb-3">
            LGR offers the following subscription plans:
          </p>
          <ul class="text-body-1 ml-6 mb-3">
            <li class="mb-1"><strong>Free</strong> - 3 users, 2 modules, 100 records per module, basic reporting</li>
            <li class="mb-1"><strong>Pro ($12/user/month)</strong> - Unlimited users, all 7 modules, AI recognition, cloud storage, unlimited records</li>
            <li class="mb-1"><strong>Enterprise ($29/user/month)</strong> - Everything in Pro plus custom roles, advanced permissions, audit log, multi-language, priority support</li>
          </ul>
          <p class="text-body-1 mb-3">
            All payments are processed by <strong>Stripe</strong>. By subscribing to a paid plan,
            you authorize Stripe to charge your payment method on a recurring basis. You may
            cancel your subscription at any time; access to paid features will continue until the
            end of the current billing period.
          </p>
          <p class="text-body-1">
            We reserve the right to change pricing with 30 days' notice. Price changes will
            not apply to the current billing period.
          </p>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">10. Termination</h2>
          <p class="text-body-1 mb-3">
            You may terminate your account at any time by contacting us or using the account
            deletion feature. We may suspend or terminate your access if:
          </p>
          <ul class="text-body-1 ml-6">
            <li class="mb-1">You violate these Terms</li>
            <li class="mb-1">Your payment is overdue for more than 30 days</li>
            <li class="mb-1">We are required to do so by law</li>
            <li class="mb-1">We discontinue the service (with at least 90 days' notice)</li>
          </ul>
          <p class="text-body-1 mt-3">
            Upon termination, your data will be retained for 30 days to allow export, after
            which it will be permanently deleted.
          </p>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">11. Disclaimers</h2>
          <p class="text-body-1 mb-3">
            LGR is provided on an <strong>"as is"</strong> and <strong>"as available"</strong>
            basis. To the maximum extent permitted by law, we disclaim all warranties, express
            or implied, including warranties of merchantability, fitness for a particular purpose,
            and non-infringement.
          </p>
          <p class="text-body-1">
            While LGR includes accounting and financial tools, it is not a substitute for
            professional accounting, tax, or legal advice. You are responsible for ensuring
            your use of LGR complies with applicable financial regulations in your jurisdiction.
          </p>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">12. Limitation of Liability</h2>
          <p class="text-body-1">
            To the maximum extent permitted by law, LGR (Ledger) and its officers, employees,
            and affiliates shall not be liable for any indirect, incidental, special,
            consequential, or punitive damages, including but not limited to loss of profits,
            data, business, or goodwill, arising from your use of or inability to use the
            platform. Our total liability for any claim arising from these Terms shall not
            exceed the amount you have paid us in the 12 months preceding the claim.
          </p>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">13. Governing Law</h2>
          <p class="text-body-1">
            These Terms shall be governed by and construed in accordance with the laws of the
            European Union and the applicable member state where the service operator is
            established. Any disputes arising from these Terms shall be resolved in the
            competent courts of that jurisdiction.
          </p>
        </section>

        <section class="mb-8">
          <h2 class="text-h5 font-weight-bold mb-3">14. Changes to These Terms</h2>
          <p class="text-body-1">
            We reserve the right to update these Terms at any time. We will notify you of
            material changes by posting the updated Terms on this page and updating the
            "Last updated" date. If changes are significant, we will also notify you via
            email. Continued use of LGR after changes take effect constitutes acceptance of
            the revised Terms.
          </p>
        </section>

        <section>
          <h2 class="text-h5 font-weight-bold mb-3">15. Contact Us</h2>
          <p class="text-body-1">
            If you have questions about these Terms of Service, please contact us at
            <a href="mailto:legal@lgrai.app" class="text-primary">legal@lgrai.app</a>.
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
