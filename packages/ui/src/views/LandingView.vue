<template>
  <div class="landing-page">
    <!-- Navbar -->
    <v-app-bar flat color="transparent" class="landing-nav">
      <v-toolbar-title class="font-weight-bold text-h5">
        <span class="text-primary">LGR</span>
      </v-toolbar-title>
      <v-spacer />
      <v-btn variant="text" href="#features">Features</v-btn>
      <v-btn variant="text" href="#pricing">Pricing</v-btn>
      <v-btn variant="outlined" color="primary" :to="{ name: 'auth.login' }" class="mx-2">Log In</v-btn>
      <v-btn color="primary" :to="{ name: 'auth.register' }">Get Started Free</v-btn>
    </v-app-bar>

    <!-- Hero -->
    <section class="hero-section">
      <v-container>
        <v-row align="center" justify="center">
          <v-col cols="12" md="8" class="text-center">
            <h1 class="text-h2 font-weight-bold mb-4">AI-powered ERP<br/>for <span class="text-primary">growing businesses</span></h1>
            <p class="text-h6 text-medium-emphasis mb-8">Accounting, invoicing, warehouse, payroll, HR, CRM, and manufacturing — 48 data models, 7 modules, one platform.</p>
            <v-btn color="primary" size="x-large" :to="{ name: 'auth.register' }" class="mr-4 px-8">Start Free</v-btn>
            <v-btn variant="outlined" size="x-large" href="#pricing" class="px-8">View Plans</v-btn>
          </v-col>
        </v-row>
      </v-container>
    </section>

    <!-- Trust bar -->
    <section class="trust-section py-8">
      <v-container>
        <p class="text-center text-body-2 text-medium-emphasis mb-4">Built for businesses that need a complete ERP</p>
        <v-row justify="center" align="center">
          <v-col v-for="stat in stats" :key="stat.label" cols="6" sm="3" class="text-center">
            <div class="text-h4 font-weight-bold text-primary">{{ stat.value }}</div>
            <div class="text-body-2 text-medium-emphasis">{{ stat.label }}</div>
          </v-col>
        </v-row>
      </v-container>
    </section>

    <!-- Features -->
    <section id="features" class="features-section py-16">
      <v-container>
        <h2 class="text-h3 text-center font-weight-bold mb-2">A complete ERP suite</h2>
        <p class="text-center text-body-1 text-medium-emphasis mb-12">From accounting to manufacturing, every module your business needs</p>
        <v-row>
          <v-col v-for="feature in features" :key="feature.title" cols="12" sm="6" md="4">
            <v-card variant="outlined" class="feature-card pa-6 h-100" rounded="lg">
              <v-icon :color="feature.color" size="48" class="mb-4">{{ feature.icon }}</v-icon>
              <h3 class="text-h6 font-weight-bold mb-2">{{ feature.title }}</h3>
              <p class="text-body-2 text-medium-emphasis">{{ feature.description }}</p>
            </v-card>
          </v-col>
        </v-row>
      </v-container>
    </section>

    <!-- Pricing -->
    <section id="pricing" class="pricing-section py-16">
      <v-container>
        <h2 class="text-h3 text-center font-weight-bold mb-2">Simple, transparent pricing</h2>
        <p class="text-center text-body-1 text-medium-emphasis mb-12">Start free, unlock the full ERP when you are ready</p>
        <v-row justify="center">
          <v-col v-for="plan in plans" :key="plan.name" cols="12" sm="6" md="4">
            <v-card
              :variant="plan.popular ? 'elevated' : 'outlined'"
              :elevation="plan.popular ? 8 : 0"
              class="pa-6 h-100 d-flex flex-column"
              rounded="lg"
              :class="{ 'border-primary': plan.popular }"
            >
              <v-chip v-if="plan.popular" color="primary" size="small" class="mb-4 align-self-start">Most Popular</v-chip>
              <h3 class="text-h5 font-weight-bold">{{ plan.name }}</h3>
              <div class="my-4">
                <span class="text-h3 font-weight-bold">${{ plan.price }}</span>
                <span v-if="plan.price > 0" class="text-body-2 text-medium-emphasis">/user/mo</span>
                <span v-else class="text-body-2 text-medium-emphasis">forever</span>
              </div>
              <v-divider class="mb-4" />
              <v-list density="compact" class="flex-grow-1 bg-transparent">
                <v-list-item v-for="f in plan.features" :key="f" :title="f" prepend-icon="mdi-check" />
              </v-list>
              <v-btn
                :color="plan.popular ? 'primary' : undefined"
                :variant="plan.popular ? 'flat' : 'outlined'"
                block
                size="large"
                :to="{ name: 'auth.register' }"
                class="mt-4"
              >
                {{ plan.price === 0 ? 'Get Started Free' : 'Start Free Trial' }}
              </v-btn>
            </v-card>
          </v-col>
        </v-row>
      </v-container>
    </section>

    <!-- Final CTA -->
    <section class="cta-section py-16">
      <v-container>
        <v-row justify="center">
          <v-col cols="12" md="8" class="text-center">
            <h2 class="text-h3 font-weight-bold mb-4 text-white">Ready to streamline your business?</h2>
            <p class="text-body-1 cta-subtitle mb-8">Join growing businesses already running on LGR.</p>
            <v-btn color="white" size="x-large" :to="{ name: 'auth.register' }" class="px-8 text-primary">Launch Your ERP — Free</v-btn>
          </v-col>
        </v-row>
      </v-container>
    </section>

    <!-- Footer -->
    <v-footer class="landing-footer py-8">
      <v-container>
        <v-row>
          <v-col cols="12" sm="4">
            <div class="text-h6 font-weight-bold mb-2">LGR (Ledger)</div>
            <p class="text-body-2 text-medium-emphasis">AI-powered ERP for growing businesses.</p>
          </v-col>
          <v-col cols="6" sm="2">
            <div class="text-subtitle-2 font-weight-bold mb-2">Product</div>
            <div class="text-body-2 text-medium-emphasis mb-1">Features</div>
            <div class="text-body-2 text-medium-emphasis mb-1">Pricing</div>
            <div class="text-body-2 text-medium-emphasis mb-1">Security</div>
          </v-col>
          <v-col cols="6" sm="2">
            <div class="text-subtitle-2 font-weight-bold mb-2">Company</div>
            <div class="text-body-2 text-medium-emphasis mb-1">About</div>
            <div class="text-body-2 text-medium-emphasis mb-1">Blog</div>
            <div class="text-body-2 text-medium-emphasis mb-1">Careers</div>
          </v-col>
          <v-col cols="12" sm="4">
            <div class="text-subtitle-2 font-weight-bold mb-2">Legal</div>
            <div class="text-body-2 text-medium-emphasis mb-1">Privacy Policy</div>
            <div class="text-body-2 text-medium-emphasis mb-1">Terms of Service</div>
          </v-col>
        </v-row>
        <v-divider class="my-4" />
        <div class="text-body-2 text-medium-emphasis text-center">&copy; {{ new Date().getFullYear() }} LGR (Ledger). All rights reserved.</div>
      </v-container>
    </v-footer>
  </div>
