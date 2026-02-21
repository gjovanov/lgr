import { reactive } from 'vue'

const snackbar = reactive({
  visible: false,
  message: '',
  color: 'error',
  timeout: 5000,
})

export function useSnackbar() {
  function showSnackbar(text: string, color = 'error', timeout = 5000) {
    snackbar.message = text
    snackbar.color = color
    snackbar.timeout = timeout
    snackbar.visible = true
  }

  function showError(text: string) {
    showSnackbar(text, 'error', 5000)
  }

  function showSuccess(text: string) {
    showSnackbar(text, 'success', 3000)
  }

  function hideSnackbar() {
    snackbar.visible = false
  }

  return { snackbar, showSnackbar, showError, showSuccess, hideSnackbar }
}
