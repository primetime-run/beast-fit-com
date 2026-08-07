import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'

export default defineConfig({
  site: 'https://beast-fit.com',
  integrations: [
    sitemap({
      /* Everything under /checkout/ is machinery, not content: the payment
         test, the receipt page and the iframe communicator. They already send
         noindex, but a page listed in the sitemap and then refused is a
         Search Console error every crawl, so keep them out of both. */
      filter: (page) => {
        const p = new URL(page).pathname
        // Both are noindex. A page listed in the sitemap and then refused is a
        // Search Console error on every crawl.
        return !p.startsWith('/checkout/') && p !== '/waiver/'
      },
    }),
  ],

  // 'directory' preserves the WordPress URL shape: every page builds to
  // <path>/index.html, so /trainers/ resolves as it did before.
  build: { format: 'directory' },

  // 'ignore' so /foo and /foo/ both resolve in dev, matching how GitHub Pages
  // behaves. Canonical URLs are normalised in Base.astro.
  trailingSlash: 'ignore',
})
