/** Always-visible methodology paragraph + market-value attribution. Replaces
 *  the v1 collapsed <details> Methodology block. */
export default function SiteFooter() {
  return (
    <footer className="site-foot">
      <p>
        WAR and WAA are computed from this league's exact scoring and lineup rules:
        each week's 108 startable slots are filled by actual points, baselines are set
        per position, and every player's margin becomes a win-probability shift using
        that week's own spread of team scores.
      </p>
      <div className="attr">
        Market values via <a href="https://keeptradecut.com/dynasty-rankings">KeepTradeCut</a>{" "}
        and <a href="https://fantasycalc.com/dynasty-rankings">FantasyCalc</a>
      </div>
    </footer>
  );
}
