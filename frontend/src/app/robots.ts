import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/config/site'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/privacy', '/terms', '/login'],
      disallow: ['/api/', '/home', '/courses/'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
