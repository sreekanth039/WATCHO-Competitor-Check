function cleanRef(value) {
  return String(value || "").trim().toUpperCase();
}

function compactRef(value) {
  return cleanRef(value).replace(/[\s.+/-]+/g, "");
}

function splitAlphaNumericParts(ref) {
  return cleanRef(ref).match(/[A-Z]+|\d+/g) || [cleanRef(ref)];
}

function addVariant(set, value) {
  const candidate = cleanRef(value);
  if (candidate) {
    set.add(candidate);
  }
}

function generateRefVariants(ref) {
  const variants = new Set();
  const cleaned = cleanRef(ref);
  const compact = compactRef(ref);
  const alphaNumericParts = splitAlphaNumericParts(ref);
  const hyphenParts = cleaned.split(/[-+\s/]+/).filter(Boolean);

  addVariant(variants, cleaned);
  addVariant(variants, compact);

  if (hyphenParts.length > 1) {
    addVariant(variants, hyphenParts.join(" "));
    addVariant(variants, hyphenParts.join("-"));
    addVariant(variants, hyphenParts.join("+"));
  }

  if (alphaNumericParts.length > 1) {
    addVariant(variants, alphaNumericParts.join(" "));
    addVariant(variants, alphaNumericParts.join("-"));

    if (alphaNumericParts.length >= 3) {
      addVariant(
        variants,
        `${alphaNumericParts.slice(0, -2).join("")} ${alphaNumericParts.slice(-2).join("")}`.trim()
      );
      addVariant(
        variants,
        `${alphaNumericParts.slice(0, 2).join(" ")} ${alphaNumericParts.slice(2).join("")}`.trim()
      );
    }
  }

  return [...variants];
}

function getMatchedRefVariant(ref, text) {
  const normalizedText = cleanRef(String(text || "")).replace(/\s+/g, " ");

  for (const variant of generateRefVariants(ref)) {
    if (variant && normalizedText.includes(variant)) {
      return variant;
    }
  }

  const compactText = compactRef(text);
  return generateRefVariants(ref).find((variant) => compactText.includes(compactRef(variant))) || null;
}

module.exports = {
  compactRef,
  generateRefVariants,
  getMatchedRefVariant,
};
