let _initialized = false

export function usePurestat() {
  function init() {
    if (_initialized) return
    if (typeof window === 'undefined') return
    const siteId = (window as any).__LGR_PURESTAT_SITE_ID__
    const trackerUrl = (window as any).__LGR_PURESTAT_TRACKER_URL__
    if (!siteId || !trackerUrl) return
    _initialized = true

    const script = document.createElement('script')
    script.defer = true
    script.dataset.domain = window.location.hostname
    script.dataset.api = `${trackerUrl}/api/event`
    script.src = `${trackerUrl}/tracker.js`
    document.head.appendChild(script)
  }

  function track(event: string, props?: Record<string, any>) {
    if (typeof window !== 'undefined' && (window as any).purestat) {
      (window as any).purestat(event, props ? { props } : undefined)
    }
  }

  return { init, track }
}
