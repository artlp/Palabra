import { matrixToWords, parseDelimited, tableToWords } from './core.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export function parseGoogleSheetReference(input) {
  const value = String(input || '').trim();
  if (!value) return null;

  if (/docs\.google\.com\/spreadsheets\/d\/e\//i.test(value) && /output=csv/i.test(value)) {
    return { kind: 'published-csv', originalUrl: value };
  }

  const standardMatch = value.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/i);
  if (standardMatch) {
    const gidMatch = value.match(/[?#&]gid=(\d+)/i);
    return {
      kind: 'google-sheet',
      spreadsheetId: standardMatch[1],
      gid: gidMatch?.[1] || '0',
      originalUrl: value,
    };
  }

  return { kind: 'csv', originalUrl: value };
}

function cellValue(cell) {
  if (!cell) return '';
  if (cell.f !== undefined && cell.f !== null) return String(cell.f);
  if (cell.v === undefined || cell.v === null) return '';
  if (typeof cell.v === 'object' && cell.v instanceof Date) return cell.v.toISOString();
  return String(cell.v);
}

function tableFromVisualizationResponse(response) {
  if (!response || response.status === 'error') {
    const detail = response?.errors?.map((error) => error.detailed_message || error.message).filter(Boolean).join(' ') || '';
    throw new Error(detail || 'Google Sheets вернул ошибку доступа. Откройте таблицу для просмотра по ссылке.');
  }
  const table = response.table;
  if (!table?.cols || !table?.rows) throw new Error('В таблице не найдено строк или столбцов.');
  const headers = table.cols.map((column, index) => column.label || column.id || `column_${index + 1}`);
  const rows = table.rows.map((row) => headers.map((_, index) => cellValue(row.c?.[index])));
  return { headers, rows };
}

export function loadGoogleSheetViaJsonp({ spreadsheetId, gid = '0', sheetName = '', timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const callbackName = `__palabraSheet_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    let timer;

    const cleanup = () => {
      clearTimeout(timer);
      script.remove();
      try {
        delete window[callbackName];
      } catch {
        window[callbackName] = undefined;
      }
    };

    window[callbackName] = (response) => {
      try {
        resolve(tableFromVisualizationResponse(response));
      } catch (error) {
        reject(error);
      } finally {
        cleanup();
      }
    };

    const params = new URLSearchParams({
      headers: '1',
      tqx: `responseHandler:${callbackName}`,
    });
    if (sheetName) params.set('sheet', sheetName);
    else params.set('gid', String(gid || '0'));
    params.set('_', String(Date.now()));

    script.src = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/gviz/tq?${params.toString()}`;
    script.async = true;
    script.onerror = () => {
      cleanup();
      reject(new Error('Не удалось загрузить Google Sheets. Проверьте ссылку и доступ «всем по ссылке».'));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('Google Sheets не ответил вовремя. Повторите синхронизацию.'));
    }, timeoutMs);
    document.head.append(script);
  });
}

async function fetchText(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const separator = url.includes('?') ? '&' : '?';
    const response = await fetch(`${url}${separator}_=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function loadWordsFromSource(sourceUrl, { sheetName = '', fallbackUrl = './data/demo-words.csv' } = {}) {
  const effectiveUrl = String(sourceUrl || '').trim() || fallbackUrl;
  const reference = parseGoogleSheetReference(effectiveUrl);
  let words;
  let sourceType;

  if (reference?.kind === 'google-sheet') {
    const table = await loadGoogleSheetViaJsonp({ ...reference, sheetName });
    words = tableToWords(table.headers, table.rows);
    sourceType = 'Google Sheets';
  } else {
    const text = await fetchText(effectiveUrl);
    words = matrixToWords(parseDelimited(text));
    sourceType = reference?.kind === 'published-csv' ? 'Google Sheets CSV' : 'CSV';
  }

  if (!words.length) {
    throw new Error('Не удалось распознать словарь. Нужны столбцы с испанским словом и русским переводом.');
  }

  return {
    words,
    sourceType,
    sourceUrl: effectiveUrl,
    syncedAt: new Date().toISOString(),
  };
}

export async function loadWordsFromFile(file) {
  if (!file) throw new Error('Файл не выбран.');
  const text = await file.text();
  const words = matrixToWords(parseDelimited(text));
  if (!words.length) throw new Error('В CSV не найдено слов.');
  return {
    words,
    sourceType: 'Локальный CSV',
    sourceUrl: '',
    syncedAt: new Date().toISOString(),
  };
}
