import * as React from 'react'
import type { Components } from 'react-markdown'

/**
 * Markdown elements the renderer draws its own way so that model text cannot make the browser load anything (SEC-L6).
 *
 * An image in model-written text is a request to whatever address it names, made with the student's IP and the page's
 * referrer, and a way to leak what the page knows through the address. So an image is never an `<img>`: it shows its
 * alt text and its address as plain text, and nothing is requested. (Raw HTML is already shown as text; see
 * inline-html.ts.)
 */
export const safeComponents: Components = {
  img({ src, alt }) {
    const address = typeof src === 'string' ? src : ''
    return (
      <span className="md-image-text">
        {alt || 'Image'}
        {address ? <span className="break-all"> ({address})</span> : null}
      </span>
    )
  },
}
