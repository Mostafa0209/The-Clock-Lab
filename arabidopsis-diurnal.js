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
    rhythmCache: new Map(),
    modelLibraries: new Map(),
    loaded: false
  };

  const el = (id) => document.getElementById(id);
  const conditionSelect = el('condition');
  const dataTypeSelect = el('dataType');
  const displayScaleSelect = el('displayScale');
  const correlationCutoffInput = el('correlationCutoff');
  const foldCutoffInput = el('foldCutoff');
  const backgroundCutoffInput = el('backgroundCutoff');
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
    state.rhythmCache.clear();
    state.modelLibraries.clear();
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

  function circularDistance(a, b) {
    const distance = Math.abs(a - b) % 24;
    return Math.min(distance, 24 - distance);
  }

  function pearsonCorrelation(values, model) {
    const pairs = values.map((value, index) => [value, model[index]]).filter(([value, expected]) => Number.isFinite(value) && Number.isFinite(expected));
    if (pairs.length < 3) return null;
    const meanX = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
    const meanY = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
    let numerator = 0, sumX = 0, sumY = 0;
    pairs.forEach(([value, expected]) => {
      const dx = value - meanX, dy = expected - meanY;
      numerator += dx * dy; sumX += dx * dx; sumY += dy * dy;
    });
    const denominator = Math.sqrt(sumX * sumY);
    return denominator > 0 ? numerator / denominator : null;
  }

  function modelValue(model, zt, phase) {
    const distance = circularDistance(zt, phase);
    if (model === 'Cosine') return (Math.cos((2 * Math.PI * distance) / 24) + 1) / 2;
    if (model === 'Spike') return Math.exp(-0.5 * Math.pow(distance / 1.5, 2));
    if (model === 'Rigid') return Math.max(0, 1 - distance / 6);
    if (model === 'Narrow box') return distance <= 2 ? 1 : 0;
    return distance <= 4 ? 1 : 0;
  }

  function getModelLibrary(ztTimes) {
    const key = ztTimes.join(',');
    if (state.modelLibraries.has(key)) return state.modelLibraries.get(key);
    const library = [];
    ['Cosine', 'Spike', 'Rigid', 'Narrow box', 'Wide box'].forEach((model) => {
      for (let phase = 0; phase < 24; phase++) library.push({ model, phase, values: ztTimes.map((zt) => modelValue(model, zt, phase)) });
    });
    state.modelLibraries.set(key, library);
    return library;
  }

  function getRhythmAnalysis(gene) {
    const type = dataTypeSelect.value;
    const cacheKey = `${gene}|${type}`;
    if (state.rhythmCache.has(cacheKey)) return state.rhythmCache.get(cacheKey);
    const data = getGeneData(gene);
    const validPoints = data.points.filter((point) => Number.isFinite(point.mean));
    const values = validPoints.map((point) => point.mean);
    const ztTimes = validPoints.map((point) => (point.time + 12) % 24);
    let best = { phase: null, correlation: null, model: '—' };
    getModelLibrary(ztTimes).forEach((candidate) => {
      const correlation = pearsonCorrelation(values, candidate.values);
      if (correlation != null && (best.correlation == null || correlation > best.correlation)) best = { phase: candidate.phase, correlation, model: candidate.model };
    });
    const minimum = values.length ? Math.min(...values) : null;
    const maximum = values.length ? Math.max(...values) : null;
    const foldChange = minimum == null || maximum == null ? null : minimum > 0 ? maximum / minimum : maximum > 0 ? Infinity : 1;
    const result = { ...best, minimum, maximum, foldChange };
    state.rhythmCache.set(cacheKey, result);
    return result;
  }

  function screenCutoffs() {
    const correlation = Number(correlationCutoffInput.value);
    const fold = Number(foldCutoffInput.value);
    const background = Number(backgroundCutoffInput.value);
    return {
      correlation: Number.isFinite(correlation) ? Math.min(1, Math.max(0, correlation)) : 0.8,
      fold: Number.isFinite(fold) ? Math.max(1, fold) : 2,
      background: Number.isFinite(background) ? Math.max(0, background) : 0.01
    };
  }

  function isOscillating(analysis, cutoffs = screenCutoffs()) {
    return analysis.correlation != null && analysis.correlation >= cutoffs.correlation && analysis.foldChange != null && analysis.foldChange >= cutoffs.fold && analysis.maximum != null && analysis.maximum >= cutoffs.background;
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
    const head = el('resultsHead');
    const timeOffset = state.condition.timeOffset || 0;
    const samples = state.sampleGroups[dataTypeSelect.value] || [];
    const sourceTimes = [...new Set(samples.map((sample) => sample.time))].sort((a, b) => a - b);
    const displayTimes = sourceTimes.map((time) => time + timeOffset);
    head.innerHTML = `<tr><th>GeneID</th><th>Condition</th><th>Oscillating?</th><th>Phase (ZT)</th><th>Correlation</th><th>Best model</th><th>Fold</th>${displayTimes.map((time) => `<th>${time}</th>`).join('')}</tr>`;
    if (!state.selected.length) {
      body.innerHTML = `<tr><td colspan="${7 + displayTimes.length}">No genes selected.</td></tr>`;
      el('rhythmSummary').textContent = 'Select genes to calculate their best-fitting 24-hour phase and Pearson correlation.';
      return;
    }
    const previewLimit = 1000;
    const cutoffs = screenCutoffs();
    let oscillatingCount = 0;
    body.innerHTML = state.selected.slice(0, previewLimit).map((gene) => {
      const data = getGeneData(gene);
      const analysis = getRhythmAnalysis(gene);
      const oscillating = isOscillating(analysis, cutoffs);
      if (oscillating) oscillatingCount++;
      const meanByTime = new Map(data.points.map((point) => [point.time, point.mean]));
      return `<tr><td><strong>${gene}</strong></td><td>${state.condition.id}</td><td><span class="call ${oscillating ? 'yes' : 'no'}">${oscillating ? 'Yes' : 'No'}</span></td><td class="number">${analysis.phase == null ? '—' : analysis.phase}</td><td class="number">${analysis.correlation == null ? '—' : analysis.correlation.toFixed(6)}</td><td>${analysis.model}</td><td class="number">${analysis.foldChange == null ? '—' : Number.isFinite(analysis.foldChange) ? analysis.foldChange.toFixed(3) : '∞'}</td>${sourceTimes.map((time) => `<td class="number">${Number.isFinite(meanByTime.get(time)) ? meanByTime.get(time).toFixed(4) : ''}</td>`).join('')}</tr>`;
    }).join('') + (state.selected.length > previewLimit ? `<tr><td colspan="${7 + displayTimes.length}"><strong>${(state.selected.length - previewLimit).toLocaleString()} additional genes</strong> are included in the graph and wide CSV download but omitted from this table preview.</td></tr>` : '');
    const previewed = Math.min(state.selected.length, previewLimit);
    el('rhythmSummary').textContent = `${oscillatingCount.toLocaleString()} of ${previewed.toLocaleString()} displayed genes pass correlation ≥ ${cutoffs.correlation.toFixed(2)}, fold ≥ ${cutoffs.fold.toFixed(1)}, and maximum expression ≥ ${cutoffs.background}. ${state.selected.length > previewLimit ? 'The summary covers the 1,000-row preview; the download evaluates every selected gene.' : ''}`;
  }

  function renderAll() {
    renderSelected(); renderLegend(); renderResults();
    el('empty').style.display = state.selected.length ? 'none' : 'grid';
    el('chartSubtitle').textContent = state.selected.length ? `${state.selected.length} gene${state.selected.length === 1 ? '' : 's'} · means connected by lines${state.selected.length <= 60 ? ' · replicate points shown' : ''}` : 'Select one or more genes to draw their expression profiles.';
    requestAnimationFrame(drawChart);
  }

  function downloadSelected() {
    if (!state.selected.length) return;
    const timeOffset = state.condition.timeOffset || 0;
    const samples = state.sampleGroups[dataTypeSelect.value] || [];
    const sourceTimes = [...new Set(samples.map((sample) => sample.time))].sort((a, b) => a - b);
    const displayTimes = sourceTimes.map((time) => time + timeOffset);
    const cutoffs = screenCutoffs();
    const rows = [['GeneID', 'Condition', 'Oscillating_screen', 'Phase_ZT', 'Correlation', 'Best_model', 'Fold_change', ...displayTimes.map((time) => `${time}h_mean`)]];
    state.selected.forEach((gene) => {
      const data = getGeneData(gene);
      const analysis = getRhythmAnalysis(gene);
      const meanByTime = new Map(data.points.map((point) => [point.time, point.mean]));
      rows.push([gene, state.condition.id, isOscillating(analysis, cutoffs) ? 'Yes' : 'No', analysis.phase ?? '', analysis.correlation == null ? '' : analysis.correlation.toFixed(6), analysis.model, analysis.foldChange == null ? '' : Number.isFinite(analysis.foldChange) ? analysis.foldChange.toFixed(6) : 'Infinity', ...sourceTimes.map((time) => Number.isFinite(meanByTime.get(time)) ? meanByTime.get(time).toFixed(6) : '')]);
    });
    const escape = (value) => { const text = String(value ?? ''); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
    const blob = new Blob([rows.map((row) => row.map(escape).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${state.condition.id}_${dataTypeSelect.value}_${state.selected.length}_genes_phase_correlation.csv`; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
  }

  CONDITIONS.forEach((condition) => conditionSelect.add(new Option(condition.label, condition.id)));
  conditionSelect.addEventListener('change', () => loadCondition(conditionSelect.value));
  dataTypeSelect.addEventListener('change', () => { state.parsedGenes.clear(); state.rhythmCache.clear(); renderAll(); });
  displayScaleSelect.addEventListener('change', renderAll);
  [correlationCutoffInput, foldCutoffInput, backgroundCutoffInput].forEach((input) => input.addEventListener('change', renderResults));
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