</template>

<script setup lang="ts">
interface Stat {
  value: string
  label: string
}

interface Feature {
  icon: string
  title: string
  description: string
  color: string
}

interface Plan {
  name: string
  price: number
  popular: boolean
  features: string[]
}

const stats: Stat[] = [
  { value: '48', label: 'Data Models' },
  { value: '7', label: 'ERP Modules' },
  { value: '4', label: 'Languages' },
  { value: '99.9%', label: 'Uptime' },
]

const features: Feature[] = [
  {
    icon: 'mdi-calculator-variant-outline',
    title: 'Accounting & Finance',
    description: 'Chart of accounts, journal entries, fiscal years, bank reconciliation, tax returns.',
    color: '#2E7D32',
  },
  {
    icon: 'mdi-receipt-text-outline',
    title: 'Invoicing & Payments',
    description: 'Sales, purchase, proforma, credit notes with automated payment tracking.',
    color: '#1565C0',
  },
  {
    icon: 'mdi-warehouse',
    title: 'Warehouse & Inventory',
    description: 'Multi-warehouse stock management, movements, inventory counts, price lists.',
    color: '#2E7D32',
  },
  {
    icon: 'mdi-account-tie-outline',
    title: 'HR & Payroll',
    description: 'Employee management, payroll runs, payslips, leave management, timesheets.',
    color: '#1565C0',
  },
  {
    icon: 'mdi-brain',
    title: 'AI Document Recognition',
    description: 'Upload documents and let Claude AI extract, categorize, and file them automatically.',
    color: '#2E7D32',
  },
  {
    icon: 'mdi-cloud-sync-outline',
    title: 'Cloud Storage',
    description: 'Sync with Google Drive, OneDrive, Dropbox. Export to Excel and PDF.',
    color: '#1565C0',
  },
]

