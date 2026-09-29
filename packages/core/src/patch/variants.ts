import { satisfies, tryParse, tryParseRange } from "std-semver";
import { PatchCompileError } from "./errors";
import { isPatchId } from "./release";
import type { PatchMetadata } from "./model";

export const PATCH_VARIANT_OF = "patch:variant-of";
export const PATCH_VARIANT_LOCALE = "patch:locale";
export const PATCH_VARIANT_ACCESS_MODE = "patch:access-mode";
export const PATCH_VARIANTS = "patch:variants";
export const PATCH_CANONICAL_VARIANT = "patch:canonical-variant:";

export interface PatchVersionRange {
  readonly patchId: string;
  readonly range: string;
}

export interface PatchVariantClaim extends PatchVersionRange {
  readonly locale?: string;
  readonly accessMode?: string;
}

export interface PatchVariantMetadata {
  readonly claim?: PatchVariantClaim;
  readonly confirmations: readonly PatchVersionRange[];
  readonly canonicalVariants: readonly { readonly locale: string; readonly patchId: string }[];
}

export interface PatchVariantRelease {
  readonly patchId: string;
  readonly version: string;
  readonly metadata: PatchMetadata;
}

export interface ConfirmedPatchVariant extends PatchVariantClaim {
  readonly variantId: string;
  readonly version: string;
  readonly canonical: boolean;
}

export interface PatchVariantRead {
  readonly confirmedVariants: readonly ConfirmedPatchVariant[];
  readonly claims: readonly {
    readonly variantId: string;
    readonly sourceId: string;
    readonly variantRange?: string;
    readonly confirmationRange?: string;
    readonly locale?: string;
    readonly accessMode?: string;
  }[];
}

function invalid(reason: string): never {
  throw new PatchCompileError("invalid-metadata-value", `invalid Patch variant metadata: ${reason}`);
}

function localeTag(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() !== value) return invalid(`${field} must be a BCP 47 language tag`);
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    if (canonical) return canonical;
  } catch {
    // Use the field-specific error below.
  }
  return invalid(`${field} must be a BCP 47 language tag`);
}

function parseRangeReference(value: unknown, field: string): PatchVersionRange {
  if (typeof value !== "string" || value.trim() !== value) return invalid(`${field} must be <patch-id>@<semver-range>`);
  const separator = value.indexOf("@");
  if (separator < 1) return invalid(`${field} must be <patch-id>@<semver-range>`);
  const patchId = value.slice(0, separator);
  const range = value.slice(separator + 1);
  if (!isPatchId(patchId) || range === "" || tryParseRange(range) === undefined)
    return invalid(`${field} must be <patch-id>@<semver-range>`);
  return { patchId, range };
}

