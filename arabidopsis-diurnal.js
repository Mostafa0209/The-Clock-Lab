(() => {
  'use strict';

  // Add future conditions here. Each condition can use a separate CSV with the
  // same first-column gene layout and "TYPE | name-00h_REP" sample headers.
  const CONDITIONS = [
    {
      id: 'GEAR-ID001',
      label: 'GEAR-ID001 · Smith 2004 · Col-0 leaves · 12L:12D',
      csv: 'data/arabidopsis/GEAR-ID001-release-16-combined.csv',
      organism: 'Arabidopsis thaliana',
      ecotype: 'Col-0',
      tissue: 'Leaves',
      temperature: '20°C',
      photoperiod: '12 h light / 12 h dark',
      // The CSV labels run from 00h to 24h, but GEAR plots this experiment on
      // stored coordinates 12h to 36h. Thus CSV 00h is dusk (stored 12h),
      // CSV 12h is dawn (stored 24h), and CSV 24h is the next dusk (stored 36h).
      timeOffset: 12,
      plotStart: 12,
      plotEnd: 36,
      lightBands: [
        { start: 12, end: 24, type: 'dark' },
        { start: 24, end: 36, type: 'light' }
      ],
      phaseByGene: null
    }
  ];

  const state = {
    condition: null,
    headers: [],
    linesByGene: new Map(),
    geneIds: [],
    sampleGroups: {},
    selected: [],
    parsedGenes: new Map(),
    loaded: false
  };

  const el = (id) => document.getElementById(id);
  const conditionSelect = el('condition');
  const dataTypeSelect = el('dataType');
  const displayScaleSelect = el('displayScale');
  const geneInput = el('geneInput');
  const errorBox = el('error');
  const canvas = el('chart');
  const ctx = canvas.getContext('2d');

  function parseCSVLine(line) {
    const values = [];
    let value = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (quoted && line[i + 1] === '"') { value += '"'; i++; }
        else quoted = !quoted;
      } else if (char === ',' && !quoted) {
        values.push(value);
        value = '';
      } else value += char;
    }
    values.push(value);
    return values;
  }

  function parseHeader(header, index) {
    const match = header.match(/^([^|]+)\|.*?-(\d+(?:\.\d+)?)h(?:_|$)(.*)$/i);
    if (!match) return null;
    const type = match[1].trim();
    const time = Number(match[2]);
    const suffix = match[3] || '';
    const repMatch = suffix.match(/REP(\d+)/i);
    return { index, header, type, time, replicate: repMatch ? Number(repMatch[1]) : 1 };
  }

  function buildSampleGroups() {
    const groups = {};
    state.headers.forEach((header, index) => {
      const sample = parseHeader(header, index);
      if (!sample) return;
      if (!groups[sample.type]) groups[sample.type] = [];
      groups[sample.type].push(sample);
    });
    Object.values(groups).forEach((samples) => samples.sort((a, b) => a.time - b.time || a.replicate - b.replicate));
    state.sampleGroups = groups;
    const available = Object.keys(groups);
    dataTypeSelect.innerHTML = available.map((type) => `<option value="${type}">${type === 'MBQN' ? 'MBQN normalized (recommended)' : `${type} source values`}</option>`).join('');
    if (available.includes('MBQN')) dataTypeSelect.value = 'MBQN';
  }

  async function loadCondition(conditionId) {
    const condition = CONDITIONS.find((item) => item.id === conditionId);
    if (!condition) return;
    state.loaded = false;
    state.condition = condition;
    state.selected = [];
    state.parsedGenes.clear();
    state.linesByGene.clear();
    el('loading').style.display = 'grid';
    el('loadingText').textContent = `Reading ${condition.id}…`;
    try {
      const response = await fetch(condition.csv);
      if (!response.ok) throw new Error(`Dataset request failed (${response.status}).`);
      const text = await response.text();
      const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
      state.headers = parseCSVLine(lines[0]);
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i]) continue;
        const comma = lines[i].indexOf(',');
        if (comma < 1) continue;
        const gene = lines[i].slice(0, comma).replace(/^"|"$/g, '').trim().toUpperCase();
        if (gene) state.linesByGene.set(gene, lines[i]);
      }
      state.geneIds = [...state.linesByGene.keys()];
      buildSampleGroups();
      state.loaded = true;
      renderConditionMeta();
      renderAll();
      el('datasetStatus').textContent = `${state.geneIds.length.toLocaleString()} gene rows loaded locally in your browser. No query data are sent to a server.`;
    } catch (error) {
      showError(`The condition could not be loaded. ${error.message}`);
      el('datasetStatus').textContent = 'Dataset loading failed.';
    } finally {
      el('loading').style.display = 'none';
    }
  }

  function renderConditionMeta() {
    const c = state.condition;
    el('conditionMeta').innerHTML = [
      ['Condition', c.id], ['Material', `${c.ecotype} · ${c.tissue}`], ['Environment', `${c.photoperiod} · ${c.temperature}`], ['Time axis', `${c.plotStart}–${c.plotEnd} h · source coordinate`]
    ].map(([label, value]) => `<div class="meta"><span>${label}</span><strong>${value}</strong></div>`).join('');
    el('lightBadge').textContent = c.photoperiod;
  }

  function getGeneData(gene) {
    const type = dataTypeSelect.value;
    const cacheKey = `${gene}|${type}`;
    if (state.parsedGenes.has(cacheKey)) return state.parsedGenes.get(cacheKey);
    const line = state.linesByGene.get(gene);
    if (!line) return null;
    const values = parseCSVLine(line);
    const samples = state.sampleGroups[type] || [];
    const byTime = new Map();
    samples.forEach((sample) => {
      const raw = values[sample.index];
      const value = raw === '' || raw == null ? null : Number(raw);
      if (!byTime.has(sample.time)) byTime.set(sample.time, []);
      byTime.get(sample.time).push({ replicate: sample.replicate, value: Number.isFinite(value) ? value : null, sourceColumn: sample.header });
    });
    const times = [...byTime.keys()].sort((a, b) => a - b);
    const points = times.map((time) => {
      const replicates = byTime.get(time);
      const numeric = replicates.map((item) => item.value).filter(Number.isFinite);
      return { time, replicates, mean: numeric.length ? numeric.reduce((sum, item) => sum + item, 0) / numeric.length : null };
    });
    const valid = points.filter((point) => Number.isFinite(point.mean));
    const peak = valid.length ? valid.reduce((best, point) => point.mean > best.mean ? point : best) : null;
    const result = { gene, type, points, peakTime: peak?.time ?? null, maxMean: peak?.mean ?? null, available: samples.filter((sample) => values[sample.index] !== '').length, total: samples.length };
    state.parsedGenes.set(cacheKey, result);
    return result;
  }

  function splitGeneInput(text) {
    return [...new Set(text.toUpperCase().split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))];
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.add('show');
  }

  function clearError() {
    errorBox.textContent = '';
    errorBox.classList.remove('show');
  }

  function addGenes() {
    clearError();
    if (!state.loaded) return showError('The dataset is still loading.');
    const requested = splitGeneInput(geneInput.value);
    if (!requested.length) return showError('Enter at least one AGI gene identifier.');
    const selectedSet = new Set(state.selected);
    const missing = requested.filter((gene) => !state.linesByGene.has(gene));
    const found = requested.filter((gene) => state.linesByGene.has(gene) && !selectedSet.has(gene));
    state.selected.push(...found);
    if (missing.length) showError(`Not found in this condition: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ` and ${missing.length - 12} more` : ''}.`);
    geneInput.value = '';
    renderAll();
  }

  function removeGene(gene) {
    state.selected = state.selected.filter((item) => item !== gene);
    renderAll();
  }

  function addAllGenes() {
    clearError();
    if (!state.loaded) return showError('The dataset is still loading.');
    state.selected = [...state.geneIds];
    renderAll();
  }

  function colorFor(index, alpha = 1) {
    const hue = (index * 137.508 + 155) % 360;
    return `hsla(${hue},68%,42%,${alpha})`;
  }

  function transformedSeries(data, mode) {
    if (mode !== 'rescaled') return data.points.map((point) => ({ ...point, plotMean: point.mean, plotReplicates: point.replicates.map((rep) => rep.value) }));
    const means = data.points.map((point) => point.mean).filter(Number.isFinite);
    if (!means.length) return data.points.map((point) => ({ ...point, plotMean: null, plotReplicates: point.replicates.map(() => null) }));
    const min = Math.min(...means), max = Math.max(...means), range = max - min;
    return data.points.map((point) => ({
      ...point,
      plotMean: Number.isFinite(point.mean) ? (range > 0 ? (point.mean - min) / range : 0.5) : null,
      plotReplicates: point.replicates.map((rep) => Number.isFinite(rep.value) ? (range > 0 ? (rep.value - min) / range : 0.5) : null)
    }));
  }

  function drawChart() {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const width = rect.width, height = rect.height;
    ctx.clearRect(0, 0, width, height);
    if (!state.selected.length) return;

    const margin = { left: 67, right: 24, top: 24, bottom: 58 };
    const plotW = width - margin.left - margin.right, plotH = height - margin.top - margin.bottom;
    const plotStart = state.condition.plotStart;
    const plotEnd = state.condition.plotEnd;
    const timeOffset = state.condition.timeOffset || 0;
    const series = state.selected.map(getGeneData).filter(Boolean).map((data) => ({ data, points: transformedSeries(data, displayScaleSelect.value) }));
    const allValues = series.flatMap((item) => item.points.flatMap((point) => [point.plotMean, ...point.plotReplicates])).filter(Number.isFinite);
    let minY = displayScaleSelect.value === 'rescaled' || !allValues.length ? 0 : Math.min(...allValues);
    let maxY = displayScaleSelect.value === 'rescaled' || !allValues.length ? 1 : Math.max(...allValues);
    if (minY >= 0) minY = 0;
    if (maxY === minY) maxY = minY + 1;
    const yPad = displayScaleSelect.value === 'rescaled' ? 0 : (maxY - minY) * 0.08;
    maxY += yPad;
    if (minY < 0) minY -= yPad;
    const x = (time) => margin.left + ((time - plotStart) / (plotEnd - plotStart)) * plotW;
    const y = (value) => margin.top + ((maxY - value) / (maxY - minY)) * plotH;

    state.condition.lightBands.forEach((band) => {
      ctx.fillStyle = band.type === 'light' ? '#ffffff' : '#e3e5e4';
      ctx.fillRect(x(band.start), margin.top, x(band.end) - x(band.start), plotH);
    });
    ctx.strokeStyle = '#d8dfd7'; ctx.lineWidth = 1; ctx.font = '11px Arial'; ctx.fillStyle = '#61736c';
    for (let i = 0; i <= 5; i++) {
      const value = minY + ((maxY - minY) * i) / 5;
      const py = y(value);
      ctx.beginPath(); ctx.moveTo(margin.left, py); ctx.lineTo(width - margin.right, py); ctx.stroke();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(value >= 100 ? value.toFixed(0) : value.toFixed(2), margin.left - 9, py);
    }
    const times = [...new Set(series.flatMap((item) => item.points.map((point) => point.time + timeOffset)))].sort((a, b) => a - b);
    times.forEach((time) => {
      const px = x(time); ctx.strokeStyle = time === 12 ? '#87938d' : '#e1e6e1';
      ctx.beginPath(); ctx.moveTo(px, margin.top); ctx.lineTo(px, height - margin.bottom); ctx.stroke();
      ctx.fillStyle = '#61736c'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(`${time}`, px, height - margin.bottom + 9);
    });
    ctx.fillStyle = '#16352c'; ctx.font = 'bold 11px Arial'; ctx.textAlign = 'center';
    state.condition.lightBands.forEach((band) => ctx.fillText(band.type.toUpperCase(), x((band.start + band.end) / 2), margin.top + 16));
    ctx.fillStyle = '#61736c'; ctx.font = '12px Arial'; ctx.fillText('Stored plot coordinate (hours)', margin.left + plotW / 2, height - 12);
    ctx.save(); ctx.translate(15, margin.top + plotH / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(displayScaleSelect.value === 'rescaled' ? 'Per-gene rescaled expression (0–1)' : `${dataTypeSelect.value} expression`, 0, 0); ctx.restore();

    const showReplicates = series.length <= 60;
    series.forEach((item, index) => {
      const color = colorFor(index);
      if (showReplicates) item.points.forEach((point) => point.plotReplicates.forEach((value) => {
        if (!Number.isFinite(value)) return;
        ctx.beginPath(); ctx.arc(x(point.time + timeOffset), y(value), 2.7, 0, Math.PI * 2); ctx.fillStyle = colorFor(index, .35); ctx.fill();
      }));
      ctx.beginPath(); let started = false;
      item.points.forEach((point) => {
        if (!Number.isFinite(point.plotMean)) { started = false; return; }
        if (!started) { ctx.moveTo(x(point.time + timeOffset), y(point.plotMean)); started = true; } else ctx.lineTo(x(point.time + timeOffset), y(point.plotMean));
      });
      ctx.strokeStyle = color; ctx.lineWidth = series.length > 1000 ? .5 : series.length > 100 ? 1 : 2; ctx.globalAlpha = series.length > 1000 ? .18 : series.length > 100 ? .55 : .9; ctx.stroke(); ctx.globalAlpha = 1;
    });
  }

  function renderSelected() {
    el('selectionCount').textContent = `${state.selected.length} selected`;
    el('selectedSummary').textContent = state.selected.length ? `${state.selected.length} valid gene${state.selected.length === 1 ? '' : 's'} selected.` : 'No genes selected.';
    const visible = state.selected.slice(0, 100);
    el('selectedGenes').innerHTML = visible.map((gene, index) => `<div class="chip"><span><i style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${colorFor(index)};margin-right:6px"></i>${gene}</span><button type="button" data-remove="${gene}" aria-label="Remove ${gene}">×</button></div>`).join('') + (state.selected.length > 100 ? `<div class="selected-summary">+ ${state.selected.length - 100} additional genes</div>` : '');
    el('selectedGenes').querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => removeGene(button.dataset.remove)));
    el('download').disabled = !state.selected.length;
  }

  function renderLegend() {
    if (!state.selected.length) { el('legend').innerHTML = ''; return; }
    const maxLegend = 120;
    el('legend').innerHTML = state.selected.slice(0, maxLegend).map((gene, index) => `<span class="legend-item"><i class="legend-swatch" style="background:${colorFor(index)}"></i>${gene}</span>`).join('') + (state.selected.length > maxLegend ? `<span class="legend-item">+${state.selected.length - maxLegend} more genes</span>` : '');
  }

  function renderResults() {
    const body = el('resultsBody');
    if (!state.selected.length) { body.innerHTML = '<tr><td colspan="5">No genes selected.</td></tr>'; return; }
    const previewLimit = 1000;
    body.innerHTML = state.selected.slice(0, previewLimit).map((gene) => {
      const data = getGeneData(gene);
      const phase = state.condition.phaseByGene?.[gene];
      const storedPeak = data.peakTime == null ? null : data.peakTime + (state.condition.timeOffset || 0);
      return `<tr><td><strong>${gene}</strong></td><td>${storedPeak == null ? '—' : `${storedPeak} h`}</td><td>${phase == null ? 'Not supplied' : `ZT${phase}`}</td><td class="number">${data.maxMean == null ? '—' : data.maxMean.toFixed(3)}</td><td class="number">${data.available}/${data.total}</td></tr>`;
    }).join('') + (state.selected.length > previewLimit ? `<tr><td colspan="5"><strong>${(state.selected.length - previewLimit).toLocaleString()} additional genes</strong> are included in the graph and download but omitted from this table preview.</td></tr>` : '');
  }

  function renderAll() {
    renderSelected(); renderLegend(); renderResults();
    el('empty').style.display = state.selected.length ? 'none' : 'grid';
    el('chartSubtitle').textContent = state.selected.length ? `${state.selected.length} gene${state.selected.length === 1 ? '' : 's'} · means connected by lines${state.selected.length <= 60 ? ' · replicate points shown' : ''}` : 'Select one or more genes to draw their expression profiles.';
    requestAnimationFrame(drawChart);
  }

  function downloadSelected() {
    if (!state.selected.length) return;
    const rows = [['Condition', 'Gene', 'CSV_time_h', 'Stored_plot_coordinate_h', 'Replicate', 'Value', 'Data_type', 'Source_column']];
    state.selected.forEach((gene) => {
      const data = getGeneData(gene);
      data.points.forEach((point) => point.replicates.forEach((replicate) => rows.push([state.condition.id, gene, point.time, point.time + (state.condition.timeOffset || 0), replicate.replicate, replicate.value ?? '', data.type, replicate.sourceColumn])));
    });
    const escape = (value) => { const text = String(value ?? ''); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
    const blob = new Blob([rows.map((row) => row.map(escape).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${state.condition.id}_${dataTypeSelect.value}_${state.selected.length}_genes.csv`; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
  }

  CONDITIONS.forEach((condition) => conditionSelect.add(new Option(condition.label, condition.id)));
  conditionSelect.addEventListener('change', () => loadCondition(conditionSelect.value));
  dataTypeSelect.addEventListener('change', () => { state.parsedGenes.clear(); renderAll(); });
  displayScaleSelect.addEventListener('change', renderAll);
  el('addGenes').addEventListener('click', addGenes);
  el('addAllGenes').addEventListener('click', addAllGenes);
  el('clearGenes').addEventListener('click', () => { state.selected = []; clearError(); renderAll(); });
  el('download').addEventListener('click', downloadSelected);
  geneInput.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') addGenes(); });
  document.querySelectorAll('[data-example]').forEach((button) => button.addEventListener('click', () => { geneInput.value = geneInput.value ? `${geneInput.value}\n${button.dataset.example}` : button.dataset.example; }));
  if ('ResizeObserver' in window) new ResizeObserver(() => { if (state.selected.length) requestAnimationFrame(drawChart); }).observe(canvas.parentElement);
  else window.addEventListener('resize', () => requestAnimationFrame(drawChart));
  loadCondition(CONDITIONS[0].id);
})();
