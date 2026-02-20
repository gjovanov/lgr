export interface AppInfo {
  id: string
  name: string
  icon: string
  color: string
  port: number
  uiPort: number
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
}
