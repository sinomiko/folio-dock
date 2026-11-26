import { unzipSync } from 'fflate';
import { imageTypes } from '../formats.js';

const MiB = 1024 * 1024;
const parts = {
  xlsx: /^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/,
  docx: /^word\/(?:document\.xml|_rels\/document\.xml\.rels|media\/[^/]+)$/,
  pptx: /^ppt\/(?:presentation\.xml|_rels\/presentation\.xml\.rels|slides\/(?:_rels\/)?[^/]+\.xml(?:\.rels)?|media\/[^/]+)$/,
};
const packageOrigin = 'https://office.invalid/';
const maxSheets = 50;
const maxRows = 150;
const maxCols = 30;
const maxSlides = 100;
const maxBlocks = 1600;

function descendants(node, name) {
  return node ? Array.from(node.getElementsByTagNameNS('*', name)) : [];
}

function child(node, name) {
  return node ? Array.from(node.children).find(element => element.localName === name) : undefined;
}

function attr(node, name) {
  return node ? Array.from(node.attributes).find(attribute => attribute.localName === name)?.value : undefined;
}

function relId(node, name = 'id') {
  return Array.from(node.attributes).find(attribute =>
    attribute.localName === name && attribute.namespaceURI?.endsWith('/relationships'),
  )?.value;
}

function xml(files, part) {
  if (!Object.hasOwn(files, part)) return null;
  const bytes = files[part];
  const label = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  const text = new TextDecoder(label).decode(bytes);
  if (/<!DOCTYPE/i.test(text)) throw new Error('此文件的 XML 结构无法预览。');
  const result = new DOMParser().parseFromString(text, 'application/xml');
  if (descendants(result, 'parsererror').length) throw new Error('此文件的 XML 结构无法预览。');
  return result;
}

function relationships(files, source) {
  const cut = source.lastIndexOf('/');
  const rels = xml(files, source.slice(0, cut + 1) + '_rels/' + source.slice(cut + 1) + '.rels');
  const links = new Map();
  for (const item of descendants(rels, 'Relationship')) {
    if (item.getAttribute('TargetMode') === 'External') continue;
    const target = item.getAttribute('Target');
    if (!target) continue;
    const url = new URL(target, packageOrigin + source);
    if (url.origin === new URL(packageOrigin).origin) {
      links.set(item.getAttribute('Id'), decodeURIComponent(url.pathname.slice(1)));
    }
  }
  return links;
}

function node(tag, text = '') {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  return element;
}

function fileImage(files, target, images) {
  if (!target || !Object.hasOwn(files, target)) return null;
  const extension = target.split('.').pop().toLowerCase();
  if (!Object.hasOwn(imageTypes, extension) && extension !== 'jpeg') return null;
  if (!images.has(target)) {
    const type = extension === 'jpeg' ? imageTypes.jpg : imageTypes[extension];
    images.set(target, URL.createObjectURL(new Blob([files[target]], { type })));
  }
  const image = node('img');
  image.src = images.get(target);
  image.alt = '文档内图片';
  image.loading = 'lazy';
  return image;
}

function wordParagraph(xmlParagraph, files, links, images) {
  const style = attr(child(child(xmlParagraph, 'pPr'), 'pStyle'), 'val') || '';
  const heading = style.match(/^heading([1-6])$/i);
  const block = node(heading ? 'h' + heading[1] : 'p');
  for (const part of descendants(xmlParagraph, '*')) {
    if (part.localName === 't') block.append(part.textContent);
    if (part.localName === 'tab') block.append('\t');
    if (part.localName === 'br') block.append(node('br'));
    if (part.localName === 'blip') {
      const image = fileImage(files, links.get(relId(part, 'embed')), images);
      if (image) block.append(image);
    }
  }
  return block;
}

function renderWord(files, main, images) {
  const source = 'word/document.xml';
  const body = descendants(xml(files, source), 'body')[0];
  if (!body) throw new Error('找不到 Word 正文。');
  const links = relationships(files, source);
  const article = node('article');
  article.className = 'word-page';
  for (const block of Array.from(body.children).slice(0, maxBlocks)) {
    if (block.localName === 'p') article.append(wordParagraph(block, files, links, images));
    if (block.localName !== 'tbl') continue;
    const table = node('table');
    for (const row of Array.from(block.children).filter(item => item.localName === 'tr').slice(0, maxRows)) {
      const cells = Array.from(row.children).filter(item => item.localName === 'tc').slice(0, maxCols);
      const tr = table.insertRow();
      for (const cell of cells) {
        const td = tr.insertCell();
        td.append(...Array.from(cell.children).filter(item => item.localName === 'p')
          .map(item => wordParagraph(item, files, links, images)));
      }
    }
    article.append(table);
  }
  main.append(article);
  if (body.children.length > maxBlocks) main.append(node('p', '已达到正文预览上限。'));
}

function indexForColumn(address) {
  const name = address?.match(/^[A-Z]+/)?.[0];
  if (!name) return null;
  let index = 0;
  for (const character of name) index = index * 26 + character.charCodeAt(0) - 64;
  return index - 1;
}

function columnName(index) {
  return index < 26 ? String.fromCharCode(65 + index) : 'A' + String.fromCharCode(65 + index - 26);
}

