export interface AppInfo {
  id: string
  name: string
  icon: string
  color: string
  path: string
  description: string
  enabled: boolean
}

export interface ShellUser {
  _id: string
  username: string
  email: string
  firstName: string
  lastName: string
  role: string
}

export interface ShellOrg {
  id: string
  name: string
  slug: string
  /** The PROD / DEV marker (`Org.settings.environment`); absent = no badge. */
  environment?: 'prod' | 'dev' | string | null
}
