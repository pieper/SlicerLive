# Colorize-volume demo data — IDC pick (2026-08-18)

## Where TotalSegmentator results live in IDC

There is exactly ONE TotalSegmentator analysis result, and it covers exactly one collection:

    analysis_result_id   totalsegmentator_ct_segmentations
    title                TotalSegmentator segmentations and radiomics features for NCI IDC CT images
    collections          nlst          <- the ONLY one
    subjects             26,194
    SEG series           126,051       (AlgorithmName = "TotalSegmentator v1.5.6")
    DOI                  10.5281/zenodo.8347011
    license              CC BY 4.0

So "high-res CT with TotalSegmentator" means NLST (lung screening chest CT). Verified via the
auth-free IDC v3 DuckDB endpoint (POST https://api.imaging.datacommons.cancer.gov/v3/sql).

## The pick

    PatientID            218750          NLST, StudyDate 2001-01-02
    CT   SeriesInstanceUID  1.3.6.1.4.1.14519.5.2.1.7009.9004.139859765152523282624455168995
    SEG  SeriesInstanceUID  1.2.276.0.7230010.3.1.3.313263360.35342.1706317560.962438
    StudyInstanceUID       1.3.6.1.4.1.14519.5.2.1.7009.9004.327064502759230583173361683324
    CT   s3://idc-open-data/54f72056-5619-4843-93ff-9d468e74eb6c/*   158 MB, 299 objects
    SEG  s3://idc-open-data/af5c1dc6-31dd-4d9d-89e3-57d5e9da4e00/*   212 MB, 1 object
    OHIF https://viewer.imaging.datacommons.cancer.gov/viewer/1.3.6.1.4.1.14519.5.2.1.7009.9004.327064502759230583173361683324

    geometry   512 x 512 x 299 @ 0.566 x 0.566 x 1.25 mm, 373 mm z coverage
               uniform slice gap (max-min = 0.000), obliquity 0, regularly_spaced_3d_volume
    acquisition 120 kVp, 140 mA, STANDARD (smooth) kernel
    noise      ~10 HU sd in homogeneous soft tissue  -- diagnostic-grade, not typical low-dose
    segments   86, covering: all 12 rib pairs, C6->sacrum vertebrae individually, 5 lung lobes,
               4 heart chambers + myocardium, aorta / IVC / pulmonary artery / portal+splenic /
               iliacs, liver, spleen, pancreas, kidneys, adrenals, stomach, duodenum, colon,
               small intestine, gallbladder, oesophagus, trachea, iliopsoas, deep back muscle,
               scapula, clavicle, humerus, hip

## GOTCHA: the SEG is row-flipped relative to its own reference series

    CT  ImageOrientationPatient  [1, 0, 0,  0,  1, 0]   ImagePositionPatient y = -145.00
    SEG ImageOrientationPatient  [1, 0, 0,  0, -1, 0]   frame0            y = +144.43

The SEG column axis runs -y while the CT runs +y, so each SEG frame must be flipped on the row
axis before it indexes the CT grid:  mask = frame[::-1, :]

Everything else matches exactly -- same 512x512 grid, same 0.566 mm spacing, same 299 z
positions over the same range, and the SEG names the CT in ReferencedSeriesSequence.

Verification that the flip is right (mean HU inside each label):

    WRONG (unflipped)                RIGHT (flipped)
    Liver            -65.5           Liver             62.0
    Left ventricle  -538.6           Left ventricle    42.4
    Right scapula    -37.1           Right scapula    443.7
    lungs      -493 .. -711          lungs      -854 .. -861
    Aorta             77.2           Aorta             41.2

## Sizes for the demo

    full   512x512x299   CT r16 157 MB   baked RGBA8 314 MB
    crop   505x357x299                   baked RGBA8 216 MB
    2/3    336x238x199   CT r16  32 MB   baked RGBA8  64 MB
    half   252x178x149   CT r16  13 MB   baked RGBA8  27 MB

Recommended: do NOT ship baked RGBA. Ship the CT as r16 plus a uint8 label volume and do the
palette lookup in the shader -- half the bytes, and the palette and window stay interactive.
At 2/3 res that is 32 MB + 16 MB, comparable to the cardiac CTA (57 MB) already in the gallery.
The 86 colors come from RecommendedDisplayCIELabValue in the SEG's SegmentSequence.

## Runners-up (same query, smooth kernels only)

    PatientID  segs   px      thk    slices  kernel
    202752      87   0.664   1.25     308    STANDARD
    218750      86   0.566   1.25     299    STANDARD   <- pick
    207149      84   0.574   1.25     305    STANDARD
    212326      82   0.563   1.0      362    B30f       <- finest geometry overall
    215878      82   0.648   1.0      393    B30f       <- longest coverage