function sheetCell(cell, strings) {
  const raw = child(cell, 'v')?.textContent;
  if (cell.getAttribute('t') === 's') return strings[Number(raw)] ?? '';
  if (cell.getAttribute('t') === 'inlineStr') return descendants(child(cell, 'is'), 't').map(item => item.textContent).join('');
  if (cell.getAttribute('t') === 'b' && raw !== undefined) return raw === '1' ? 'TRUE' : 'FALSE';
  if (raw !== undefined) return raw;
  const formula = child(cell, 'f')?.textContent;
  return formula ? '=' + formula : '';
}

function renderSheet(files, sheet, strings, output) {
  const data = descendants(xml(files, sheet), 'sheetData')[0];
  if (!data) throw new Error('找不到工作表内容。');
  const rows = Array.from(data.children);
  const selectedRows = rows.slice(0, maxRows);
  let columnCount = 0;
  let truncated = rows.length > maxRows;
  const values = selectedRows.map((row, index) => {
    let position = 0;
    const cells = [];
    for (const cell of row.children) {
      if (cell.localName !== 'c') continue;
      const column = indexForColumn(cell.getAttribute('r')) ?? position;
      position = column + 1;
      if (column >= maxCols) {
        truncated = true;
        continue;
      }
      columnCount = Math.max(columnCount, position);
      cells[column] = sheetCell(cell, strings);
    }
    return { label: row.getAttribute('r') || String(index + 1), cells };
  });
  output.replaceChildren();
  if (!columnCount) {
    output.append(node('p', '此工作表没有可显示的单元格。'));
    return;
  }
  const table = node('table');
  const tableHead = table.createTHead().insertRow();
  tableHead.append(node('th', '行号'));
  for (let index = 0; index < columnCount; index += 1) tableHead.append(node('th', columnName(index)));
  const tableBody = table.createTBody();
  for (const value of values) {
    const row = tableBody.insertRow();
    const label = node('th', value.label);
    label.scope = 'row';
    row.append(label);
    for (let index = 0; index < columnCount; index += 1) row.insertCell().textContent = value.cells[index] ?? '';
  }
  const wrap = node('div');
  wrap.className = 'sheet-table';
  wrap.append(table);
  output.append(wrap);
  if (truncated) output.append(node('p', '每张工作表最多预览 150 行、30 列。'));
}

function renderExcel(files, main) {
  const source = 'xl/workbook.xml';
  const names = descendants(xml(files, source), 'sheet');
  const links = relationships(files, source);
  const sheets = names.filter(sheet => Object.hasOwn(files, links.get(relId(sheet))));
  if (!sheets.length) throw new Error('找不到可预览的工作表。');
  const strings = descendants(xml(files, 'xl/sharedStrings.xml'), 'si')
    .map(item => descendants(item, 't').filter(text => text.parentElement?.localName !== 'rPh')
      .map(text => text.textContent).join(''));
  const label = node('label', '工作表 ');
  const select = node('select');
  sheets.slice(0, maxSheets).forEach((sheet, index) => {
    const option = node('option', sheet.getAttribute('name') || '工作表 ' + (index + 1));
    option.value = links.get(relId(sheet));
    select.append(option);
  });
  label.append(select);
  const output = node('section');
  main.append(label, output);
  if (sheets.length > maxSheets) main.append(node('p', '最多预览 50 张工作表。'));
  const repaint = () => {
    try {
      renderSheet(files, select.value, strings, output);
    } catch (error) {
      output.replaceChildren(node('p', error.message));
    }
  };
  select.addEventListener('change', repaint);
  repaint();
}

function renderSlides(files, main, images) {
  const source = 'ppt/presentation.xml';
  const order = descendants(xml(files, source), 'sldId');
  const links = relationships(files, source);
  const slides = order.map(item => links.get(relId(item))).filter(slide => Object.hasOwn(files, slide));
  if (!slides.length) throw new Error('找不到可预览的幻灯片。');
  const preview = node('ol');
  preview.className = 'slides';
  for (const [index, source] of slides.slice(0, maxSlides).entries()) {
    const slide = xml(files, source);
    const links = relationships(files, source);
    const card = node('li');
    card.append(node('h2', '第 ' + (index + 1) + ' 页'));
    for (const paragraph of descendants(descendants(slide, 'spTree')[0], 'p').slice(0, maxBlocks)) {
      const text = descendants(paragraph, 't').map(item => item.textContent).join('');
      if (text.trim()) card.append(node('p', text));
    }
    for (const part of descendants(slide, 'blip').slice(0, 30)) {
      const image = fileImage(files, links.get(relId(part, 'embed')), images);
      if (image) card.append(image);
    }
    preview.append(card);
  }
  main.append(preview);
  if (slides.length > maxSlides) main.append(node('p', '最多预览 100 页幻灯片。'));
}

export function renderOffice(bytes, format, container) {
  let total = 0;
  let count = 0;
  const files = unzipSync(bytes, {
    filter(file) {
      if (!parts[format].test(file.name)) return false;
      count += 1;
      total += file.originalSize;
      if (count > 900 || file.originalSize > 10 * MiB || total > 32 * MiB) {
        throw new Error('文档解压后超出预览上限。');
      }
      return true;
    },
  });
  const main = node('div');
  main.className = 'office-content';
  const render = { docx: renderWord, xlsx: renderExcel, pptx: renderSlides };
  render[format](files, main, new Map());
  container.replaceChildren(main);
}
