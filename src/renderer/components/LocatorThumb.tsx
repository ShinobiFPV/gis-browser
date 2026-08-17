import { CANADA_BBOX, WORLD_BBOX } from '@shared/taxonomy';

interface Props {
  bbox: [number, number, number, number] | null;
  /** Draws the marker in the selected accent when true. */
  active?: boolean;
}

const W = 46;
const H = 24;

/**
 * Which map to draw this feature on.
 *
 * Canada when the feature is inside Canada, the world otherwise. Framing everything on
 * Canada was right when everything WAS Canada; with the catalog international it clamps
 * every foreign feature to the edge of the frame, so France, Japan and Texas all get an
 * identical marker pinned against the right-hand side -- confidently wrong, and precisely
 * the kind of thing that only shows up by looking at the rendered output.
 *
 * The Canadian frame is kept rather than going world-only because it is what makes the
 * thumbnail useful for the app's main job: telling Sarnia, Ontario from Sarnia No. 221 in
 * Saskatchewan. At world scale those two are the same pixel.
 */
function frameFor(bbox: [number, number, number, number] | null): typeof CANADA_BBOX {
  if (!bbox) return CANADA_BBOX;
  const [minx, miny, maxx, maxy] = bbox;

  // A wrapped extent (minx > maxx) crosses the antimeridian, so it is never inside Canada.
  if (minx > maxx) return WORLD_BBOX;

  const inside =
    minx >= CANADA_BBOX.minLon &&
    maxx <= CANADA_BBOX.maxLon &&
    miny >= CANADA_BBOX.minLat &&
    maxy <= CANADA_BBOX.maxLat;
  return inside ? CANADA_BBOX : WORLD_BBOX;
}

/**
 * A candidate thumbnail: where this feature is.
 *
 * Deliberately drawn from the bounding box the index already holds, not from geometry.
 * Rendering five real outlines would mean five geometry fetches on every keystroke-driven
 * search, which is exactly the "mirror all of Canada" cost the architecture avoids. For
 * telling Sarnia from Sarnia No. 221 in Saskatchewan -- which is the disambiguation an
 * artist actually needs from a list -- position is the useful signal anyway.
 */
export function LocatorThumb({ bbox, active = false }: Props): React.JSX.Element {
  const frame = frameFor(bbox);
  const { minLon, minLat, maxLon, maxLat } = frame;
  const lonSpan = maxLon - minLon;
  const latSpan = maxLat - minLat;

  const toX = (lon: number): number => ((lon - minLon) / lonSpan) * W;
  const toY = (lat: number): number => H - ((lat - minLat) / latSpan) * H;

  let marker: React.JSX.Element | null = null;
  if (bbox) {
    const wrapped = bbox[0] > bbox[2];
    /*
     * A wrapped extent is measured the long way round, so its width and centre have to be
     * computed on the circle. Alaska's stored extent is 172.5..-130.0; subtracting gives
     * -302 degrees, which would draw an inverted rectangle and put the crosshair in the
     * Indian Ocean.
     */
    const spanLon = wrapped ? 360 - bbox[0] + bbox[2] : bbox[2] - bbox[0];
    let midLon = bbox[0] + spanLon / 2;
    if (midLon > 180) midLon -= 360;

    const y1 = toY(bbox[3]);
    const y2 = toY(bbox[1]);
    // A reserve is under a pixel wide at national scale, so enforce a floor or the marker
    // vanishes for exactly the features this app is most used for.
    const w = Math.max(3, (spanLon / lonSpan) * W);
    const h = Math.max(3, y2 - y1);
    const cx = Math.min(W, Math.max(0, toX(midLon)));
    const cy = Math.min(H, Math.max(0, (y1 + y2) / 2));
    const cls = active ? 'thumb-marker active' : 'thumb-marker';
    marker = (
      <>
        {/* Crosshairs, because a 3px box in a 46x24 frame is hard to place by eye. */}
        <line x1={cx} y1={0} x2={cx} y2={H} className={active ? 'thumb-cross active' : 'thumb-cross'} />
        <line x1={0} y1={cy} x2={W} y2={cy} className={active ? 'thumb-cross active' : 'thumb-cross'} />
        <rect x={cx - w / 2} y={cy - h / 2} width={w} height={h} rx={1} className={cls} />
      </>
    );
  }

  return (
    <svg className="thumb" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
      <rect x={0} y={0} width={W} height={H} rx={2} className="thumb-frame" />
      {marker}
      {!bbox && (
        <line x1={4} y1={H / 2} x2={W - 4} y2={H / 2} className="thumb-empty" />
      )}
    </svg>
  );
}
