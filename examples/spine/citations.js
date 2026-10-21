// citations.js — where the spine demo's data comes from, and how to cite it.
//
// Every image and every reference segmentation in this demo is public data from the NCI
// Imaging Data Commons; nothing here was collected by us. The only thing we produced is the
// SPINEPS vertebra masks, computed from those images. Both source collections are CC BY 4.0,
// which REQUIRES attribution — so the citations are part of the pages, not a footnote in a
// README nobody opens.
//
// The facts below are not transcribed from a paper: they were read out of the IDC index
// itself (`collections_index`, and `index` for the per-series counts) by resolving the 242
// crdc_series_uuids the demo actually loads — 121 CT series + 121 SEG series. So "55 subjects"
// here means 55 subjects OF THIS DEMO, not the collection's total. Re-derive with:
//
//   SELECT collection_id, source_DOI, license_short_name, Modality, count(*)
//   FROM index WHERE crdc_series_uuid IN (<the uuids in cases.json>) GROUP BY 1,2,3,4
//
// Verified against IDC v25 (idc-index-data 25.0.5) on 2026-10-21.

/** The IDC data release the links and DOIs below were verified against. */
export const IDC_VERSION = "v25";

const PORTAL = "https://portal.imaging.datacommons.cancer.gov";

/** Keyed by the demo's own collection tag (`coll` in cases.json / the ?coll= parameter). */
export const COLLECTIONS = {
  mets: {
    key: "mets",
    id: "spine_mets_ct_seg",
    name: "Spine-Mets-CT-SEG",
    title: "Spine metastatic bone cancer: pre and post radiotherapy CT (Spine-Mets-CT-SEG)",
    doi: "10.7937/kh36-ds04",
    doiUrl: "https://doi.org/10.7937/kh36-ds04",
    infoUrl: `${PORTAL}/collections/spine_mets_ct_seg/`,
    exploreUrl: `${PORTAL}/explore/filters/?collection_id=spine_mets_ct_seg`,
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    refSource: "expert and semi-automated vertebral segmentation labels, from the collection",
    used: { subjects: 55, ct: 55, seg: 55 },
    citation:
      "Pieper, S., Haouchine, N., Hackney, D., Wells, W., Sanhinova, M., Balboni, T., " +
      "Spektor, A., Huynh, M., Tanguturi, S., Kim, E., Guenette, J., Kozono, D., " +
      "Czajkowski, B., Caplan, S., Doyle, P., Kang, H., & Alkalay, R. (2024). " +
      "Spine metastatic bone cancer: pre and post radiotherapy CT (Spine-Mets-CT-SEG) " +
      "(Version 1) [Data set]. The Cancer Imaging Archive. https://doi.org/10.7937/KH36-DS04",
  },
  myeloma: {
    key: "myeloma",
    id: "spinal_multiple_myeloma_seg",
    name: "Spinal-Multiple-Myeloma-SEG",
    title: "Segmentation of spinal multiple myeloma lesions in dual-energy CT (Spinal-Multiple-Myeloma-SEG)",
    doi: "10.7937/k4qv-hh78",
    doiUrl: "https://doi.org/10.7937/k4qv-hh78",
    infoUrl: `${PORTAL}/collections/spinal_multiple_myeloma_seg/`,
    exploreUrl: `${PORTAL}/explore/filters/?collection_id=spinal_multiple_myeloma_seg`,
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    refSource: "vertebra segmentation masks, from the collection",
    used: { subjects: 66, ct: 66, seg: 66 },
    citation:
      "Nohel, M., Válek, V., Rohan, T., Štork, M., Jakubíček, R., Chmelík, J., & Dostál, M. " +
      "(2026). Segmentation of spinal multiple myeloma lesions in dual-energy CT " +
      "(Spinal-Multiple-Myeloma-SEG) (Version 1) [Dataset]. The Cancer Imaging Archive. " +
      "https://doi.org/10.7937/k4qv-hh78",
  },
};

