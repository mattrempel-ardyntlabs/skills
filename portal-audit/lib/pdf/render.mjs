// Renders the two PDF documents and merges them into one.
//
// Two documents, not one, because a fixed full-bleed cover (zero margin,
// dark background) and a naturally flowing content document (real margins,
// a native running footer) are two different page models that do not mix
// well in a single Playwright print pass. See reference/17-pdf-report.md
// for the pagination bug this structure exists to avoid.
//
// Playwright is resolved via lib/browser.mjs's loadPlaywright(), the same
// fallback ladder (this skill's own install, then gstack's, then
// PORTAL_AUDIT_PLAYWRIGHT) the browser crawl already uses, rather than a
// second, independent way of finding Chromium.

import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { loadPlaywright } from '../browser.mjs';
import { renderCoverHtml, renderContentHtml, esc } from './html.mjs';

const PAGE = { width: '816px', height: '1056px', printBackground: true };

export async function renderPdf({ data, assets, outPath }) {
  const { chromium } = await loadPlaywright();
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'portal-audit-pdf-'));
  const coverHtmlPath = path.join(tmpDir, 'cover.html');
  const contentHtmlPath = path.join(tmpDir, 'content.html');
  const coverPdfPath = path.join(tmpDir, 'cover.pdf');
  const contentPdfPath = path.join(tmpDir, 'content.pdf');

  try {
    await writeFile(coverHtmlPath, renderCoverHtml(data, assets));
    await writeFile(contentHtmlPath, await renderContentHtml(data, assets));

    const browser = await chromium.launch();
    try {
      const coverPage = await browser.newPage();
      await coverPage.goto(`file://${coverHtmlPath}`, { waitUntil: 'networkidle' });
      await coverPage.pdf({ ...PAGE, path: coverPdfPath, margin: { top: 0, bottom: 0, left: 0, right: 0 } });
      await coverPage.close();

      const contentPage = await browser.newPage();
      await contentPage.goto(`file://${contentHtmlPath}`, { waitUntil: 'networkidle' });
      const footerTemplate = `
<div style="width:100%; font-family:Georgia,serif; font-size:8.5px; color:#7A7773; padding:0 72px; display:flex; justify-content:space-between; align-items:center;">
  <span>Ardynt Labs &middot; ${esc(data.meta.portalName)} Portal Audit</span>
  <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
</div>`;
      await contentPage.pdf({
        ...PAGE,
        path: contentPdfPath,
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate,
        margin: { top: '64px', bottom: '54px', left: '72px', right: '72px' },
      });
      await contentPage.close();
    } finally {
      await browser.close();
    }

    const coverDoc = await PDFDocument.load(await readFile(coverPdfPath));
    const contentDoc = await PDFDocument.load(await readFile(contentPdfPath));
    const finalDoc = await PDFDocument.create();
    for (const p of await finalDoc.copyPages(coverDoc, coverDoc.getPageIndices())) finalDoc.addPage(p);
    for (const p of await finalDoc.copyPages(contentDoc, contentDoc.getPageIndices())) finalDoc.addPage(p);
    await writeFile(outPath, await finalDoc.save());

    return { coverPages: coverDoc.getPageCount(), contentPages: contentDoc.getPageCount(), totalPages: finalDoc.getPageCount() };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
