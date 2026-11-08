// Text formats for the readouts. No DOM, so it runs in Node for tests.

/**
 * A readout note as a sentence: a leading Latin letter capitalized and a period added. A note that starts with a
 * symbol keeps its case: capitalized, λ would read Λ, τ would read Τ (a capital tau, which looks like T) and σ̂, Σ̂
 * (a sum).
 *
 * @param {string} text
 * @returns {string}
 */
export function sentence(text) {
    const t = /^[a-z]/.test(text) ? text.charAt(0).toUpperCase() + text.slice(1) : text;
    return /[.!?]$/.test(t) ? t : `${t}.`;
}
