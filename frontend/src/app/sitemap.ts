import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/config/site'

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date()
  return [
    { url: SITE_URL, lastModified, priority: 1 },
    { url: `${SITE_URL}/login`, lastModified, priority: 0.6 },
    { url: `${SITE_URL}/privacy`, lastModified, priority: 0.3 },
    { url: `${SITE_URL}/terms`, lastModified, priority: 0.3 },
  ]
}
