// T1: declarative hanging protocols — applicability, grid derivation, comparison expansion,
// and the validator. The cases are written so a failure names the rule that moved.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  applicableProtocols,
  byScreen,
  gridOf,
  type HangingProtocol,
  isApplicable,
  parseProtocols,
  ProtocolError,
  requiredRoles,
  resolveLayout,
  rolesOf,
  validateProtocol,
  viewportTitle,
} from "./hanging-protocol.ts";

const quad: HangingProtocol = {
  id: "left1",
  label: "Left #1",
  screen: "left",
  viewports: [
    { source: "ct", view: "axial" },
    { source: "ac", view: "axial" },
    { source: "ct", overlay: "ac", view: "axial" },
    { source: "nac", view: "axial" },
  ],
};

Deno.test("rolesOf lists each role once, in first-appearance order", () => {
  assertEquals(rolesOf(quad), ["ct", "ac", "nac"]);
});

Deno.test("a 4-viewport protocol hangs 2x2, a 3-viewport one in a single row", () => {
  assertEquals(gridOf(quad), { cols: 2, rows: 2 });
  assertEquals(gridOf({ ...quad, viewports: quad.viewports.slice(0, 3) }), { cols: 3, rows: 1 });
});

Deno.test("explicit cols wins over the derived grid", () => {
  assertEquals(gridOf({ ...quad, cols: 4 }), { cols: 4, rows: 1 });
  assertEquals(gridOf({ ...quad, cols: 1 }), { cols: 1, rows: 4 });
});

Deno.test("an empty protocol has an empty grid rather than dividing by zero", () => {
  assertEquals(gridOf({ ...quad, viewports: [] }), { cols: 0, rows: 0 });
});

Deno.test("applicability requires every displayed role", () => {
  assert(isApplicable(quad, ["ct", "ac", "nac"]));
  // A study with no uncorrected series cannot hang Left #1.
  assert(!isApplicable(quad, ["ct", "ac"]));
});

Deno.test("requires overrides the derived role set, to demand MORE than is shown", () => {
  const p: HangingProtocol = { ...quad, requires: ["ct", "ac", "nac", "seg"] };
  assertEquals(requiredRoles(p), ["ct", "ac", "nac", "seg"]);
  assert(!isApplicable(p, ["ct", "ac", "nac"]));
  assert(isApplicable(p, ["ct", "ac", "nac", "seg"]));
});

Deno.test("a comparison protocol is withheld until a second timepoint exists", () => {
  const cmp: HangingProtocol = { ...quad, id: "cmp", timepoints: 2 };
  assert(!isApplicable(cmp, ["ct", "ac", "nac"], 1));
  assert(isApplicable(cmp, ["ct", "ac", "nac"], 2));
});

Deno.test("applicableProtocols filters a set without reordering it", () => {
  const set: HangingProtocol[] = [
    quad,
    { id: "acmip", label: "AC + MIP", viewports: [{ source: "ac", view: "axial" }, { source: "ac", view: "mip" }] },
    { id: "nac", label: "NAC", viewports: [{ source: "nac", view: "axial" }] },
  ];
  assertEquals(applicableProtocols(set, ["ct", "ac"]).map((p) => p.id), ["acmip"]);
  assertEquals(applicableProtocols(set, ["ct", "ac", "nac"]).map((p) => p.id), ["left1", "acmip", "nac"]);
});

Deno.test("byScreen groups in first-appearance order and keeps list order inside a group", () => {
  const set: HangingProtocol[] = [
    { id: "a", label: "a", screen: "left", viewports: [{ source: "ct", view: "axial" }] },
    { id: "b", label: "b", screen: "right", viewports: [{ source: "ct", view: "axial" }] },
    { id: "c", label: "c", screen: "left", viewports: [{ source: "ct", view: "axial" }] },
    { id: "d", label: "d", viewports: [{ source: "ct", view: "axial" }] },
  ];
  assertEquals(byScreen(set).map((g) => [g.screen, g.protocols.map((p) => p.id)]), [
    ["left", ["a", "c"]],
    ["right", ["b"]],
    ["", ["d"]],
  ]);
});

Deno.test("viewport titles name the plane, the fusion and the projection", () => {
  const names = { ct: "CT", ac: "PET (AC)" };
  assertEquals(viewportTitle({ source: "ct", view: "axial" }, names), "CT axial");
  assertEquals(viewportTitle({ source: "ct", overlay: "ac", view: "coronal" }, names), "CT+PET (AC) coronal");
  assertEquals(viewportTitle({ source: "ac", view: "mip" }, names), "PET (AC) MIP");
  assertEquals(viewportTitle({ source: "ac", view: "mip", label: "Rotating" }, names), "Rotating");
  // An unnamed role still renders, uppercased, rather than printing "undefined".
  assertEquals(viewportTitle({ source: "t1", view: "sagittal" }), "T1 sagittal");
});

