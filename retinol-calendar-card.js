/*
 * Retinol Calendar Card
 * A minimal Home Assistant Lovelace card showing which days retinol was used,
 * based on events in a calendar entity.
 *
 * Day-attribution rule: an event starting before `cutoff_hour` (default 07:00
 * local time) counts as the PREVIOUS day, so a log at 00:12 on the 21st
 * displays on the 20th.
 *
 * Config:
 *   type: custom:retinol-calendar-card
 *   entity: calendar.skincare   # calendar entity (default: calendar.skincare)
 *   weeks: 5                    # rolling window size in weeks (default: 5)
 *   cutoff_hour: 7              # events before this hour count as previous day
 *   title: Retinol Calendar     # card title (default: Retinol Calendar)
 */

class RetinolCalendarCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._page = 0; // 0 = current window; 1 = one window back, etc.
    this._events = null; // attributed day keys (Set of "YYYY-MM-DD")
    this._allDaySeen = false;
    this._fetchKey = null; // window key of the last fetch
    this._fetchedAt = 0;
  }

  static getStubConfig() {
    return { entity: "calendar.skincare", weeks: 5, cutoff_hour: 7 };
  }

  setConfig(config) {
    this._config = {
      entity: "calendar.skincare",
      weeks: 5,
      cutoff_hour: 7,
      title: "Retinol Calendar",
      ...config,
    };
    if (this._config.weeks < 1 || this._config.weeks > 12) {
      throw new Error("weeks must be between 1 and 12");
    }
    if (this._config.cutoff_hour < 0 || this._config.cutoff_hour > 12) {
      throw new Error("cutoff_hour must be between 0 and 12");
    }
    this._page = 0;
    this._fetchKey = null;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._maybeFetch();
  }

  getCardSize() {
    return 1 + (this._config ? this._config.weeks : 5);
  }

  /* ---------- date helpers (all local time) ---------- */

  _dayKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  _addDays(d, n) {
    const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    r.setDate(r.getDate() + n);
    return r;
  }

  _mondayOf(d) {
    const dow = (d.getDay() + 6) % 7; // Monday = 0
    return this._addDays(d, -dow);
  }

  // Visible window for the current page: N weeks ending with the current week,
  // shifted back page*N weeks.
  _window() {
    const weeks = this._config.weeks;
    const today = new Date();
    const thisMonday = this._mondayOf(today);
    const end = this._addDays(thisMonday, 6 - 7 * weeks * this._page); // Sunday
    const start = this._addDays(end, -(7 * weeks - 1)); // Monday
    return { start, end };
  }

  /* ---------- data ---------- */

  _maybeFetch() {
    if (!this._hass || !this._config) return;
    const { start, end } = this._window();
    const key = `${this._dayKey(start)}:${this._dayKey(end)}:${this._config.entity}`;
    const stale = Date.now() - this._fetchedAt > 5 * 60 * 1000;
    if (key === this._fetchKey && !stale) return;
    this._fetchKey = key;
    this._fetchedAt = Date.now();

    // Fetch one extra day past the window so an after-midnight log on the day
    // after the last visible day still attributes into the window.
    const fetchStart = start.toISOString();
    const fetchEnd = this._addDays(end, 2).toISOString();
    this._hass
      .callApi(
        "GET",
        `calendars/${this._config.entity}?start=${encodeURIComponent(
          fetchStart
        )}&end=${encodeURIComponent(fetchEnd)}`
      )
      .then((events) => {
        this._events = this._attribute(events || []);
        this._error = null;
        this._render();
      })
      .catch((err) => {
        this._events = new Set();
        this._error = `Could not load ${this._config.entity}: ${
          err && err.message ? err.message : err
        }`;
        this._render();
      });
  }

  // Map raw calendar events to a Set of attributed local day keys.
  _attribute(events) {
    const cutoff = this._config.cutoff_hour;
    const days = new Set();
    this._allDaySeen = false;
    for (const ev of events) {
      const s = ev.start || {};
      if (s.dateTime) {
        let d = new Date(s.dateTime);
        if (d.getHours() < cutoff) d = this._addDays(d, -1);
        days.add(this._dayKey(d));
      } else if (s.date) {
        // All-day event: no timestamp to shift. Count on its own date and
        // surface a notice, since the cutoff rule cannot apply.
        this._allDaySeen = true;
        days.add(s.date);
      }
    }
    return days;
  }

  /* ---------- rendering ---------- */

  _fmt(d) {
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  _render() {
    if (!this._config) return;
    const { start, end } = this._window();
    const today = new Date();
    const todayKey = this._dayKey(today);
    const days = this._events || new Set();
    const weeks = this._config.weeks;

    let rows = "";
    for (let w = 0; w < weeks; w++) {
      let cells = "";
      let count = 0;
      for (let i = 0; i < 7; i++) {
        const d = this._addDays(start, w * 7 + i);
        const key = this._dayKey(d);
        const used = days.has(key);
        if (used) count++;
        const isToday = key === todayKey;
        const future = d > today && !isToday;
        cells += `<td class="day${used ? " used" : ""}${
          isToday ? " today" : ""
        }${future ? " future" : ""}">${d.getDate()}</td>`;
      }
      rows += `<tr>${cells}<td class="count">${count}</td></tr>`;
    }

    const onCurrent = this._page === 0;
    const rangeLabel = onCurrent
      ? ""
      : `${this._fmt(start)} - ${this._fmt(end)}`;

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { padding: 16px; }
        .head {
          display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
        }
        .title {
          font-size: 1.2em; font-weight: 700;
          color: var(--primary-text-color, #212121);
          flex: 1;
        }
        .range {
          font-size: 0.85em;
          color: var(--secondary-text-color, #727272);
        }
        button.nav {
          background: none; border: none; cursor: pointer;
          font: inherit; font-size: 1em; padding: 2px 8px; border-radius: 4px;
          color: var(--primary-text-color, #212121);
        }
        button.nav:hover { background: var(--secondary-background-color, #f0f0f0); }
        button.nav[disabled] { opacity: 0.3; cursor: default; }
        button.today-btn {
          background: none; border: 1px solid var(--divider-color, #dcdcdc);
          border-radius: 4px; cursor: pointer; font-size: 0.8em; padding: 2px 8px;
          color: var(--primary-text-color, #212121);
        }
        table { border-collapse: collapse; width: auto; }
        th {
          font-weight: 700; padding: 2px 0 6px;
          color: var(--primary-text-color, #212121);
          text-align: center;
        }
        td.day {
          width: 2.2em; height: 2em; text-align: center;
          border: 1px solid transparent; border-radius: 3px;
          color: var(--primary-text-color, #212121);
        }
        td.day.used {
          background: var(--retinol-highlight, rgba(129, 199, 132, 0.35));
          border-color: var(--retinol-highlight-border, rgba(129, 199, 132, 0.9));
        }
        td.day.today { text-decoration: underline; text-underline-offset: 3px; }
        td.day.future { color: var(--disabled-text-color, #bdbdbd); }
        td.count {
          padding-left: 14px; text-align: right;
          color: var(--secondary-text-color, #727272);
        }
        .notice {
          margin-top: 8px; font-size: 0.8em;
          color: var(--warning-color, #b58a00);
        }
        .error {
          margin-top: 8px; font-size: 0.85em;
          color: var(--error-color, #b00020);
        }
      </style>
      <ha-card>
        <div class="head">
          <span class="title">${this._config.title}</span>
          <span class="range">${rangeLabel}</span>
          <button class="nav" id="back" title="Earlier">&#8249;</button>
          ${
            onCurrent
              ? ""
              : `<button class="today-btn" id="todayBtn">Today</button>`
          }
          <button class="nav" id="fwd" title="Later" ${
            onCurrent ? "disabled" : ""
          }>&#8250;</button>
        </div>
        <table>
          <tr><th>M</th><th>T</th><th>W</th><th>T</th><th>F</th><th>S</th><th>S</th><th></th></tr>
          ${rows}
        </table>
        ${
          this._allDaySeen
            ? `<div class="notice">Some events are all-day entries; the before-${this._config.cutoff_hour}:00 rule cannot apply to those.</div>`
            : ""
        }
        ${this._error ? `<div class="error">${this._error}</div>` : ""}
      </ha-card>
    `;

    this.shadowRoot.getElementById("back").onclick = () => {
      this._page++;
      this._render();
      this._maybeFetch();
    };
    this.shadowRoot.getElementById("fwd").onclick = () => {
      if (this._page > 0) {
        this._page--;
        this._render();
        this._maybeFetch();
      }
    };
    const tb = this.shadowRoot.getElementById("todayBtn");
    if (tb)
      tb.onclick = () => {
        this._page = 0;
        this._render();
        this._maybeFetch();
      };
  }
}

customElements.define("retinol-calendar-card", RetinolCalendarCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "retinol-calendar-card",
  name: "Retinol Calendar Card",
  description:
    "Minimal calendar showing retinol days, with after-midnight logs counted to the previous evening.",
});
