export interface OfficeViewSize { width: number; height: number }
export interface OfficeParkBounds extends OfficeViewSize { x: number; y: number }
export interface OfficeCameraView { x: number; y: number; zoom: number }

const dimension = (value: number) => Number.isFinite(value) ? Math.max(1, value) : 1;

/** The lawn may grow along one axis to contain the overview on wide/tall screens.
 * Its coordinates remain independent of the office's walkable floor. */
export function officeParkLayout(world: OfficeViewSize, viewport: OfficeViewSize, margin: number, overviewMargin: number, overviewCap: number) {
  const width = dimension(viewport.width), height = dimension(viewport.height);
  const zoom = Math.min(overviewCap, width / (world.width + overviewMargin * 2), height / (world.height + overviewMargin * 2));
  const parkWidth = Math.ceil(Math.max(world.width + margin * 2, width / zoom));
  const parkHeight = Math.ceil(Math.max(world.height + margin * 2, height / zoom));
  return {
    bounds: { x: (world.width - parkWidth) / 2, y: (world.height - parkHeight) / 2, width: parkWidth, height: parkHeight },
    overview: { x: world.width / 2, y: world.height / 2, zoom },
  };
}

/** Bounds alone cannot cover a viewport bigger than the park at low zoom. */
export function constrainOfficeCamera(bounds: OfficeParkBounds, viewport: OfficeViewSize, view: OfficeCameraView, minimumZoom: number, maximumZoom: number): OfficeCameraView {
  const width = dimension(viewport.width), height = dimension(viewport.height);
  const lower = Math.max(minimumZoom, width / bounds.width, height / bounds.height);
  const zoom = Math.max(lower, Math.min(Math.max(maximumZoom, lower), view.zoom));
  const halfWidth = width / zoom / 2, halfHeight = height / zoom / 2;
  return {
    x: Math.max(bounds.x + halfWidth, Math.min(bounds.x + bounds.width - halfWidth, view.x)),
    y: Math.max(bounds.y + halfHeight, Math.min(bounds.y + bounds.height - halfHeight, view.y)),
    zoom,
  };
}
