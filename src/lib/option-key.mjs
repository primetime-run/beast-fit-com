/* The catalog key for a pricing option.
 *
 * Deliberately plain .mjs and deliberately in one place: this is imported BOTH
 * by scripts/generate-catalog.mjs (which writes the server's price list) and
 * by the product page (which stamps the key onto every Buy button). Two copies
 * that drift by one character means every button 400s with unknown_option, and
 * nothing about the symptom points at the cause.
 *
 * The label is display copy — it carries em dashes and multiplication signs and
 * it will be reworded. Rewording changes the key, which is why the generator
 * fails loudly on collisions rather than silently merging two prices.
 */
export const optionKey = (label) =>
  label
    .toLowerCase()
    .replace(/×/g, 'x')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
