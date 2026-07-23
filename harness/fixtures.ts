// Ground-truth fixture loader for the parity regression suite.
//
// The fixtures in harness/fixtures/ were captured from a REAL Slicer session over the
// slicer-mcp server (clear scene -> load MRHead -> enable volume rendering), so the
// pure-TS checks can run as ordinary regression tests with no Slicer and no browser.
// See docs/HARNESS.md "Regenerating the fixtures" for the exact capture snippets.
//
// Set SLICERLIVE_FIXTURES=/tmp to validate freshly-captured dumps instead of the
// checked-in ones (that's how you confirm a new Slicer build still agrees).

const DIR = Deno.env.get("SLICERLIVE_FIXTURES") ??
  new URL("./fixtures/", import.meta.url).pathname;

export async function fixture<T>(name: string): Promise<T> {
  const path = DIR.endsWith("/") ? DIR + name : `${DIR}/${name}`;
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch (e) {
    throw new Error(
      `missing fixture ${path}: ${e instanceof Error ? e.message : e}\n` +
        `Capture it from a live Slicer (see docs/HARNESS.md) or unset SLICERLIVE_FIXTURES.`,
    );
  }
}

export function fixtureDir(): string { return DIR; }
