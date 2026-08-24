/**
 * Downscale an image in the browser before it is uploaded.
 *
 * Doing this client-side keeps an image library (and a native binary) out of the server image:
 * what arrives is already letterhead-sized, so the API only has to validate it. The server still
 * enforces its own limits — this is a convenience, not a security boundary.
 */

/** Letterhead box in the printed forms is 45mm x 17mm; 600x200 covers it at print resolution. */
export const LOGO_MAX_WIDTH = 600
export const LOGO_MAX_HEIGHT = 200

/** Refuse absurd originals before we even decode them. */
export const SOURCE_MAX_BYTES = 5_000_000

export interface ResizeOptions {
  maxWidth?: number
  maxHeight?: number
  /** Output type. PNG keeps transparency, which logos usually rely on. */
  mimeType?: 'image/png' | 'image/jpeg' | 'image/webp'
  quality?: number
}

export class ImageResizeError extends Error {}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new ImageResizeError('Could not read the image')) }
    img.src = url
  })
}

/**
 * Fit the image inside the box, preserving aspect ratio. An image already smaller than the box
 * is only re-encoded (never upscaled) so a small crisp logo stays crisp.
 */
export async function resizeImage(file: File, opts: ResizeOptions = {}): Promise<File> {
  const {
    maxWidth = LOGO_MAX_WIDTH,
    maxHeight = LOGO_MAX_HEIGHT,
    mimeType = 'image/png',
    quality = 0.92,
  } = opts

  if (file.size > SOURCE_MAX_BYTES) {
    throw new ImageResizeError(`Image must be smaller than ${Math.floor(SOURCE_MAX_BYTES / 1_000_000)} MB`)
  }

  const img = await loadImage(file)
  const scale = Math.min(maxWidth / img.width, maxHeight / img.height, 1)
  const width = Math.max(1, Math.round(img.width * scale))
  const height = Math.max(1, Math.round(img.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new ImageResizeError('Canvas is unavailable in this browser')
  ctx.drawImage(img, 0, 0, width, height)

  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mimeType, quality))
  if (!blob) throw new ImageResizeError('Could not encode the resized image')

  const ext = mimeType.split('/')[1]
  const base = file.name.replace(/\.[^.]+$/, '') || 'logo'
  return new File([blob], `${base}.${ext}`, { type: mimeType })
}

export function useImageResize() {
  return { resizeImage, LOGO_MAX_WIDTH, LOGO_MAX_HEIGHT, SOURCE_MAX_BYTES }
}
