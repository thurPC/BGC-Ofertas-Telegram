import { tokens } from './text.js';
import { variantsCompatible } from './identity.js';

export function jaccardTokens(left, right) {
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / new Set([...a, ...b]).size;
}

export function semanticSimilarity(leftOffer, rightOffer) {
  const score = jaccardTokens(leftOffer?.name || leftOffer?.title, rightOffer?.name || rightOffer?.title);
  return { score, similar: score >= 0.5 };
}

export function semanticCannotOverride(leftIdentity, rightIdentity, leftOffer, rightOffer) {
  const similarity = semanticSimilarity(leftOffer, rightOffer);
  if (!similarity.similar) {
    return { override: false, similar: false, reason: 'not-similar' };
  }
  if (!variantsCompatible(leftIdentity, rightIdentity)) {
    return { override: false, similar: true, reason: 'incompatible-variants' };
  }
  return { override: false, similar: true, reason: 'semantics-auxiliary-only' };
}

export function applySemanticAuxiliary(identity, offer, peers = []) {
  const hints = [];
  for (const peer of peers) {
    const result = semanticCannotOverride(identity, peer.identity, offer, peer.offer);
    if (result.similar) hints.push(result);
  }
  return {
    ...identity,
    semantic: {
      auxiliary: true,
      hints: hints.length,
      confirmed: false
    }
  };
}
