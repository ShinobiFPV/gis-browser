/**
 * shapefile 0.6 ships no type declarations, and there is no @types package.
 *
 * Only the surface verified against real archives is declared. The Node build accepts
 * filesystem paths for both the .shp and the .dbf and streams them, which is what makes
 * a 78 MB .shp readable without loading it whole.
 */
declare module 'shapefile' {
  export interface ShapefileGeometry {
    type: string;
    coordinates: unknown;
  }

  export type ShapefileProperties = Record<string, unknown>;

  export interface ShapefileFeature {
    type: 'Feature';
    properties: ShapefileProperties | null;
    geometry: ShapefileGeometry | null;
  }

  export interface ShapefileSource {
    /** Header bounding box, in the file's own coordinates. */
    bbox: number[] | undefined;
    read(): Promise<{ done: boolean; value: ShapefileFeature }>;
    cancel(): Promise<void>;
  }

  export interface OpenOptions {
    /** dbf text encoding, e.g. "utf-8". Taken from the .cpg when the archive ships one. */
    encoding?: string;
  }

  export function open(
    shp: string,
    dbf?: string | null,
    options?: OpenOptions,
  ): Promise<ShapefileSource>;

  export function read(
    shp: string,
    dbf?: string | null,
    options?: OpenOptions,
  ): Promise<{ type: 'FeatureCollection'; bbox?: number[]; features: ShapefileFeature[] }>;
}
