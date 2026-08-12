import { describe, expect, it } from "vitest";
import {
  MAX_TECHNICAL_IDENTIFIERS_PER_RECORD,
  MAX_TECHNICAL_VARIANTS_LENGTH,
  buildTechnicalVariants,
  findTechnicalIdentifiers,
  identifierVariantForms,
} from "../../src/search-technical-normalization.ts";

describe("findTechnicalIdentifiers (TKT-034)", () => {
  it("finds the same canonical identifier regardless of source spelling", () => {
    expect(findTechnicalIdentifiers("Replacement part code A-12 installed.")).toEqual([{ canonical: "A12", letters: "A", digits: "12" }]);
    expect(findTechnicalIdentifiers("Replacement part code A12 installed.")).toEqual([{ canonical: "A12", letters: "A", digits: "12" }]);
    expect(findTechnicalIdentifiers("Replacement part code A 12 installed.")).toEqual([{ canonical: "A12", letters: "A", digits: "12" }]);
  });

  it("finds multiple distinct identifiers in first-occurrence order, deduplicated", () => {
    const found = findTechnicalIdentifiers("Codes ZX-99 and AB-100 were checked; ZX-99 was checked twice.");
    expect(found.map((m) => m.canonical)).toEqual(["ZX99", "AB100"]);
  });

  it("does not treat ordinary lowercase prose as an identifier (uppercase-only letters)", () => {
    expect(findTechnicalIdentifiers("The meeting happens in 2024 and again in 2025.")).toEqual([]);
    expect(findTechnicalIdentifiers("a 12 year old process")).toEqual([]);
  });

  it("does not treat a mixed-case word as an identifier", () => {
    expect(findTechnicalIdentifiers("Ab12 is just a normal-looking word.")).toEqual([]);
  });

  it("rejects a longer alphanumeric run with no clear identifier boundary (ambiguous expansion)", () => {
    // "AB12CD34" has no unambiguous split into one letters+digits identifier
    // -- every candidate boundary is immediately adjacent to more
    // alphanumeric characters -- so nothing is extracted from it at all,
    // rather than guessing a partial, possibly-wrong split.
    expect(findTechnicalIdentifiers("Reference AB12CD34 in the appendix.")).toEqual([]);
  });

  it("does not match a pure digit run or a pure letter run", () => {
    expect(findTechnicalIdentifiers("Section 1234 has no letters.")).toEqual([]);
    expect(findTechnicalIdentifiers("ABCD has no digits.")).toEqual([]);
  });

  it("is a pure function: identical input always returns an identically ordered result", () => {
    const text = "Codes ZX-99 and AB-100 were checked.";
    expect(findTechnicalIdentifiers(text)).toEqual(findTechnicalIdentifiers(text));
  });
});

describe("identifierVariantForms (TKT-034)", () => {
  it("always returns exactly the same three bounded, deduplicated forms for one identifier", () => {
    const forms = identifierVariantForms({ canonical: "A12", letters: "A", digits: "12" });
    expect(forms).toEqual(["A-12", "A12", "A 12"]);
  });

  it("never produces more than three forms, however it was matched", () => {
    const forms = identifierVariantForms({ canonical: "ZX99", letters: "ZX", digits: "99" });
    expect(forms.length).toBeLessThanOrEqual(3);
  });
});

describe("buildTechnicalVariants (TKT-034)", () => {
  it("combines identifiers across fields, deduplicated, into deterministic index-only variant text", () => {
    const variants = buildTechnicalVariants(["Heading mentions A-12", undefined, undefined, "Body mentions A-12 again and B-99 once"]);
    for (const form of ["A-12", "A12", "A 12", "B-99", "B99", "B 99"]) {
      expect(variants).toContain(form);
    }
    // Deduplicated across fields: A-12 (mentioned in two different fields)
    // still contributes its 3 forms exactly once, not twice.
    expect(variants.match(/A-12/g)).toHaveLength(1);
    expect(variants.match(/A12/g)).toHaveLength(1);
  });

  it("returns an empty string when no field contains an identifier", () => {
    expect(buildTechnicalVariants(["Ordinary heading", "Ordinary paragraph text with no codes.", undefined, null])).toBe("");
  });

  it("never mutates or includes the original field text, only the generated variant forms", () => {
    const variants = buildTechnicalVariants(["", "", "", "Torque value A-12 confirmed nominal across the whole procedure."]);
    expect(variants).not.toContain("Torque");
    expect(variants).not.toContain("confirmed");
  });

  it("caps the number of distinct identifiers expanded per record (bounded, not unbounded expansion)", () => {
    const manyIdentifiers = Array.from({ length: MAX_TECHNICAL_IDENTIFIERS_PER_RECORD + 25 }, (_, i) => `ZZ-${i}`).join(" ");
    const variants = buildTechnicalVariants([manyIdentifiers]);
    // Each distinct identifier contributes exactly one hyphenated-form
    // token ("ZZ-<n>"); counting those (not naive space-splitting, since
    // the spaced form itself contains a space) gives the true identifier count.
    const hyphenatedForms = new Set(variants.match(/ZZ-\d+/g));
    expect(hyphenatedForms.size).toBeLessThanOrEqual(MAX_TECHNICAL_IDENTIFIERS_PER_RECORD);
    // First-occurrence identifiers survive the cap, later ones do not.
    expect(hyphenatedForms.has("ZZ-0")).toBe(true);
    expect(hyphenatedForms.has(`ZZ-${MAX_TECHNICAL_IDENTIFIERS_PER_RECORD + 24}`)).toBe(false);
  });

  it("never exceeds the defensive maximum variant text length", () => {
    const manyIdentifiers = Array.from({ length: 5000 }, (_, i) => `ZZ-${i}`).join(" ");
    const variants = buildTechnicalVariants([manyIdentifiers]);
    expect(variants.length).toBeLessThanOrEqual(MAX_TECHNICAL_VARIANTS_LENGTH);
  });

  it("is a pure function: identical input always produces identical output", () => {
    const fields = ["Heading A-12", "Table Header", "Row Header B-99", "Body content A-12 B-99"];
    expect(buildTechnicalVariants(fields)).toBe(buildTechnicalVariants([...fields]));
  });
});
