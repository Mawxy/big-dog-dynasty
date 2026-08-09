import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The one thing between a malformed data row and a white screen.
 *
 * Every board on this site indexes tuples straight out of static JSON, so a
 * missing element is a TypeError DURING RENDER — and React unmounts the whole
 * tree on an uncaught one. Before this, a single bad row in one season file
 * took down the masthead, the tab bar and every other page with it.
 *
 * It wraps the route content only, never the shell: the tab bar has to survive
 * so the reader can leave the broken page. `resetKey` is the pathname, so
 * navigating away clears the error without a reload — without it the boundary
 * latches and every subsequent page renders the same message.
 *
 * The detail line is the raw message on purpose. This is a hobby league board
 * read by twelve people; "something went wrong" with nothing to paste is worse
 * for the one person who can fix it than an exception string is for the rest.
 */
interface Props { children: ReactNode; resetKey?: string }
interface State { err: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    // no telemetry endpoint — the console IS the report
    console.error("render error", err, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.err && prev.resetKey !== this.props.resetKey) this.setState({ err: null });
  }

  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="errbox">
        <div className="k">Something broke</div>
        <div className="body">
          This page hit an error and stopped drawing. The rest of the board still works —
          pick another tab, or reload to try this one again.
        </div>
        <div className="acts">
          <button type="button" className="retry"
            onClick={() => this.setState({ err: null })}>Try again</button>
          <button type="button" className="retry"
            onClick={() => window.location.reload()}>Reload</button>
        </div>
        <div className="tnote">{String(this.state.err.message || this.state.err)}</div>
      </div>
    );
  }
}
