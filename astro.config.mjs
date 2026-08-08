import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'

export default defineConfig({
  site: 'https://beast-fit.com',
  integrations: [
    sitemap({
      /* Everything under /checkout/ is machinery, not content: the payment
         test, the receipt page and the iframe communicator. They already send
         noindex, but a page listed in the sitemap and then refused is a
         Search Console error every crawl, so keep them out of both.

         /waiver/ used to be excluded here for the same reason. It is now a
         normal indexable page — linked from the nav, no private data on it,
         and people do search for a gym's waiver by name — so it sends no
         robots meta and belongs in the sitemap. The two have to move together:
         listing it while it still refused indexing would create exactly the
         crawl error this filter exists to prevent. */
      filter: (page) => !new URL(page).pathname.startsWith('/checkout/'),
    }),
  ],

  // 'directory' preserves the WordPress URL shape: every page builds to
  // <path>/index.html, so /trainers/ resolves as it did before.
  build: { format: 'directory' },

  // 'ignore' so /foo and /foo/ both resolve in dev, matching how GitHub Pages
  // behaves. Canonical URLs are normalised in Base.astro.
  trailingSlash: 'ignore',
})