Deno.test("a single-timepoint protocol repeats per study, newest first, as extra grid rows", () => {
  const r = resolveLayout(quad, 2);
  assertEquals([r.cols, r.rows], [2, 4]);
  assertEquals(r.viewports.length, 8);
  // Newest study occupies the TOP rows -- the one firm convention in every reading layout.
  assertEquals(r.viewports.slice(0, 4).map((v) => v.timepoint), [0, 0, 0, 0]);
  assertEquals(r.viewports.slice(4).map((v) => v.timepoint), [1, 1, 1, 1]);
  assertEquals(r.viewports.map((v) => [v.row, v.col]), [
    [0, 0], [0, 1], [1, 0], [1, 1],
    [2, 0], [2, 1], [3, 0], [3, 1],
  ]);
});

Deno.test("a protocol that declares its own timepoints is laid out verbatim, not repeated", () => {
  const cmp: HangingProtocol = {
    id: "cmp",
    label: "Two study",
    timepoints: 2,
    cols: 2,
    viewports: [
      { source: "ac", view: "axial", label: "current" },
      { source: "ac", view: "mip", label: "current MIP" },
      { source: "ac", view: "axial", label: "prior" },
      { source: "ac", view: "mip", label: "prior MIP" },
    ],
  };
  const r = resolveLayout(cmp, 2);
  assertEquals([r.cols, r.rows], [2, 2]);
  assertEquals(r.viewports.length, 4);
  assertEquals(r.viewports.map((v) => v.timepoint), [0, 0, 0, 0]);
});

Deno.test("resolving against a single study is the identity layout", () => {
  const r = resolveLayout(quad, 1);
  assertEquals([r.cols, r.rows], [2, 2]);
  assertEquals(r.viewports.map((v) => v.timepoint), [0, 0, 0, 0]);
});

Deno.test("validateProtocol rejects every shape that would hang a broken layout", () => {
  const cases: [string, unknown][] = [
    ["not an object", 42],
    ["missing id", { label: "x", viewports: [{ source: "ct", view: "axial" }] }],
    ["missing label", { id: "x", viewports: [{ source: "ct", view: "axial" }] }],
    ["no viewports", { id: "x", label: "x", viewports: [] }],
    ["unknown view", { id: "x", label: "x", viewports: [{ source: "ct", view: "oblique" }] }],
    ["missing source", { id: "x", label: "x", viewports: [{ view: "axial" }] }],
    ["overlay equals source", { id: "x", label: "x", viewports: [{ source: "ct", overlay: "ct", view: "axial" }] }],
    ["zero cols", { id: "x", label: "x", cols: 0, viewports: [{ source: "ct", view: "axial" }] }],
    ["zero timepoints", { id: "x", label: "x", timepoints: 0, viewports: [{ source: "ct", view: "axial" }] }],
    ["negative slab", { id: "x", label: "x", viewports: [{ source: "ct", view: "axial", slab: { thicknessMm: -1, mode: "mean" } }] }],
    ["bad slab mode", { id: "x", label: "x", viewports: [{ source: "ct", view: "axial", slab: { thicknessMm: 10, mode: "sum" } }] }],
  ];
  for (const [why, p] of cases) assertThrows(() => validateProtocol(p), ProtocolError, undefined, why);
});

Deno.test("validateProtocol accepts a fully specified viewport and returns it", () => {
  const p = validateProtocol({
    id: "x",
    label: "x",
    screen: "right",
    cols: 1,
    timepoints: 1,
    requires: ["ct", "ac"],
    viewports: [{ source: "ct", overlay: "ac", view: "coronal", label: "Fused coronal", slab: { thicknessMm: 15, mode: "max" } }],
  });
  assertEquals(p.id, "x");
  assertEquals(p.viewports[0].slab, { thicknessMm: 15, mode: "max" });
});

Deno.test("a protocol set round-trips through JSON and rejects duplicate ids", () => {
  const set = parseProtocols(JSON.parse(JSON.stringify([quad, { ...quad, id: "other" }])));
  assertEquals(set.map((p) => p.id), ["left1", "other"]);
  assertThrows(() => parseProtocols([quad, quad]), ProtocolError, "duplicate protocol id: left1");
  assertThrows(() => parseProtocols({} as unknown), ProtocolError, "must be an array");
});
