import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/config/site'

/** AI search and assistant crawlers, named so the policy is explicit: they may read the public pages. */
const AI_CRAWLERS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
]

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{
      userAgent: '*',
      allow: ['/', '/privacy', '/terms', '/login'],
      disallow: ['/api/', '/home', '/courses/'],
    }, {
      // A crawler that matches a named group skips the * group, so the same private paths are repeated.
      userAgent: AI_CRAWLERS,
      allow: '/',
      disallow: ['/api/', '/home', '/courses/'],
    }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
