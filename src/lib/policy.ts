/* ---------------------------------------------------------------------------
   Renders data/privacy-policy.yaml to HTML.

   The YAML holds no markup, which is the point of keeping it in YAML: nothing
   in a content file can inject an element into the page. Text is escaped
   FIRST, then the two permitted inline forms are applied to the escaped
   string. Doing it the other way round — substituting tags and then escaping —
   would escape the tags we just made, and doing neither would make the
   content file a script injection vector.

   Supported inline, and deliberately nothing else:
     **bold**          -> <strong>
     [text](https://…) -> <a href="…">

   Link targets are restricted to http(s). A `javascript:` URL in a content
   file should be inert, not clever.
--------------------------------------------------------------------------- */

export type PolicyBlock =
  | { p: string }
  | { h2: string }
  | { h3: string }
  | { h4: string }
  | { ul: PolicyItem[] }

export type PolicyItem = string | { blocks: PolicyBlock[] }

export interface PolicyDoc {
  blocks: PolicyBlock[]
}

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

function inline(raw: string): string {
  let s = escapeHtml(raw)

  // [text](url) — only http(s), and the URL is already escaped above.
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text, url) => {
    return `<a href="${url}" rel="noopener">${text}</a>`
  })

  // **bold** — non-greedy, no nesting.
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')

  return s
}

function renderBlock(b: PolicyBlock): string {
  if ('p' in b) return `<p>${inline(b.p)}</p>`
  if ('h2' in b) return `<h2>${inline(b.h2)}</h2>`
  if ('h3' in b) return `<h3>${inline(b.h3)}</h3>`
  if ('h4' in b) return `<h4>${inline(b.h4)}</h4>`
  if ('ul' in b) {
    const items = b.ul
      .map((li) =>
        typeof li === 'string'
          ? `<li>${inline(li)}</li>`
          : `<li>${li.blocks.map(renderBlock).join('')}</li>`
      )
      .join('')
    return `<ul>${items}</ul>`
  }
  // Exhaustive in practice; a malformed block should be loud, not silent.
  throw new Error(`unknown policy block: ${JSON.stringify(b)}`)
}

export const renderPolicy = (doc: PolicyDoc): string => doc.blocks.map(renderBlock).join('\n')
