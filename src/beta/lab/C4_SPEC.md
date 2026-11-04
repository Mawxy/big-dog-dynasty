# C4 "Tale of the Tape": design spec for the WAR Board beta shell

Written 2026-11-04 by Max. Trialled in the redesign lab — `#/<league>/lab/...`,
`src/beta/lab/` — which mounts the live beta shell screen for screen under the
`.v3.c4` root. Every C4 rule is scoped there; the live board is untouched.

**This spec is the only design source for the lab.** The broadcast
`war-board-design-system` skill does NOT apply to C4 (Max, 2026-11-04). Where the
old rules disagree (one accent per view, `--fg-4` captions, 3px verdict rule,
IBM Plex Mono figures), C4 wins.

Screens the canvas did not draw get C4 treatment by analogy — §5, last row.

---

## 0. Ground rules

1. **This is a restyle, not a redesign of content.** Every screen keeps its current modules, order, columns, figures and copy, word for word. Do not add, drop, merge or reword a module. If a layout choice in this spec would force a content change, keep the content and adapt the layout.
2. **Mobile first.** Design width is 390px. Desktop gets the same components, wider.
3. **No new hardcoded colors.** Every color comes from a token in section 2. Components never branch on the theme name.
4. **Zero radius stays.** C4 adds slanted edges (section 3). It does not add rounded corners, shadows, gradients or blur.
5. **Tabular figures everywhere.** `font-variant-numeric: tabular-nums` on every numeral, as today.

---

## 1. Typography

C4 uses Saira Condensed + Archivo. Both families already load in `index.html`.

| Role | Family | Spec |
|---|---|---|
| Display, labels, figures, tabs, badges | **Saira Condensed** | 600 / 700 / 800, uppercase for labels, tabular-nums |
| Names, body copy, captions | **Archivo** | 400 / 600, sentence case |

On `.v3.c4`: `--cond: "Saira Condensed"…; --sans: Archivo…; --mono: var(--cond)` (figures move from IBM Plex Mono to Saira Condensed, tabular).

| Element | Spec |
|---|---|
| Masthead title | Saira 700 18px, `letter-spacing: .04em`, uppercase |
| Masthead sub-label ("WAR BOARD") | Saira 600 10px, `.2em`, `--deep-dim` |
| Page title (PLAYERS, TRADE, player name) | Saira 800 36–40px, `.02em`, `line-height: 1` |
| Page subtitle | Archivo 12–12.5px, `--dim`, baseline-aligned beside the title |
| Section band label | Saira 600 12px, `.22em`, uppercase, `--deep-dim` |
| Band link ("VIEW ALL →", "TEAMS →") | Saira 700 13px, `.12em`, `--deep-acc` |
| Band note (the line under a band) | Archivo 11.5px, `--dim`, `padding: 6px 16px 4px` |
| Column header row | Saira 600 11px, `.12em`, `--dim`, on `--band` |
| Player name in a row | Saira 700 16–17px, `.03em`, uppercase, `line-height: 1.1` |
| Franchise name in a row | Archivo 600 13px; manager under it Archivo 11px `--dim` |
| Row figure | Saira 700–800 15–18px, right-aligned |
| Row sub-figure ("173.8 ppg", "84%") | Archivo 10.5px `--dim`, right-aligned under the figure |
| Slab label | Saira 700 11–13px, `.12–.14em` |
| Slab figure | Saira 800 34–40px, `line-height: .9` |
| Callout headline | Saira 800 24–26px, `.02em` |
| Body copy (outlook, model read) | Archivo 13.5px, `line-height: 1.55`, `--txt2` |
| Glossary / methodology captions | Archivo 11–11.5px, `line-height: 1.5`, `--dim` |
| Bottom nav | Saira 600 14px, `.12em`; active 800 |

C4 uses `--dim` for every caption that carries meaning (`--dim3` fails 4.5:1 in the light themes).

---

## 2. Color: four themes

