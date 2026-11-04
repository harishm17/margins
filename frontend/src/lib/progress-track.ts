/**
 * The edge of a progress track. The fill is the accent, but the empty part of a track (surface-3 on the canvas) is about 1.1:1,
 * so an empty bar read as no bar. This puts the control-border colour (3:1 on the canvas, light and dark) round the track, inside
 * it, so the track is a visible shape at 0% as well. Pass it as `className` to `Progress`; it is a little taller to keep a 4px fill.
 */
export const PROGRESS_TRACK = 'h-1.5 ring-1 ring-inset ring-control'
