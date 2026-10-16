import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { envConfigs } from '@/config';
import { m } from '@/paraglide/messages.js';
import { getLocale, locales, localizeUrl } from '@/paraglide/runtime.js';
import { Footer } from '@/blocks/footer';
import { Header } from '@/blocks/header';
import { IdeasBoard, type IdeaRow } from '@/blocks/ideas-board';

// The board fetches client-side, so the first hot page is also rendered
// server-side and handed to react-query as initialData — otherwise crawlers
// see an empty shell. The dynamic import keeps drizzle out of the client
// bundle, mirroring src/content/posts/server.ts.
const getPublicIdeasFn = createServerFn().handler(async () => {
  try {
    const { listIdeas } = await import('@/modules/ideas/service');
    const { items, total } = await listIdeas({ sort: 'hot', pageSize: 20 });
    return {
      items: items.map((i) => ({
        ...i,
        createdAt: new Date(i.createdAt).toISOString(),
      })),
      total,
    };
  } catch {
    // Database not reachable — the client query still gets its chance.
    return { items: [], total: 0 };
  }
});

function PublicIdeasPage() {
  const { ideas } = Route.useLoaderData();

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      <Header />
      <main className="flex-1 px-4 py-16 sm:py-24">
        <div className="mx-auto max-w-3xl">
          <div className="mb-12 text-center">
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
              {m['ideas.title']()}
            </h1>
            <p className="text-muted-foreground mx-auto mt-5 max-w-lg">
              {m['ideas.description']()}
            </p>
          </div>
          <IdeasBoard
            scope="public"
            initialData={ideas as { items: IdeaRow[]; total: number }}
          />
        </div>
      </main>
      <Footer />
    </div>
  );
}

export const Route = createFileRoute('/ideas')({
  loader: async () => {
    const locale = getLocale();
    const ideas = await getPublicIdeasFn();
    return { locale, ideas };
  },
  head: ({ loaderData }) => {
    const locale = (loaderData?.locale ?? 'en') as any;
    const urlFor = (loc: string) =>
      localizeUrl(`${envConfigs.app_url}/ideas`, { locale: loc as any }).href;
    return {
      meta: [
        {
          title: `${m['ideas.meta_title']({}, { locale })} | ${envConfigs.app_name}`,
        },
        {
          name: 'description',
          content: m['ideas.meta_description']({}, { locale }),
        },
      ],
      links: [
        { rel: 'canonical', href: urlFor(locale) },
        ...locales.map((loc) => ({
          rel: 'alternate',
          hrefLang: loc,
          href: urlFor(loc),
        })),
        { rel: 'alternate', hrefLang: 'x-default', href: urlFor('en') },
      ],
    };
  },
  component: PublicIdeasPage,
});
