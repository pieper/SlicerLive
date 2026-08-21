// Shared codec constants for the LiveRenderer wire format.
// Coded size = sample dims rounded up to this grid, so the NVENC encoder (fixed-size sessions,
// costly to create) reuses sessions across a drag. MUST equal the sidecar's grid.
export const AV1_GRID = 64;
