# Org

## Entity Interface

```typescript
interface IOrgSettings {
  baseCurrency: string
  fiscalYearStart: number
  dateFormat: string
  timezone: string
  locale: string
  taxConfig: {
    vatEnabled: boolean
    defaultVatRate: number
    vatRates: { name: string; rate: number }[]
    taxIdLabel: string
  }
  payroll: {
    payFrequency: string
    socialSecurityRate: number
    healthInsuranceRate: number
    pensionRate: number
  }
  modules: string[]
  integrations?: {
    googleDrive?: { accessToken: string; refreshToken: string; expiresAt: Date; email: string }
    onedrive?: { accessToken: string; refreshToken: string; expiresAt: Date; email: string }
    dropbox?: { accessToken: string; refreshToken: string; expiresAt: Date; email: string }
  }
}

interface IOrgSubscription {
  plan: string
  maxUsers: number
  expiresAt?: Date
  stripeCustomerId?: string
  stripeSubscriptionId?: string
  status: string
  currentPeriodEnd?: Date
  cancelAtPeriodEnd: boolean
}

interface IOrg extends Document {
  _id: Types.ObjectId
  name: string
  slug: string
  description?: string
  logo?: string
  ownerId: Types.ObjectId
  // the company's identity, as its documents print it
  taxNumber?: string
  vatNumber?: string
  email?: string
  phone?: string
  website?: string
  representative?: string   // FR-25a: МОЛ / управител
  placeOfIssue?: string     // FR-25a: `Място на сделката`
  activityCode?: string     // FR-25a: КИД/НКИД
  addresses?: IOrgAddress[]
  bankDetails?: IOrgBankDetail[]
  settings: IOrgSettings
  subscription: IOrgSubscription
  createdAt: Date
  updatedAt: Date
}
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| name | string | Yes | - | Organization display name |
| slug | string | Yes (unique) | - | URL-friendly identifier for login and routing |
| description | string | No | - | Organization description |
| logo | string | No | - | URL or path to organization logo |
| ownerId | string (ObjectId) | Yes | - | References the User who owns this org |
| taxNumber, vatNumber, email, phone, website | string | No | - | The company's identity, as its documents print it. Settings → Organization → Company Identity |
| representative | string | No | - | FR-25a. The person legally responsible for the company (МОЛ / управител). `PUT /org/:orgId`, returned by `GET /org/:orgId` and `/auth/me` |
| placeOfIssue | string | No | - | FR-25a. Where the company's documents are issued (`Място на сделката`), a town. One value for every document the accountant's books hold, so it is the company's, not a document's (an invoice keeps its own in `placeOfTransaction`) |
| activityCode | string | No | - | FR-25a. The economic activity code (КИД/НКИД) |
| addresses, bankDetails | array | No | `[]` | The company's addresses and bank accounts |
| settings | JSON (IOrgSettings) | Yes | `{}` | Organization settings (see interface above) |
| settings.baseCurrency | string | Yes | `'EUR'` | ISO currency code |
| settings.fiscalYearStart | number | Yes | `1` | Month number (1-12) when fiscal year starts |
| settings.dateFormat | string | Yes | `'DD.MM.YYYY'` | Date display format |
| settings.timezone | string | Yes | `'Europe/Berlin'` | IANA timezone |
| settings.locale | string | Yes | `'en'` | UI locale code |
| settings.taxConfig | object | Yes | see defaults | Tax configuration |
| settings.payroll | object | Yes | see defaults | Payroll rate configuration |
| settings.modules | string[] | Yes | `[]` | Enabled module identifiers |
| settings.integrations | object | No | - | Cloud storage OAuth tokens |
| subscription | JSON (IOrgSubscription) | Yes | `{}` | Subscription and billing state |
| subscription.plan | string | Yes | `'free'` | Plan tier (free, starter, professional, enterprise) |
| subscription.maxUsers | number | Yes | `3` | Maximum users allowed under this plan |
| subscription.expiresAt | Date | No | - | Plan expiration date |
| subscription.stripeCustomerId | string | No | - | Stripe customer ID |
| subscription.stripeSubscriptionId | string | No | - | Stripe subscription ID |
| subscription.status | string | Yes | `'active'` | Subscription status |
| subscription.currentPeriodEnd | Date | No | - | Current billing period end |
| subscription.cancelAtPeriodEnd | boolean | Yes | `false` | Whether to cancel at period end |
| createdAt | Date | Yes | auto | Creation timestamp |
| updatedAt | Date | Yes | auto | Last update timestamp |

## Relationships

| Direction | Entity | Description |
|-----------|--------|-------------|
| hasMany | User | Users belonging to this organization |
| hasMany | Invite | Invitations issued for this organization |
| hasMany | OrgApp | Apps activated for this organization |

## API Endpoints

**Cloud API prefix:** `/api/org/:orgId`
**Desktop API:** same endpoints at port 4080

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/org/:orgId` | Get organization details | Signed in |
| PUT | `/api/org/:orgId` | Update organization (name, description, logo, settings) | Admin only |

Note: Org is a BaseEntity -- it does not have an `orgId` foreign key. It is the root tenant entity.
