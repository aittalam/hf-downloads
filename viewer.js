/* HF Download History viewer.
 *
 * Core   - pure functions (no DOM): JSONL parsing, series/option building.
 *          Exported for Node so the option builder can be tested headlessly
 *          against a real .jsonl file (see viewer-echarts-ssr.mjs / viewer-core-test.mjs).
 * UI     - DOM glue: file loading, repo picker, time-range bar, chart instance.
 *
 * Time range is held in `win` (axis units: ms in time mode, days-of-life in
 * align mode). It survives metric / log-scale / repo-selection changes because
 * those only patch `series` + `yAxis`. Switching time<->align mode swaps the
 * axis unit, so each mode keeps its own remembered window in `savedRange`.
 */
(function (global) {
  'use strict';

  var DAY = 86400000;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* Metric definitions.
   *   kind     - value       : read the field directly
   *              cumulative  : read the field directly (line)
   *              daily       : day-over-day diff of `field` (first sample dropped)
   *   agg      - how the context (overview) strip aggregates across repos
   *              sum         : raw value summed over repos
   *              delta       : change of `field` since previous sample, clamped >= 0
   */
  var METRICS = {
    downloads_30d: { field: 'd30', kind: 'value', agg: 'sum', bar: true, label: 'Downloads (30d)' },
    downloads_all_time: { field: 'all', kind: 'cumulative', agg: 'delta', bar: false, label: 'Downloads (all time, cumulative)' },
    downloads_daily: { field: 'all', kind: 'daily', agg: 'delta', bar: true, label: 'Downloads (daily, from all-time diffs)' },
    likes: { field: 'likes', kind: 'value', agg: 'sum', bar: false, label: 'Likes' }
  };

  var COLORS = [
    '#c0392b', '#2980b9', '#27ae60', '#8e44ad', '#d35400',
    '#16a085', '#e8433c', '#7f8c8d', '#f39c12', '#1abc9c'
  ];

  // Layout: pixel-exact so the overview grid and the slider track share scales.
  var LAYOUT = {
    marginLeft: 64,
    marginRight: 20,
    main: { top: 40, bottom: 122 },     // main plot (room for its own x labels)
    ctx: { bottom: 46, height: 52 },    // overview sparkline (never zoomed)
    slider: { bottom: 12, height: 32 }, // draggable window on top of the overview scale
    minSpanDays: 2                      // never allow a degenerate window
  };

  function xOf(row, mode) { return mode === 'time' ? row.ts : row.life; }

  function parseLines(text) {
    var records = [], bad = 0;
    var lines = String(text).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var rec;
      try { rec = JSON.parse(line); } catch (e) { bad++; continue; }
      if (!rec || typeof rec.repo !== 'string' || !rec.timestamp) { bad++; continue; }
      var ts = Date.parse(rec.timestamp);
      if (!isFinite(ts)) { bad++; continue; }
      records.push({
        repo: rec.repo,
        type: rec.type || 'model',
        ts: ts,
        d30: rec.downloads_30d || 0,
        all: rec.downloads_all_time || 0,
        likes: rec.likes || 0
      });
    }
    return { records: records, bad: bad };
  }

  /* Group by repo, sort, add per-repo derived fields:
   *   life = days since this repo's own first sample (align-mode x)
   * Returns the meta object the rest of Core and the UI work from.
   */
  function buildMeta(records) {
    var byRepo = {}, repoMax = {};
    var t0 = Infinity, t1 = -Infinity;

    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      var b = byRepo[r.repo];
      if (!b) b = byRepo[r.repo] = { repo: r.repo, type: r.type, rows: [], firstTs: 0, lastLife: 0 };
      b.rows.push({ ts: r.ts, d30: r.d30, all: r.all, likes: r.likes, life: 0 });
      if (r.all > (repoMax[r.repo] || 0)) repoMax[r.repo] = r.all;
      if (r.ts < t0) t0 = r.ts;
      if (r.ts > t1) t1 = r.ts;
    }

    var repos = Object.keys(byRepo).sort(function (a, b) { return repoMax[b] - repoMax[a]; });
    var maxLife = 0;
    for (var k = 0; k < repos.length; k++) {
      var bb = byRepo[repos[k]];
      bb.rows.sort(function (a, c) { return a.ts - c.ts; });
      bb.firstTs = bb.rows[0].ts;
      for (var j = 0; j < bb.rows.length; j++) {
        bb.rows[j].life = (bb.rows[j].ts - bb.firstTs) / DAY;
      }
      bb.lastLife = bb.rows[bb.rows.length - 1].life;
      if (bb.lastLife > maxLife) maxLife = bb.lastLife;
    }

    // Pin the domain to UTC day boundaries: the overview strip aggregates per
    // UTC day, so its points must fall inside the domain (see Core.domainOf).
    var t0d = Math.floor(t0 / DAY) * DAY;
    var t1d = Math.ceil(t1 / DAY) * DAY;
    var globalSpanDays = (t1d - t0d) / DAY;
    return {
      byRepo: byRepo,
      repoMax: repoMax,
      repos: repos,
      t0: t0,
      t1: t1,
      t0d: t0d,
      t1d: t1d,
      maxLife: maxLife,
      globalSpanDays: globalSpanDays,
      // align-mode domain covers both every repo's life and the whole calendar span
      indexDomainMax: Math.max(globalSpanDays, maxLife) + 1
    };
  }

  function domainOf(mode, meta) {
    return mode === 'time' ? [meta.t0d, meta.t1d] : [0, meta.indexDomainMax];
  }

  function minSpan(mode) { return mode === 'time' ? LAYOUT.minSpanDays * DAY : LAYOUT.minSpanDays; }

  function clampWindow(mode, domain, start, end) {
    var lo = domain[0], hi = domain[1], ms = minSpan(mode);
    start = Math.max(lo, Math.min(start, hi - ms));
    end = Math.min(hi, Math.max(end, start + ms));
    return { start: start, end: end };
  }

  /* y value of `row`, given its predecessor (daily needs the previous sample). */
  function yOf(row, prev, metric) {
    var m = METRICS[metric];
    if (m.kind === 'daily') {
      if (!prev) return null;
      return row[m.field] - prev[m.field];
    }
    return row[m.field];
  }

  function mainSeries(state) {
    var out = [];
    var m = METRICS[state.metric];
    for (var i = 0; i < state.selected.length; i++) {
      var repo = state.selected[i];
      var bucket = state.meta.byRepo[repo];
      if (!bucket) continue;
      var color = COLORS[i % COLORS.length];
      var data = [];
      for (var j = 0; j < bucket.rows.length; j++) {
        var row = bucket.rows[j];
        var prev = j > 0 ? bucket.rows[j - 1] : null;
        var y = yOf(row, prev, state.metric);
        if (y === null) continue; // daily: first sample has no predecessor
        data.push([xOf(row, state.mode), y]);
      }
      var base = {
        name: repo,
        id: 'repo:' + repo,
        data: data,
        filterMode: 'filter',   // zoomed-away points drop out, so y auto-fits the window
        showSymbol: false
      };
      out.push(m.bar
        ? Object.assign(base, { type: 'bar', barMaxWidth: 26, barMinWidth: 0, itemStyle: { color: color } })
        : Object.assign(base, {
            type: 'line',
            symbol: 'circle',
            lineStyle: { width: 1.6, color: color },
            itemStyle: { color: color }
          }));
    }
    return out;
  }

  /* Overview strip: one series on grid #2 showing daily activity summed over
   * the selected repos. Cumulative metrics contribute their change since the
   * previous sample, so bursts are visible instead of a monotone ramp.
   * Its axis carries no dataZoom, so it always shows the whole timeline.
   */
  function contextSeries(state) {
    var m = METRICS[state.metric];
    var agg = {};
    for (var i = 0; i < state.selected.length; i++) {
      var bucket = state.meta.byRepo[state.selected[i]];
      if (!bucket) continue;
      for (var j = 0; j < bucket.rows.length; j++) {
        var row = bucket.rows[j];
        var prev = j > 0 ? bucket.rows[j - 1] : null;
        var v;
        if (m.agg === 'delta') {
          if (!prev) continue;
          v = Math.max(0, row[m.field] - prev[m.field]);
        } else {
          v = row[m.field];
        }
        var key = state.mode === 'time' ? Math.floor(row.ts / DAY) : Math.round(xOf(row, state.mode));
        agg[key] = (agg[key] || 0) + v;
      }
    }
    var data = Object.keys(agg).map(function (k) {
      return [state.mode === 'time' ? Number(k) * DAY : Number(k), agg[k]];
    }).sort(function (a, c) { return a[0] - c[0]; });

    return {
      name: '__overview',
      id: '__overview',
      type: 'line',
      xAxisIndex: 1,
      yAxisIndex: 1,
      data: data,
      showSymbol: false,
      silent: true,
      z: 1,
      lineStyle: { width: 1, color: '#90a4ae' },
      areaStyle: { color: 'rgba(144,164,178,0.28)' }
    };
  }

  function pointCount(state, win) {
    var n = 0;
    for (var i = 0; i < state.selected.length; i++) {
      var bucket = state.meta.byRepo[state.selected[i]];
      if (!bucket) continue;
      for (var j = 0; j < bucket.rows.length; j++) {
        if (j === 0 && METRICS[state.metric].kind === 'daily') continue;
        var x = xOf(bucket.rows[j], state.mode);
        if (x >= win.start && x <= win.end) n++;
      }
    }
    return n;
  }

  function fmtNumber(n) {
    n = Number(n);
    if (!isFinite(n)) return '-';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n * 100) / 100);
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(ms) { var d = new Date(ms); return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear(); }
  function fmtDateShort(ms) { var d = new Date(ms); return MONTHS[d.getUTCMonth()] + ' ' + pad(d.getUTCDate()); }
  function fmtDateISO(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function fmtWindowLabel(mode, v) {
    return mode === 'time' ? fmtDate(v) : 'Day ' + Math.round(v);
  }

  function buildOption(state) {
    var mode = state.mode, domain = state.domain, log = !!state.log;
    var series = mainSeries(state).concat([contextSeries(state)]);
    var xCommon = {
      min: domain[0],
      max: domain[1],
      axisLine: { lineStyle: { color: '#ddd' } },
      axisTick: { show: false },
      splitLine: { show: false },
      boundaryGap: false
    };
    var win = state.win || { start: domain[0], end: domain[1] };

    return {
      animation: false,
      textStyle: { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
      grid: [
        { left: LAYOUT.marginLeft, right: LAYOUT.marginRight, top: LAYOUT.main.top, bottom: LAYOUT.main.bottom },
        { left: LAYOUT.marginLeft, right: LAYOUT.marginRight, bottom: LAYOUT.ctx.bottom, height: LAYOUT.ctx.height }
      ],
      xAxis: [
        Object.assign({}, xCommon, {
          gridIndex: 0,
          type: mode === 'time' ? 'time' : 'value',
          axisLabel: {
            show: true,
            color: '#666',
            hideOverlap: true,
            formatter: function (v) { return mode === 'time' ? fmtDateShort(v) : String(Math.round(v)); }
          }
        }),
        Object.assign({}, xCommon, {
          // overview axis: same pinned domain as the main axis, no dataZoom attached
          gridIndex: 1,
          type: mode === 'time' ? 'time' : 'value',
          axisLabel: { show: false },
          axisLine: { show: false }
        })
      ],
      yAxis: [
        {
          gridIndex: 0,
          type: log ? 'log' : 'value',
          name: (METRICS[state.metric] || {}).label || state.metric,
          nameLocation: 'middle',
          nameGap: 46,
          nameRotate: -90,
          nameTextStyle: { fontSize: 11, color: '#888' },
          axisLabel: { color: '#666', formatter: function (v) { return fmtNumber(v); } },
          splitLine: { lineStyle: { color: '#f2f2f2' } }
        },
        { gridIndex: 1, axisLabel: { show: false }, axisLine: { show: false }, splitLine: { show: false }, axisTick: { show: false } }
      ],
      legend: { show: false },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', label: { show: false } },
        confine: true,
        formatter: function (params) {
          var ps = [].concat(params).filter(function (p) { return p.seriesName !== '__overview'; });
          if (!ps.length) return '';
          var head = fmtWindowLabel(mode, ps[0].value[0]);
          var rows = ps.map(function (p) {
            return { name: p.seriesName, v: p.value[1], color: p.color };
          }).filter(function (r) { return r.v !== null && r.v !== undefined && isFinite(r.v); })
            .sort(function (a, b) { return b.v - a.v; });
          var html = '<div style="font-size:12px">' + head + '</div>';
          rows.forEach(function (r) {
            html += '<div style="font-size:12px;white-space:nowrap">' +
              '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' +
              r.color + ';margin-right:6px"></span>' +
              escapeText(r.name) + '&nbsp;<b>' + fmtNumber(r.v) + '</b></div>';
          });
          return html;
        }
      },
      series: series,
      graphic: [
        {
          id: 'overview-caption',
          type: 'text',
          left: LAYOUT.marginLeft,
          top: '85%',
          z: 10,
          silent: true,
          style: {
            text: mode === 'time' ? 'overview' : 'overview · day-of-life',
            fill: '#aaa',
            fontSize: 10
          }
        }
      ],
      dataZoom: [
        {
          type: 'slider',
          id: 'zoom',
          xAxisIndex: 0,
          filterMode: 'filter',
          minValueSpan: minSpan(mode),
          startValue: win.start,
          endValue: win.end,
          left: LAYOUT.marginLeft,
          right: LAYOUT.marginRight,
          bottom: LAYOUT.slider.bottom,
          height: LAYOUT.slider.height,
          realtime: true,
          brushSelect: false,
          showDataShadow: false,
          labelFormatter: function (v) { return fmtWindowLabel(mode, v); },
          handleLabel: { show: true, color: '#555', fontSize: 10 },
          fillerColor: 'rgba(41,128,185,0.10)',
          borderColor: '#c8d6e5',
          dataBackground: { lineStyle: { width: 1, color: '#b0bec5' }, areaStyle: { color: '#eceff1' } },
          selectedDataBackground: { lineStyle: { width: 1, color: '#2980b9' }, areaStyle: { color: 'rgba(41,128,185,0.14)' } }
        },
        {
          type: 'inside',
          id: 'ins',
          xAxisIndex: 0,
          zoomOnMouseWheel: true,
          moveOnMouseMove: 'shiftKey',
          moveOnMouseWheel: false
        }
      ]
    };
  }

  function presetWindow(mode, domain, days) {
    var end = domain[1];
    if (days == null) return { start: domain[0], end: end };
    if (mode === 'time') {
      var d = new Date(domain[1]);
      d.setUTCDate(d.getUTCDate() - days);
      return { start: Math.max(domain[0], +d), end: end };
    }
    return { start: Math.max(domain[0], end - days), end: end };
  }

  function escapeText(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  var Core = {
    DAY: DAY, COLORS: COLORS, METRICS: METRICS, LAYOUT: LAYOUT,
    parseLines: parseLines, buildMeta: buildMeta, domainOf: domainOf, minSpan: minSpan,
    clampWindow: clampWindow, presetWindow: presetWindow, xOf: xOf, yOf: yOf,
    mainSeries: mainSeries, contextSeries: contextSeries, buildOption: buildOption,
    pointCount: pointCount,
    fmtNumber: fmtNumber, fmtDate: fmtDate, fmtDateShort: fmtDateShort,
    fmtDateISO: fmtDateISO, fmtWindowLabel: fmtWindowLabel
  };

  /* ------------------------------- UI ---------------------------------- */

  var UI = {};

  function boot() {
    var els = {
      fileInput: document.getElementById('fileInput'),
      metricSelect: document.getElementById('metricSelect'),
      logScale: document.getElementById('logScale'),
      alignTimeline: document.getElementById('alignTimeline'),
      selectedRepos: document.getElementById('selectedRepos'),
      repoSearch: document.getElementById('repoSearch'),
      repoSelect: document.getElementById('repoSelect'),
      instructions: document.getElementById('instructions'),
      chartBox: document.getElementById('chart'),
      presets: document.getElementById('presets'),
      fromDate: document.getElementById('fromDate'),
      toDate: document.getElementById('toDate'),
      fromDay: document.getElementById('fromDay'),
      toDay: document.getElementById('toDay'),
      rangeTime: document.getElementById('rangeTime'),
      rangeIndex: document.getElementById('rangeIndex'),
      rangeInfo: document.getElementById('rangeInfo'),
      rangeHint: document.getElementById('rangeHint')
    };

    var chart = null;
    var meta = null;
    var selected = [];
    var mode = 'time';
    var metric = 'downloads_30d';
    var log = false;
    var domain = null;
    var win = null;
    var savedRange = { time: null, index: null };
    var DEFAULT_REPOS = [
      'mozilla-ai/llamafile_0.10.0',
      'mozilla-ai/llamafile_0.10',
      'mozilla-ai/llamafile_0.10_alpha'
    ];

    function state() {
      return { meta: meta, selected: selected, mode: mode, metric: metric, log: log, domain: domain, win: win };
    }

    /* --- rendering ----------------------------------------------------- */

    function render(full) {
      if (!chart || !meta) return;
      var opt = Core.buildOption(state());
      if (full) {
        chart.setOption(opt, { replaceMerge: ['series', 'xAxis', 'yAxis', 'dataZoom', 'grid'] });
      } else {
        // series (+ y axis type) only: the dataZoom window is left untouched,
        // which is what makes the range persist across metric/log changes.
        chart.setOption({
          series: opt.series,
          yAxis: [{ type: log ? 'log' : 'value' }, {}]
        }, { replaceMerge: ['series'] });
      }
      syncRangeUI();
    }

    function setWindow(start, end) {
      if (!meta || !win) return;
      var w = Core.clampWindow(mode, domain, start, end);
      win = w;
      savedRange[mode] = { start: w.start, end: w.end };
      if (chart) chart.dispatchAction({ type: 'datazoom', startValue: w.start, endValue: w.end });
      syncRangeUI();
    }

    function syncFromChart() {
      if (!chart) return;
      var opt = chart.getOption();
      var dzs = opt && opt.dataZoom;
      if (!dzs || !dzs.length) return;
      var start = -Infinity, end = Infinity;
      for (var i = 0; i < dzs.length; i++) {
        var d = dzs[i];
        if (d.startValue == null || d.endValue == null) continue;
        start = Math.max(start, Number(d.startValue));
        end = Math.min(end, Number(d.endValue));
      }
      if (!isFinite(start) || !isFinite(end)) return;
      win = { start: start, end: end };
      savedRange[mode] = { start: start, end: end };
      syncRangeUI();
    }

    /* --- range bar ------------------------------------------------------ */

    function syncRangeUI() {
      if (!meta || !win) return;
      var lo = domain[0], hi = domain[1];
      var isTime = mode === 'time';

      els.rangeTime.style.display = isTime ? '' : 'none';
      els.rangeIndex.style.display = isTime ? 'none' : '';

      if (isTime) {
        els.fromDate.min = Core.fmtDateISO(lo);
        els.fromDate.max = Core.fmtDateISO(win.end);
        els.toDate.min = Core.fmtDateISO(win.start);
        els.toDate.max = Core.fmtDateISO(hi);
        els.fromDate.value = Core.fmtDateISO(win.start);
        els.toDate.value = Core.fmtDateISO(win.end);
      } else {
        var maxDay = Math.ceil(hi);
        els.fromDay.min = 0; els.fromDay.max = maxDay; els.fromDay.step = 1;
        els.toDay.min = 0; els.toDay.max = maxDay; els.toDay.step = 1;
        els.fromDay.value = String(Math.round(win.start));
        els.toDay.value = String(Math.round(win.end));
      }

      var st = state();
      var pts = Core.pointCount(st, win);
      var days = Math.max(1, Math.round((win.end - win.start) / DAY));
      var dense = pts > 320 ? ' · dense, try a narrower range' : '';
      els.rangeInfo.textContent = pts + ' points in window · ' + days + ' days' +
        ' · ' + selected.length + ' repos' + dense;

      var chips = els.presets.querySelectorAll('.preset');
      for (var i = 0; i < chips.length; i++) {
        var chip = chips[i];
        var days2 = chip.dataset.days === '' ? null : Number(chip.dataset.days);
        var target = Core.presetWindow(mode, domain, days2);
        var tol = mode === 'time' ? DAY * 0.5 : 0.5;
        var active = Math.abs(target.start - win.start) <= tol && Math.abs(target.end - win.end) <= tol;
        chip.classList.toggle('active', active);
      }
    }

    function switchMode(next) {
      if (next === mode || !meta) return;
      if (win) savedRange[mode] = { start: win.start, end: win.end };
      mode = next;
      domain = Core.domainOf(mode, meta);
      var remembered = savedRange[mode];
      win = remembered
        ? Core.clampWindow(mode, domain, remembered.start, remembered.end)
        : { start: domain[0], end: domain[1] };
      render(true);
    }

    /* --- repo picker --------------------------------------------------- */

    function populateRepoDropdown(filter) {
      var lower = (filter || '').toLowerCase();
      els.repoSelect.innerHTML = '';
      meta.repos.forEach(function (repo) {
        if (selected.indexOf(repo) !== -1) return;
        if (lower && repo.toLowerCase().indexOf(lower) === -1) return;
        var opt = document.createElement('option');
        opt.value = repo;
        opt.textContent = repo + ' (' + Core.fmtNumber(meta.repoMax[repo]) + ')';
        els.repoSelect.appendChild(opt);
      });
    }

    function updateSelectedReposUI() {
      els.selectedRepos.innerHTML = '';
      selected.forEach(function (repo, i) {
        var tag = document.createElement('span');
        tag.className = 'repo-tag';
        var dot = document.createElement('span');
        dot.className = 'color-dot';
        dot.style.background = COLORS[i % COLORS.length];
        tag.appendChild(dot);
        tag.appendChild(document.createTextNode(repo.split('/').pop()));
        var btn = document.createElement('button');
        btn.innerHTML = '&times;';
        btn.title = 'Remove ' + repo;
        btn.onclick = function () { removeRepo(repo); };
        tag.appendChild(btn);
        els.selectedRepos.appendChild(tag);
      });
      if (selected.length > 0) {
        var clearBtn = document.createElement('span');
        clearBtn.className = 'clear-all';
        clearBtn.textContent = 'Clear all';
        clearBtn.onclick = clearAll;
        els.selectedRepos.appendChild(clearBtn);
      }
    }

    function addRepo(repo) {
      if (!repo || selected.indexOf(repo) !== -1) return;
      selected.push(repo);
      updateSelectedReposUI();
      render(false);
    }

    function removeRepo(repo) {
      selected = selected.filter(function (r) { return r !== repo; });
      updateSelectedReposUI();
      render(false);
    }

    function clearAll() {
      selected = [];
      updateSelectedReposUI();
      render(false);
    }

    /* --- data ---------------------------------------------------------- */

    function loadData(text) {
      var parsed = Core.parseLines(text);
      if (!parsed.records.length) {
        els.instructions.style.display = '';
        els.instructions.textContent = 'No valid JSONL records' + (parsed.bad ? ' (' + parsed.bad + ' unparseable lines)' : '');
        return;
      }
      meta = Core.buildMeta(parsed.records);
      domain = Core.domainOf(mode, meta);
      win = { start: domain[0], end: domain[1] };
      savedRange = { time: null, index: null };

      populateRepoDropdown('');
      els.repoSearch.disabled = false;
      els.repoSelect.disabled = false;

      selected = DEFAULT_REPOS.filter(function (r) { return meta.byRepo[r]; });
      if (!selected.length && meta.repos.length) selected = meta.repos.slice(0, 3);
      updateSelectedReposUI();

      if (!chart) {
        chart = echarts.init(els.chartBox);
        chart.on('datazoom', syncFromChart);
        window.addEventListener('resize', function () { chart.resize(); });
      }
      els.instructions.style.display = 'none';
      render(true);
      els.rangeHint.style.display = '';
      if (parsed.bad) els.rangeHint.textContent = 'hint · ' + parsed.bad + ' unparseable line(s) skipped. ' + els.rangeHint.dataset.text;
    }

    /* --- events -------------------------------------------------------- */

    els.fileInput.addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (ev) { loadData(ev.target.result); };
      reader.readAsText(file);
    });

    els.metricSelect.addEventListener('change', function () {
      metric = els.metricSelect.value;
      render(false);
    });
    els.logScale.addEventListener('change', function () { log = els.logScale.checked; render(false); });
    els.alignTimeline.addEventListener('change', function () {
      switchMode(els.alignTimeline.checked ? 'index' : 'time');
    });

    els.presets.addEventListener('click', function (e) {
      var chip = e.target.closest ? e.target.closest('.preset') : null;
      if (!chip || !meta) return;
      var days = chip.dataset.days === '' ? null : Number(chip.dataset.days);
      var w = Core.presetWindow(mode, domain, days);
      setWindow(w.start, w.end);
    });

    function dateInputToMs(value) { return value ? Date.parse(value + 'T00:00:00Z') : NaN; }

    // "from" inputs move the left edge, "to" inputs the right edge; each keeps
    // the window valid (min 2 days) via clampWindow inside setWindow.
    function onEdge(edge, el, parse) {
      return function () {
        if (!meta || !win) return;
        var v = parse(el.value);
        if (!isFinite(v)) return;
        if (edge === 'start') setWindow(Math.min(v, win.end), win.end);
        else setWindow(win.start, Math.max(v, win.start));
      };
    }

    var parseDate = dateInputToMs;
    var parseDay = function (v) { return v === '' ? NaN : Number(v); };
    els.fromDate.addEventListener('change', onEdge('start', els.fromDate, parseDate));
    els.toDate.addEventListener('change', onEdge('end', els.toDate, parseDate));
    els.fromDay.addEventListener('change', onEdge('start', els.fromDay, parseDay));
    els.toDay.addEventListener('change', onEdge('end', els.toDay, parseDay));

    els.repoSearch.addEventListener('input', function () { populateRepoDropdown(els.repoSearch.value); });
    els.repoSearch.addEventListener('focus', function () { els.repoSelect.classList.add('open'); });
    els.repoSearch.addEventListener('blur', function () {
      setTimeout(function () { els.repoSelect.classList.remove('open'); }, 150);
    });
    els.repoSelect.addEventListener('change', function () {
      var repo = els.repoSelect.value;
      addRepo(repo);
      els.repoSelect.value = '';
      els.repoSearch.value = '';
      populateRepoDropdown('');
    });

    // Auto-load ./hf-downloads.jsonl from the serving directory (works over
    // http(s), silently fails on file://).
    fetch('./hf-downloads.jsonl')
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (text) { if (text) loadData(text); })
      .catch(function () {});

    UI.ready = true;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { Core: Core, LAYOUT: LAYOUT };
  if (typeof document !== 'undefined' && typeof document.getElementById === 'function' &&
      typeof echarts !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  global.HFViewer = { Core: Core };
})(typeof window !== 'undefined' ? window : globalThis);
