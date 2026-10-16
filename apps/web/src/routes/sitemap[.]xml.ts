import { createFileRoute } from '@tanstack/react-router';

import { envConfigs } from '@/config';
import { baseLocale, locales, localizeUrl } from '@/paraglide/runtime.js';
import { getLocalPosts, mergePosts } from '@/content/posts';

const STATIC_PATHS = [
  '',
  '/pricing',
  '/blog',
  '/ideas',
  '/privacy-policy',
  '/terms-of-service',
];

type Entry = {
  path: string;
  lastModified?: string;
  changeFrequency: string;
  priority: number;
};

function urlFor(path: string, locale: string): string {
  return localizeUrl(`${envConfigs.app_url}${path || '/'}`, {
    locale: locale as (typeof locales)[number],
  }).href;
}

function entryXml(e: Entry): string {
  const alternates = locales
    .map(
      (loc) =>
        `    <xhtml:link rel="alternate" hreflang="${loc}" href="${urlFor(e.path, loc)}"/>`
    )
    .join('\n');
  return [
    '  <url>',
    `    <loc>${urlFor(e.path, baseLocale)}</loc>`,
    alternates,
    e.lastModified ? `    <lastmod>${e.lastModified}</lastmod>` : null,
    `    <changefreq>${e.changeFrequency}</changefreq>`,
    `    <priority>${e.priority}</priority>`,
    '  </url>',
  ]
    .filter(Boolean)
    .join('\n');
}

export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: async () => {
        const entries: Entry[] = STATIC_PATHS.map((path) => ({
          path,
          changeFrequency: path === '/blog' ? 'daily' : 'weekly',
          priority: path === '' ? 1 : 0.8,
        }));

        // Blog posts: db posts merged with local MDX posts.
        try {
          const { listPublishedArticles } =
            await import('@/modules/posts/service');
          const rows = await listPublishedArticles().catch(() => []);
          const dbPosts = rows.map((row) => ({
            slug: row.slug,
            title: row.title || row.slug,
            description: row.description || '',
            createdAt: new Date(row.createdAt).toISOString(),
            source: 'db' as const,
          }));
          const posts = mergePosts(dbPosts, getLocalPosts(baseLocale));
          for (const post of posts) {
            entries.push({
              path: `/blog/${post.slug}`,
              lastModified: post.createdAt,
              changeFrequency: 'monthly',
              priority: 0.6,
            });
          }
        } catch {
          // Database unreachable — static paths + local posts still listed.
          for (const post of getLocalPosts(baseLocale)) {
            entries.push({
              path: `/blog/${post.slug}`,
              lastModified: post.createdAt,
              changeFrequency: 'monthly',
              priority: 0.6,
            });
          }
        }

        const xml = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
          ...entries.map(entryXml),
          '</urlset>',
          '',
        ].join('\n');

        return new Response(xml, {
          headers: { 'Content-Type': 'application/xml' },
        });
      },
    },
  },
});