/** Parses the portable claim and confirmation fields; it does not look up either Patch. */
export function patchVariantMetadata(patchId: string, metadata: PatchMetadata): PatchVariantMetadata {
  const properties = metadata.properties;
  const rawClaim = properties[PATCH_VARIANT_OF];
  const rawLocale = properties[PATCH_VARIANT_LOCALE];
  const rawAccessMode = properties[PATCH_VARIANT_ACCESS_MODE];
  let claim: PatchVariantClaim | undefined;

  if (rawClaim !== undefined) {
    const target = parseRangeReference(rawClaim, PATCH_VARIANT_OF);
    if (target.patchId === patchId) invalid("a Patch cannot be a variant of itself");
    if (rawLocale === undefined && rawAccessMode === undefined)
      invalid(`${PATCH_VARIANT_OF} needs ${PATCH_VARIANT_LOCALE} and/or ${PATCH_VARIANT_ACCESS_MODE}`);
    const locale = rawLocale === undefined ? undefined : localeTag(rawLocale, PATCH_VARIANT_LOCALE);
    let accessMode: string | undefined;
    if (rawAccessMode !== undefined) {
      if (typeof rawAccessMode !== "string" || rawAccessMode.trim() !== rawAccessMode || rawAccessMode === "")
        invalid(`${PATCH_VARIANT_ACCESS_MODE} must be a non-empty string`);
      accessMode = rawAccessMode;
    }
    claim = {
      ...target,
      ...(locale === undefined ? {} : { locale }),
      ...(accessMode === undefined ? {} : { accessMode }),
    };
  } else if (rawLocale !== undefined || rawAccessMode !== undefined) {
    invalid(`${PATCH_VARIANT_LOCALE} and ${PATCH_VARIANT_ACCESS_MODE} require ${PATCH_VARIANT_OF}`);
  }

  const rawConfirmations = properties[PATCH_VARIANTS];
  if (rawConfirmations !== undefined && !Array.isArray(rawConfirmations))
    invalid(`${PATCH_VARIANTS} must be a list of <patch-id>@<semver-range>`);
  const confirmationValues: readonly unknown[] = Array.isArray(rawConfirmations) ? rawConfirmations : [];
  const confirmations = confirmationValues.map((value) => parseRangeReference(value, PATCH_VARIANTS));
  const confirmedIds = new Set<string>();
  for (const confirmation of confirmations) {
    if (confirmation.patchId === patchId) invalid("a Patch cannot confirm itself as a variant");
    if (confirmedIds.has(confirmation.patchId)) invalid(`${PATCH_VARIANTS} cannot repeat a Patch identity`);
    confirmedIds.add(confirmation.patchId);
  }

  const canonicalVariants: { locale: string; patchId: string }[] = [];
  const canonicalLocales = new Set<string>();
  for (const [key, value] of Object.entries(properties)) {
    if (!key.startsWith(PATCH_CANONICAL_VARIANT)) continue;
    const locale = localeTag(key.slice(PATCH_CANONICAL_VARIANT.length), key);
    if (canonicalLocales.has(locale)) invalid(`only one canonical variant may be marked for ${locale}`);
    if (typeof value !== "string" || !isPatchId(value)) invalid(`${key} must name a Patch identity`);
    if (!confirmedIds.has(value)) invalid(`${key} must name a Patch listed in ${PATCH_VARIANTS}`);
    canonicalLocales.add(locale);
    canonicalVariants.push({ locale, patchId: value });
  }

  return { ...(claim && { claim }), confirmations, canonicalVariants };
}

export function patchVersionInRange(version: string, range: string): boolean {
  const parsedVersion = tryParse(version);
  const parsedRange = tryParseRange(range);
  return parsedVersion !== undefined && parsedRange !== undefined && satisfies(parsedVersion, parsedRange);
}

/** Interprets reciprocal claims for the source release in scope and each supplied current variant release. */
export function readPatchVariants(
  source: PatchVariantRelease,
  candidates: readonly PatchVariantRelease[],
): PatchVariantRead {
  const sourceMetadata = patchVariantMetadata(source.patchId, source.metadata);
  const confirmedVariants: ConfirmedPatchVariant[] = [];
  const claims: PatchVariantRead["claims"][number][] = [];
  const byId = new Map(candidates.map((candidate) => [candidate.patchId, candidate]));
  const examined = new Set<string>();

  for (const confirmation of sourceMetadata.confirmations) {
    const candidate = byId.get(confirmation.patchId);
    const claim = candidate && patchVariantMetadata(candidate.patchId, candidate.metadata).claim;
    if (!candidate || !claim || claim.patchId !== source.patchId) {
      claims.push({ variantId: confirmation.patchId, sourceId: source.patchId, confirmationRange: confirmation.range });
      continue;
    }
    examined.add(candidate.patchId);
    const confirmed =
      patchVersionInRange(source.version, claim.range) && patchVersionInRange(candidate.version, confirmation.range);
    if (!confirmed) {
      claims.push({
        variantId: candidate.patchId,
        sourceId: source.patchId,
        variantRange: claim.range,
        confirmationRange: confirmation.range,
        ...(claim.locale === undefined ? {} : { locale: claim.locale }),
        ...(claim.accessMode === undefined ? {} : { accessMode: claim.accessMode }),
      });
      continue;
    }
    const canonical =
      claim.locale !== undefined &&
      sourceMetadata.canonicalVariants.some(
        ({ locale, patchId }) => locale === claim.locale && patchId === candidate.patchId,
      );
    confirmedVariants.push({ ...claim, variantId: candidate.patchId, version: candidate.version, canonical });
  }

  for (const candidate of candidates) {
    if (examined.has(candidate.patchId)) continue;
    const claim = patchVariantMetadata(candidate.patchId, candidate.metadata).claim;
    if (claim?.patchId === source.patchId)
      claims.push({
        variantId: candidate.patchId,
        sourceId: source.patchId,
        variantRange: claim.range,
        ...(claim.locale === undefined ? {} : { locale: claim.locale }),
        ...(claim.accessMode === undefined ? {} : { accessMode: claim.accessMode }),
      });
  }

  return { confirmedVariants, claims };
}