/** The archive and the platform the data was obtained through — both ask to be cited. */
export const PLATFORM = [
  {
    what: "NCI Imaging Data Commons",
    text:
      "Fedorov, A., Longabaugh, W. J. R., Pot, D., Clunie, D. A., Pieper, S., Aerts, H. J. W. L., " +
      "Homeyer, A., Lewis, R., Akbarzadeh, A., Bontempi, D., Clifford, W., Herrmann, M. D., " +
      "Höfener, H., Octaviano, I., Osborne, C., Paquette, S., Petts, J., Punzo, D., Reyes, M., " +
      "Schacherer, D. P., Tian, M., White, G., Ziegler, E., Shmulevich, I., Pihl, T., Wagner, U., " +
      "Farahani, K., & Kikinis, R. (2021). NCI Imaging Data Commons. Cancer Research, 81(16), " +
      "4188–4193. https://doi.org/10.1158/0008-5472.CAN-21-0950",
    url: "https://doi.org/10.1158/0008-5472.CAN-21-0950",
  },
  {
    what: "The Cancer Imaging Archive",
    text:
      "Clark, K., Vendt, B., Smith, K., Freymann, J., Kirby, J., Koppel, P., Moore, S., " +
      "Phillips, S., Maffitt, D., Pringle, M., Tarbox, L., & Prior, F. (2013). The Cancer " +
      "Imaging Archive (TCIA): Maintaining and Operating a Public Information Repository. " +
      "Journal of Digital Imaging, 26(6), 1045–1057. https://doi.org/10.1007/s10278-013-9622-7",
    url: "https://doi.org/10.1007/s10278-013-9622-7",
  },
];

/** The method whose output is compared against those reference labels. */
export const METHOD = [
  {
    what: "SPINEPS",
    text:
      "Möller, H., Graf, R., Schmitt, J., Keinert, B., Schön, H., Atad, M., Sekuboyina, A., " +
      "Streckenbach, F., Kofler, F., Kroencke, T., Bette, S., Willich, S. N., Keil, T., " +
      "Niendorf, T., Pischon, T., Endemann, B., Menze, B., Rueckert, D., & Kirschke, J. S. " +
      "(2024). SPINEPS—automatic whole spine segmentation of T2-weighted MR images using a " +
      "two-phase approach to multi-class semantic and instance segmentation. European " +
      "Radiology. https://doi.org/10.1007/s00330-024-11155-y",
    url: "https://doi.org/10.1007/s00330-024-11155-y",
  },
  {
    what: "SPINEPS segmentation source",
    text:
      "Graf, R., Schmitt, J., Schlaeger, S., Möller, H. K., Sideri-Lampretsa, V., Sekuboyina, A., " +
      "Krieg, S. M., Wiestler, B., Menze, B., Rueckert, D., & Kirschke, J. S. (2023). Denoising " +
      "diffusion-based MRI to CT image translation enables automated spinal segmentation. " +
      "European Radiology Experimental, 7, 70. https://doi.org/10.1186/s41747-023-00385-2",
    url: "https://doi.org/10.1186/s41747-023-00385-2",
  },
];

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One line naming where the loaded case's images came from — for a viewer's chrome. */
export function creditLine(collKey) {
  const c = COLLECTIONS[collKey] ?? COLLECTIONS.mets;
  return `CT and reference segmentation: <a href="${c.infoUrl}" target="_blank" rel="noopener">${esc(c.name)}</a>` +
    ` · NCI Imaging Data Commons · <a href="${c.doiUrl}" target="_blank" rel="noopener">doi:${esc(c.doi)}</a>` +
    ` · <a href="${c.licenseUrl}" target="_blank" rel="noopener">${esc(c.license)}</a>`;
}

