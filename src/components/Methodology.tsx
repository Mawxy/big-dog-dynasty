export default function Methodology() {
  return (
    <footer style={{ maxWidth: 1150, margin: "0 auto", padding: "10px 24px 50px", color: "var(--dim)" }}>
      <details>
        <summary style={{ cursor: "pointer", color: "var(--acc)", fontSize: 14 }}>
          Methodology — how WAR &amp; WAA are computed
        </summary>
        <div className="about" style={{ marginTop: 12 }}>
          <h2>What is WAR / WAA?</h2>
          <p><b>WAR</b> (wins above replacement) and <b>WAA</b> (wins above average) estimate how many
            head-to-head wins a player added over a season, using this league's exact scoring and lineup rules.</p>
          <h2>The startable pool</h2>
          <p>Each week, all scored players fill the league's 108 lineup slots by actual points:
            12 QB, 24 RB, 36 WR, 12 TE, then the best remaining players take the 12 SUPER_FLEX (QB/RB/WR/TE)
            and 12 FLEX (RB/WR/TE) spots. Whether WR40 beats out RB26 for a flex is decided by the scoreboard.</p>
          <h2>Baselines</h2>
          <p><b>Average</b> = mean score of startable players at the position that week.{" "}
            <b>Replacement</b> = the best player at the position left out of the pool entirely (the next man up).</p>
          <h2>Points → wins</h2>
          <p>A player's weekly margin over baseline is converted to a win-probability shift using that week's
            actual spread of team scores: Φ(margin / (σ<sub>week</sub>·√2)) − 0.5. Big games in low-scoring
            weeks are worth more wins than the same line in a shootout. Weekly shifts are summed over the regular season.</p>
          <p>Byes and missed games contribute zero — players aren't penalized for weeks they didn't play,
            but they can't accumulate value either. Availability is part of the stat.</p>
          <h2>Reading the numbers</h2>
          <p>WAA ≈ 0 means "average starter." Negative WAA just means below the average <i>starter</i> —
            half the startable pool lands there by definition. In a 14-week season, +2 WAR is a superstar season.</p>
        </div>
      </details>
    </footer>
  );
}
