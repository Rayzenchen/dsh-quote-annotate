/**
 * Host half of `@local/dsh-quote-annotate`.
 *
 * The feature lives entirely in the browser: selection capture, the floating
 * "add to input" button, the annotation cards, and the prompt serialization all
 * ride the Client input machine. The Host half therefore only needs to exist so
 * the bundle has a row in the composition (which is in turn what makes the
 * Web shell's client roster pick up `./client`).
 */
export function apply() {}