/** The full attribution block. `only` limits it to one collection (a single-case viewer). */
export function citationsHTML({ only } = {}) {
  const colls = only ? [COLLECTIONS[only]].filter(Boolean) : Object.values(COLLECTIONS);
  const coll = (c) => `
    <div class="cite-coll">
      <div class="cite-h">${esc(c.name)}
        <span class="cite-lic"><a href="${c.licenseUrl}" target="_blank" rel="noopener">${esc(c.license)}</a></span>
      </div>
      <div class="cite-sub">${esc(c.title)}</div>
      <div class="cite-sub">Used here: ${c.used.subjects} subjects — ${c.used.ct} CT series and
        ${c.used.seg} segmentation series (${esc(c.refSource)}).</div>
      <div class="cite-links">
        <a href="${c.infoUrl}" target="_blank" rel="noopener">collection information</a>
        <a href="${c.exploreUrl}" target="_blank" rel="noopener">browse in the IDC portal</a>
        <a href="${c.doiUrl}" target="_blank" rel="noopener">doi:${esc(c.doi)}</a>
      </div>
      <p class="cite-ref">${
    esc(c.citation).replace(/(https:\/\/doi\.org\/\S+)$/, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`)
  }</p>
    </div>`;
  // The DOI at the end of a reference is the useful part — make it clickable rather than
  // leaving the reader to select a URL out of running text.
  const ref = (r) => {
    const body = esc(r.text).replace(
      /(https:\/\/doi\.org\/\S+)$/,
      (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`,
    );
    return `<p class="cite-ref"><b>${esc(r.what)}</b> — ${body}</p>`;
  };
  return `
    <p class="cite-lead">The images and the reference segmentations shown here are public data from the
      <a href="https://portal.imaging.datacommons.cancer.gov/" target="_blank" rel="noopener">NCI Imaging Data
      Commons</a> (IDC data release ${esc(IDC_VERSION)}), loaded straight from its public buckets by
      <code>crdc_series_uuid</code>. Both collections are CC BY 4.0: if you reuse anything from these pages,
      cite the collection it came from.</p>
    ${colls.map(coll).join("")}
    <div class="cite-coll">
      <div class="cite-h">Platform and archive</div>
      ${PLATFORM.map(ref).join("")}
    </div>
    <div class="cite-coll">
      <div class="cite-h">Segmentation method compared against the reference</div>
      <div class="cite-sub">The SPINEPS masks are ours, computed from the IDC images above with
        <a href="https://github.com/Hendrik-code/spineps" target="_blank" rel="noopener">SPINEPS</a>;
        they are derived works of CC BY 4.0 data and carry the same attribution requirement.</div>
      ${METHOD.map(ref).join("")}
    </div>`;
}

/** Styles for the block above. Injected once; scoped to .cite-* so a host page keeps its own look. */
export const CITE_CSS = `
.cite-lead { margin: 0 0 12px; max-width: 74ch; }
.cite-coll { margin: 0 0 14px; padding: 10px 12px; border: 1px solid var(--line, #1b2740);
  border-radius: 6px; background: var(--card, rgba(255,255,255,.02)); }
.cite-h { font-weight: 700; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.cite-lic a { font: 600 10px -apple-system, system-ui, sans-serif; letter-spacing: .4px;
  text-transform: uppercase; border: 1px solid currentColor; border-radius: 3px; padding: 0 4px;
  text-decoration: none; opacity: .85; }
.cite-sub { margin-top: 3px; color: var(--ink-2, #9fb3d0); max-width: 86ch; }
.cite-links { margin-top: 6px; display: flex; gap: 14px; flex-wrap: wrap; }
.cite-ref { margin: 8px 0 0; font-size: 11px; line-height: 1.5; color: var(--ink-2, #9fb3d0);
  max-width: 100ch; text-indent: -1.4em; padding-left: 1.4em; }
`;

/** Render the block into an element, injecting the styles the first time. */
export function renderCitations(el, opts = {}) {
  if (!document.getElementById("cite-style")) {
    const st = document.createElement("style");
    st.id = "cite-style";
    st.textContent = CITE_CSS;
    document.head.appendChild(st);
  }
  el.innerHTML = citationsHTML(opts);
  return el;
}
