import { createContext, useContext } from "react";
import { MATRIX_CURVES, type MatrixCurve } from "./types";

/**
 * WHICH PROJECTION THE WHOLE SITE IS BEING READ UNDER.
 *
 * DVI, CVI and projected WAR all descend from one projection, and until now the
 * site published exactly one and never said which. This is the global switch:
 * one of the six curves in projections_matrix.json, applied everywhere those
 * figures appear.
 *
 * It is the ONLY global control on the site, and that is why it lives in the
 * masthead rather than in the views — the deliberate opposite of the season
 * picker, which is per-view because only some views are season-scoped (see the
 * note in App.tsx's masthead). A global control that changes numbers on screens
 * where it isn't visible is a trap; the masthead is on every screen, so it
 * can't be out of sight while it's biting.
 *
 * THE URL CARRIES IT. `?m=analog_natural` on the hash path, so a link you send
 * someone shows them the numbers you were looking at. Without that, "look at
 * Josh Allen's DVI" means different things to two people with different
 * settings, and neither has any way to tell. localStorage only remembers the
 * choice between sessions; the URL is what makes it shareable, so the URL wins
 * when the two disagree.
 */
export const MODELS = ["scalar", "analog", "blend"] as const;
export const STREAMS = ["natural", "composite"] as const;
export type Model = typeof MODELS[number];
export type Stream = typeof STREAMS[number];

/** Blend over scalar because the analog arm is a real second opinion the
 *  scalar model cannot express; composite over natural because Sleeper's read
 *  is the only input that knows about this season's depth charts. Mirrors
 *  DEFAULT_CURVE in scripts/curves.py — the pipeline publishes dvi.json on it. */
export const DEFAULT_CURVE: MatrixCurve = "blend_composite";

export const curveOf = (m: Model, s: Stream) => `${m}_${s}` as MatrixCurve;
export const splitCurve = (c: MatrixCurve) => {
  const [m, s] = c.split("_") as [Model, Stream];
  return { model: m, stream: s };
};

/** What each half of a curve name means, for the control's tooltips. Short —
 *  these are hover text on a masthead chip, not documentation. */
export const MODEL_NOTE: Record<Model, string> = {
  scalar: "One number per career: a recency- and games-weighted rate. Shape is lost.",
  analog: "The k most similar historical player-seasons, and what they did next.",
  blend: "The two above, weighted by how much the analog cohort is worth.",
};
export const STREAM_NOTE: Record<Stream, string> = {
  natural: "What the model believes from a player's own record, and nothing else.",
  composite: "The above, folded with Sleeper's projection — the only input that knows about this season.",
};

export const isCurve = (v: string | null | undefined): v is MatrixCurve =>
  !!v && (MATRIX_CURVES as readonly string[]).includes(v);

export interface ModelCtx {
  curve: MatrixCurve;
  setCurve: (c: MatrixCurve) => void;
  /** true while index_models.json is still loading, so a screen can hold its
   *  figures rather than flashing the default curve's numbers and correcting */
  loading: boolean;
  /** false when the data predates index_models.json — the control hides rather
   *  than offering six choices that all return the same file */
  available: boolean;
}

export const ModelContext = createContext<ModelCtx>({
  curve: DEFAULT_CURVE, setCurve: () => {}, loading: false, available: false,
});

export const useModel = () => useContext(ModelContext);
