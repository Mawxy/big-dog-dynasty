import { MODEL_NOTE, MODELS, STREAM_NOTE, STREAMS, curveOf, splitCurve, useModel } from "../lib/model";

/**
 * The masthead's projection-model control.
 *
 * TWO CONTROLS, NOT ONE SIX-WAY. The six curves are 3 models x 2 streams, and a
 * flat list of six hides that. Split, it reads as what it is: which model, and
 * whether Sleeper's opinion is folded in. Five segments instead of six, and the
 * axes stay legible.
 *
 * NOT ACCENT-FILLED. The design system's lens control fills the selected
 * segment with --acc, but that is for a control inside one view. This one sits
 * above every view, so an accent here would compete with each screen's headline
 * figure for the one accent that screen is allowed. Selected reads as --txt on
 * --band instead: quieter, and it still wins against --dim2.
 *
 * It hides itself when the data predates index_models.json rather than offering
 * six choices that all return the same numbers.
 */
export default function ModelPicker() {
  const { curve, setCurve, available } = useModel();
  if (!available) return null;
  const { model, stream } = splitCurve(curve);
  return (
    <div className="mpick" role="group" aria-label="Projection model">
      <div className="mseg">
        {MODELS.map(m => (
          <button key={m} type="button" title={MODEL_NOTE[m]}
            className={m === model ? "on" : ""}
            aria-pressed={m === model}
            onClick={() => setCurve(curveOf(m, stream))}>{m}</button>
        ))}
      </div>
      <div className="mseg">
        {STREAMS.map(s => (
          <button key={s} type="button" title={STREAM_NOTE[s]}
            className={s === stream ? "on" : ""}
            aria-pressed={s === stream}
            onClick={() => setCurve(curveOf(model, s))}>{s}</button>
        ))}
      </div>
    </div>
  );
}