| Theme id | Name | Character |
|---|---|---|
| `original` | Original | Gold on carbon (today's look). **Default.** |
| `newsprint` | Newsprint | Cream newsprint, black bars, cobalt accent |
| `ringside` | Ringside blue | Electric blue on navy-black |
| `vintage` | Vintage | Cream poster, navy bars, red accent |

### 2.1 Mechanism (as built)

- `data-theme` on `<html>`, set only while the lab is mounted (`lab/LabShell.tsx`), and before first paint by the boot script in `index.html` when the address is a lab address. Tokens per theme under `:root[data-theme="…"]` in `src/style.css`; `original` has no block.
- Persisted in `localStorage` under `warboard.v3.theme` (`lab/theme.ts`).
- `<meta name="theme-color">` follows the theme's `--deep`.
- The picker is More → "Appearance" (lab only): four rows, name + four swatches (`--deep`, `--bg`, `--acc`, `--war`), the selected row marked with an `--acc` slab. Instant, no reload.

### 2.2 Tokens

Existing names keep their meaning; **new** tokens are the C4 parts. Values for all four themes live in `src/style.css` — that file is the source of truth.

| Token | Role |
|---|---|
| `--deep` | Bars: masthead, section bands, bottom nav, rank cells |
| `--bg` | Board / page |
| `--band` | Raised surface: column-header rows, callouts, tiles |
| `--zebra` / `--sel` | Alternate rows / selected row |
| `--rule` / `--rule-2` / `--hair` | Lines / stronger line, bar tracks / row separators, tape-bar track |
| `--txt` / `--txt2` / `--dim` / `--dim2` / `--dim3` | Text ramp; `--dim3` decorative only |
| `--acc` / `--acc-ink` / `--acc-dim` | Accent / text on accent / mid-range bar fill |
| `--good` / `--bad` / `--drop` / `--warn` | Signed values, roster removal, caution |
| `--qb` … `--te`, `--qb-mark` … `--te-mark` | Row spines / badge fill and position-rank text |
| `--honor-*` | Honor marks; `--honor-champ` gold in every theme |
| `--deep-ink` **new** | Primary text on `--deep` bars |
| `--deep-dim` **new** | Labels and inactive tabs on bars |
| `--deep-acc` **new** | Links on bars ("VIEW ALL →"). Never put `--acc` text on `--deep`. |
| `--slab-hi` / `--slab-hi-ink` **new** | High-contrast slab: active tab, "you" side of a matchup |
| `--slab-lo` / `--slab-lo-ink` **new** | Secondary slab: inactive tab, other side, chips |
| `--loss` **new** | Losing bar in a tape row |
| `--war` / `--war-ink` **new** | WAR fills / WAR figures as text. Never falls back to `--acc`. |

### 2.3 Where the accent goes

1. Active bottom-nav tab: solid `--acc` fill, `--acc-ink` text.
2. The center slab of a tale panel, when it is the headline or "your" matchup.
3. Your own franchise and your own players: name text in `--acc`.
4. The winning bar in a tape row, and the winning verdict.
5. The active segment of a segmented control, the active sort tab, the selected offer chip.
6. Links on the board ("+ ADD", "ALL →"). On bars, `--deep-acc`.
7. The stripe on a callout, except WAR callouts, which use `--war`.

Rank 1–2 seeds take it on their rank badge; that is the only table use.

---

## 3. The slant system

Every slanted edge uses **the same angle**: horizontal offset = **20% of the element's height**. Neighbouring slanted edges are parallel with a **4px gutter**. Never a percentage of width.

```css
.cut    { clip-path: polygon(0 0, 100% 0, calc(100% - var(--s)) 100%, 0 100%); }
.start  { clip-path: polygon(var(--s) 0, 100% 0, 100% 100%, 0 100%); }
.para   { clip-path: polygon(var(--s) 0, 100% 0, calc(100% - var(--s)) 100%, 0 100%); }
.mirror { clip-path: polygon(0 0, 100% 0, 100% 100%, var(--s) 100%); }
.trap   { clip-path: polygon(var(--s) 0, calc(100% - var(--s)) 0, 100% 100%, 0 100%); }
```

Two parallel slanted neighbours overlap by `--s − 4px` (`margin-left: calc(4px - var(--s))`).

| Element | Height | `--s` |
|---|---|---|
| Tale panel (hero) | 80px | 16px |
| League matchup card | 88px | 18px |
| Count boxes | 58px | 12px |
| Week tabs | 44px | 9px |
| Two-/three-segment tabs | 28–40px | 6–8px |
| Chips | 32–34px | 7px |
| Position badge | 24px | 5px |
| Rank badge | 22px | 4px |

In `c4.css` these are mixins on existing selectors (the `--s` custom property plus the polygon), not new markup.

---

## 4. Components

All measurements at 390px. Gutters 12px for slab rows, 16px for table rows (12px on the left when a 4px spine is present).

### 4.1 Masthead and bottom nav
- Masthead: `--deep`, `--rule` bottom border, padding 10px 16px. Left: league name ▾ (the switcher) over "WAR BOARD". Right: SEARCH, 1px `--deep-dim` outline, Saira 600 13px `.14em`.
- Bottom nav: `--deep`, `--rule` top border, five equal cells (existing `TABS`). Inactive `--deep-dim`; active a solid `--acc` block, `--acc-ink`, weight 800. Height `--navh`.

### 4.2 Section band
Full-bleed `--deep` strip, 1px `--rule` top and bottom; label `--deep-dim`, link `--deep-acc`. The band note sits UNDER the band: Archivo 11.5px `--dim`. 16px of space above every band except one directly under the masthead. Replaces every card or box between modules.

### 4.3 Tale panel (the hero triple)
`grid-template-columns: 1fr 84–96px 1fr; height: 80px`. Left `.cut` `--slab-hi` (label top-left, figure bottom-left, padding `8px 22px 8px 12px`); center `.trap` `--acc` centered, `margin: 0 -12px`; right `.mirror` `--slab-lo` (label top-right, figure bottom-right, padding `8px 12px 8px 22px`). Mirror-symmetric; left and right always equal width. Used on My Team (record / DVI rank / proj WAR), Player and the Season main event. League matchup cards: 88px variant; "you" side + center `--slab-hi` / `--acc`, other games `--slab-lo` / `--deep` center with `--deep-ink`; both sides show name, moneyline (800 26px), "PROJ 139.4"; spread and total in the center, ◂ ▸ toward the favourite.

### 4.4 Tale-of-the-tape rows
Grid `58px 1fr 96px 1fr 58px`, gap 6px, padding `7px 12px`, `--hair` bottom border. Bars 8px on a `--hair` track; left bar right-anchored, right bar left-anchored; width = value / larger of pair (lower-is-better inverted). Winner bar `--acc`, figure `--txt`; loser bar `--loss`, figure `--dim`; tie both `--loss`, figures `--txt`, verdict "EVEN" `--dim`. Verdict under the row aligned to the winner, Saira 800 13px `.12em` `--acc`. Section title "TALE OF THE TAPE" Saira 800 18px `.24em` between two 2px `--rule` lines, legend row Saira 600 11px `.14em` `--dim`.

### 4.5 Tables
- Column-header row: `--band`, `padding: 5px 16px 5px 12px`, Saira 600 11px `.12em` `--dim`; numeric headers right-aligned.
- Body row: min-height 42–48px, `--hair` bottom border, `padding: 0 16px 0 12px`. No zebra unless the screen already uses it.
- Row spine: 4px left inset in the position colour, or `--acc` for your own row.
- Rank badge: 30×22, `.cut` `--s: 4px`, Saira 800 14px. Standings: seeds 1–2 `--acc`, 3–6 `--slab-hi`, rest `--slab-lo`. Leaderboards: ranks 1–3 `--slab-hi`, rest `--slab-lo`.
- Position badge: 22–24px, `.cut` `--s: 5px`, filled `--*-mark`, text `--bg`, Saira 800 12–13px. Position rank in a sub-line: Saira 700 in `--*-mark`.
- Figures: right-aligned Saira, sub-figures stacked under. WAR figures always `--war-ink`. Signed values `--good` / `--bad`, U+2212 minus.

### 4.6 Tabs, segments and chips
- Segmented control: adjacent slabs, first `.cut`, middle `.para`, last `.start`, 4px gutter, `--s` 6–8px. Active `--slab-hi` (or `--acc` where it is the headline selection). Inactive `--slab-lo`. Saira 700–800 14–16px `.14em`.
- Text tabs (secondary filters): Saira 700 14px `.12em`; inactive `--dim`, active `--txt` with `box-shadow: inset 0 -2px 0 var(--acc)`.
- Sort strip (Players): full-width `--deep` grid of equal cells; active solid `--acc` / `--acc-ink`; inactive `--deep-dim`.
- Chips: `.para` `--s: 7px`, 32–34px tall, 4px gutters. ALL / selected `--slab-hi`; other position chips `--slab-lo` with the label in the position's `--*-mark`.
- Week tabs (Season): 50×44 `.para` `--s: 9px`. Selected `--slab-hi`, final `--slab-lo`, next `--band` + `--acc` text, future `--band` + `--dim`.

### 4.7 Callout
8px `--acc` stripe left, `--band` body, padding 10px 12px. Label Saira 700 14px `.2em` `--acc`; meta Saira 600 12px `.08em` `--dim`; body Archivo 13.5px/1.55 `--txt2`. WAR callouts: `--war` stripe, `--war-ink` label and figure.

### 4.8 Count boxes and figure tiles
Trades / Roster moves: two 58px slabs, `.cut` then `.start`, `--s: 12px`, 4px gutter, both `--slab-lo`; label Saira 700 11px `.16em`, count Saira 800 26px, "ALL →" in `--acc`. Market strip (My Team): full-width `--band` row, label, figure Saira 800 22px, sub-label inline.

### 4.9 Honors
Keep `HonorMarks.tsx` marks and meanings; colours from `--honor-*`. Counts ("×2") after the mark in Saira 700.

---

## 5. Screen notes

Every screen keeps today's content.

| Screen | Map |
|---|---|
| **League** | Current/History segmented → This week band with the week picker as a `--slab-lo` button on the band → "Pregame line" + league median (right-aligned) → matchup tale panels (88px) → Weekly recap as a callout → Last week band: four rows (label with a 4px `--acc` left rule, sentence, figure in `--good`/`--bad`/`--war-ink`), then the four position leaders with position badges → Standings → Playoff race → Top performers (WAR `--war-ink`) → Last 7 days (count boxes) → Win now vs dynasty, Dynasty movers, Market movers (two halves under a `--band` sub-header) → freshness line. |
| **My Team** | ← BACK / FRANCHISE → name (Saira 800 38px), manager, THIS IS ME (1px `--acc` outline), honors → tale panel (Record / DVI rank / Proj WAR) → Market strip → section-jump chips → Outlook callout → DVI / CVI / Stats segmented → Lineup, Bench, Taxi squad, Draft capital tables (traded picks 45% opacity) → Last 7 days → Seasons → Head to head (text tabs) → Record book → Top 10 (text tabs) → Strengths and Second string (ranks 1st–3rd `--good`, 10th–12th `--bad`). |
| **Players** | PLAYERS + subtitle → Value/Stats segmented with FIND · FILTER links → position chips → sort strip → header with a KEY outline button → rows (rank badge, name, owner · position rank, DVI figure, "CVI x · WAR y" sub-line) → the "top N of M" note and key paragraph in a `--band` callout with a `--rule-2` stripe. |
| **Trade** | TRADE + subtitle → Build/History segmented → offer chips → two equal side columns under `--deep` side headers: player rows with ×, "+ ADD", tally on `--band` → WHO'S FAVORED callout header → tape rows with verdicts. Both sides neutral (`--txt`) until a tape row assigns a winner. |
| **Player** | ← BACK + jump search → position badge + team, name (Saira 800 40px), meta line, honors → tale panel → Career WAR tiles → jump chips → Career WAR bars (projected `--loss`, played `--war`) → Model read callout → Projection, Comparables, Career, Usage (text tabs), Ownership, Market value. |
| **Everything else** | Bands between modules, column-header rows on `--band`, rank and position badges, segmented controls and text tabs, tale panels wherever a screen already pairs two sides. |

---

## 6. Acceptance checks

- Every theme at 390px on League, My Team, Players, Trade and Player: no clipped names in slabs, no horizontal page scroll, parallel slant edges with an even 4px gutter.
- Contrast ≥ 4.5:1 for every meaningful text pair in all four themes (`--dim` on `--band`, `--deep-acc` on `--deep` especially).
- WAR renders in `--war-ink` in every theme, never `--acc`.
- Theme switch is instant and survives a reload with no flash; `theme-color` matches `--deep`.
- Content diff is empty: same modules, same order, same copy.
- No hex colours in `src/beta/lab/*.css` — tokens only.

Canvas (private to Max): "WAR Board — Six New Directions", https://claude.ai/artifact/KHj4a1QPXr1zSeSEU7rBg7 — artboards `TapeLeague*`, `TapeMyTeamOriginal`, `TapePlayersNowOriginal`, `TapePlayerNowOriginal`, `TapeTradeNowSaira`, `TapePlayerVintage`, `TapeSeasonVintage`, `TapeTeamsVintage`.
