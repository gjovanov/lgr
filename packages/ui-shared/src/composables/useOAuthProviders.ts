import { ref } from 'vue'
import { httpClient } from './useHttpClient'

/**
 * The sign-in buttons a login page shows: only the providers this deployment has credentials for
 * (`GET /api/oauth/providers`). A button for an unconfigured provider would lead to an error page.
 */

export interface OAuthProviderButton {
  name: string
  label: string
  icon: string
  color: string
}

const DISPLAY: Record<string, Omit<OAuthProviderButton, 'name'>> = {
  google: { label: 'Google', icon: 'mdi-google', color: '#DB4437' },
  microsoft: { label: 'Microsoft', icon: 'mdi-microsoft', color: '#00A4EF' },
  github: { label: 'GitHub', icon: 'mdi-github', color: '#333' },
  linkedin: { label: 'LinkedIn', icon: 'mdi-linkedin', color: '#0077B5' },
  facebook: { label: 'Facebook', icon: 'mdi-facebook', color: '#4267B2' },
}

export function useOAuthProviders() {
  const providers = ref<OAuthProviderButton[]>([])
  const loaded = ref(false)

  async function load() {
    try {
      const { data } = await httpClient.get('/oauth/providers')
      const names: string[] = Array.isArray(data?.providers) ? data.providers : []
      providers.value = names.filter(n => DISPLAY[n]).map(name => ({ name, ...DISPLAY[name] }))
    } catch {
      providers.value = []
    } finally {
      loaded.value = true
    }
  }

  return { providers, loaded, load }
}
