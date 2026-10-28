// VR limit checking for values inherited into a bundle's composite context.
//
// WHY THIS EXISTS, verbatim from SlicerAlbula's hard-won note:
//
//   "Never feed ctkDICOM *index* values into DICOM tags. The index stores display concatenations
//    and reformatted values that violate VR limits - a 68-character StudyDescription against LO's
//    64, an ISO-format birth date against DA's 8 digits. This cost several rounds of opaque dcmqi
//    'Value Representation violated' errors."
//
// So the MRCOM writer takes composite context from a PARSED REFERENCE INSTANCE, never from a
// database index. This module is the backstop for when that still goes wrong: every inherited value
// is checked, and every coercion is REPORTED to the caller rather than silently truncated. A
// surprise is better delivered at write time than as an unreadable file later.
//
// docs/MRCOM-SCENE-BUNDLE.md section 1.2.

/** What a VR allows. Lengths are in characters for the string VRs. */
export interface VrLimit {
  /** Maximum characters per value. */
  maxLength?: number;
  /** Exactly this many characters. */
  fixedLength?: number;
  /** Characters this VR does not permit, which would otherwise corrupt the value on read. */
  forbidden?: RegExp;
  /** A human description used in the coercion note. */
  note?: string;
  /**
   * An extra check applied AFTER forbidden characters are removed, for VRs where a cleaned value
   * can be the right length and still be wrong. Returning false drops the value.
   */
  plausible?: (value: string) => boolean;
}

/**
 * Is an 8-digit string a believable YYYYMMDD?
 *
 * Removing separators turns an ISO date into exactly the DICOM form - "1970-01-01" becomes
 * "19700101", which is unambiguous and worth keeping. But it turns a day-first or month-first date
 * into a plausible-looking WRONG one: "01/02/1970" becomes "01021970", eight digits that a reader
 * would take as the year 0102. So a cleaned DA has to look like a date, not merely be 8 digits.
 */
function plausibleDA(value: string): boolean {
  if (!/^[0-9]{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  return year >= 1800 && year <= 2200 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** PS3.5 Table 6.2-1, for the VRs a bundle's composite context actually uses. */
export const VR_LIMITS: Record<string, VrLimit> = {
  AE: { maxLength: 16 },
  AS: { fixedLength: 4, note: "nnnD, nnnW, nnnM or nnnY" },
  CS: { maxLength: 16, forbidden: /[^A-Z0-9 _]/, note: "upper case, digits, space and underscore" },
  DA: { fixedLength: 8, forbidden: /[^0-9]/, note: "YYYYMMDD", plausible: plausibleDA },
  DS: { maxLength: 16 },
  DT: { maxLength: 26 },
  IS: { maxLength: 12 },
  LO: { maxLength: 64, forbidden: /[\\\r\n\f]/ },
  LT: { maxLength: 10240 },
  PN: { maxLength: 64 * 5, note: "64 per component group" },
  SH: { maxLength: 16, forbidden: /[\\\r\n\f]/ },
  ST: { maxLength: 1024 },
  TM: { maxLength: 16, forbidden: /[^0-9.]/, note: "HHMMSS.FFFFFF" },
  UI: { maxLength: 64, forbidden: /[^0-9.]/, note: "digits and dots" },
  UT: { maxLength: 4294967294 },
};

/** A value that had to be changed to be legal, and what happened to it. */
export interface Coercion {
  /** The attribute keyword. */
  tag: string;
  vr: string;
  /** What the caller supplied, truncated for legibility. */
  from: string;
  /** What will be written. */
  to: string;
  /** Why, in a sentence a user can act on. */
  note: string;
}

export interface CoerceResult {
  value: string;
  coercion?: Coercion;
}

const show = (text: string, limit = 80) =>
  text.length > limit ? text.slice(0, limit) + `... (${text.length} chars)` : text;

/**
 * A global clone of a `forbidden` pattern, for removing EVERY offending character.
 *
 * The patterns are declared non-global so `.test()` stays stateless - a global RegExp carries
 * `lastIndex` between calls and `.test()` would then skip matches on a shared instance. But
 * `String.replace` with a non-global pattern removes only the FIRST match, which silently left
 * later offenders in place.
 */
const everywhere = (pattern: RegExp) =>
  pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + "g");

/**
 * Make one value legal for its VR, reporting anything that had to change.
 *
 * Nothing here is silent: a caller that ignores the coercion gets a legal file, and a caller that
 * surfaces it can tell the user their StudyDescription was shortened.
 *
 * @param tag attribute keyword, for the report
 * @param vr value representation
 * @param value the value as supplied; non-strings are stringified first
 * @returns the value to write, plus a coercion when one was needed
 */
export function coerceForVR(tag: string, vr: string, value: unknown): CoerceResult {
  const text = value === null || value === undefined ? "" : String(value);
  const limit = VR_LIMITS[vr];
  if (!limit) return { value: text };

  // A forbidden character is checked first: trimming to length would not make it legal, and for DA
  // in particular an ISO date ("1970-01-01") is both too long AND wrongly punctuated, so reporting
  // the real cause matters more than reporting the length.
  if (limit.forbidden && limit.forbidden.test(text)) {
    const cleaned = text.replace(everywhere(limit.forbidden), "");
    const rightLength = limit.fixedLength
      ? cleaned.length === limit.fixedLength
      : cleaned.length <= (limit.maxLength ?? Infinity);
    const enough = rightLength && (!limit.plausible || limit.plausible(cleaned));
    if (!enough || cleaned.length === 0) {
      return {
        value: "",
        coercion: {
          tag,
          vr,
          from: show(text),
          to: "",
          note:
            `${vr} does not permit these characters` +
            (limit.note ? ` (expects ${limit.note})` : "") +
            ", and removing them does not leave a legal value - dropped rather than guessed",
        },
      };
    }
    return {
      value: cleaned,
      coercion: {
        tag,
        vr,
        from: show(text),
        to: show(cleaned),
        note:
          `${vr} does not permit these characters` +
          (limit.note ? ` (expects ${limit.note})` : "") +
          " - removed",
      },
    };
  }

  if (limit.fixedLength !== undefined && text.length !== limit.fixedLength && text.length > 0) {
    return {
      value: "",
      coercion: {
        tag,
        vr,
        from: show(text),
        to: "",
        note:
          `${vr} is exactly ${limit.fixedLength} characters` +
          (limit.note ? ` (${limit.note})` : "") +
          `, got ${text.length} - dropped rather than guessed`,
      },
    };
  }

  if (limit.maxLength !== undefined && text.length > limit.maxLength) {
    const cut = text.slice(0, limit.maxLength);
    return {
      value: cut,
      coercion: {
        tag,
        vr,
        from: show(text),
        to: show(cut),
        note: `${vr} allows ${limit.maxLength} characters, got ${text.length} - truncated`,
      },
    };
  }

  return { value: text };
}

/**
 * Coerce a whole set of inherited attributes.
 *
 * @param entries keyword to [vr, value]
 * @returns the values to write, and every coercion that was needed
 */
export function coerceAll(
  entries: Record<string, [vr: string, value: unknown]>,
): { values: Record<string, string>; coercions: Coercion[] } {
  const values: Record<string, string> = {};
  const coercions: Coercion[] = [];
  for (const [tag, [vr, value]] of Object.entries(entries)) {
    const result = coerceForVR(tag, vr, value);
    values[tag] = result.value;
    if (result.coercion) coercions.push(result.coercion);
  }
  return { values, coercions };
}