const plans: Plan[] = [
  {
    name: 'Free',
    price: 0,
    popular: false,
    features: [
      '3 users',
      '2 modules',
      '100 records/module',
      'Basic reporting',
      'Community support',
    ],
  },
  {
    name: 'Pro',
    price: 12,
    popular: true,
    features: [
      'Unlimited users',
      'All 7 modules',
      'AI recognition',
      'Cloud storage',
      'Unlimited records',
      'Excel + PDF export',
    ],
  },
  {
    name: 'Enterprise',
    price: 29,
    popular: false,
    features: [
      'Everything in Pro',
      'Custom roles',
      'Advanced permissions',
      'Audit log',
      'Multi-language',
      'Priority support',
    ],
  },
]
</script>

<style scoped>
.landing-page {
  background: linear-gradient(180deg, #f5faf5 0%, #ffffff 40%);
}

.landing-nav {
  position: fixed !important;
  z-index: 100;
  backdrop-filter: blur(12px);
  background: rgba(255, 255, 255, 0.85) !important;
  border-bottom: 1px solid rgba(46, 125, 50, 0.08);
}

.hero-section {
  padding-top: 140px;
  padding-bottom: 80px;
  background: linear-gradient(135deg, #e8f5e9 0%, #e0f2f1 50%, #e8eaf6 100%);
  position: relative;
  overflow: hidden;
}

.hero-section::before {
  content: '';
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: radial-gradient(circle at 30% 70%, rgba(46, 125, 50, 0.06) 0%, transparent 50%),
              radial-gradient(circle at 70% 30%, rgba(21, 101, 192, 0.06) 0%, transparent 50%);
  animation: float 20s ease-in-out infinite;
}

@keyframes float {
  0%, 100% { transform: translate(0, 0); }
  50% { transform: translate(-2%, 2%); }
}

.trust-section {
  background: #fafafa;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.features-section {
  background: #ffffff;
}

.feature-card {
  transition: transform 0.2s ease, box-shadow 0.2s ease;
  border-color: rgba(0, 0, 0, 0.08) !important;
}

.feature-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 12px 40px rgba(46, 125, 50, 0.12) !important;
}

.pricing-section {
  background: linear-gradient(180deg, #f5f5f5 0%, #fafafa 100%);
}

.border-primary {
  border: 2px solid #2E7D32 !important;
}

.cta-section {
  background: linear-gradient(135deg, #2E7D32 0%, #1565C0 100%);
  position: relative;
  overflow: hidden;
}

.cta-section::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: radial-gradient(circle at 20% 80%, rgba(255, 255, 255, 0.1) 0%, transparent 50%),
              radial-gradient(circle at 80% 20%, rgba(255, 255, 255, 0.08) 0%, transparent 50%);
}

.cta-subtitle {
  color: rgba(255, 255, 255, 0.85);
}

.landing-footer {
  background: #fafafa !important;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
}
</style>
