import fs from 'fs';
import path from 'path';

/**
 * pdfkit's built-in Standard-14 fonts (Helvetica, ...) only cover WinAnsi/Latin,
 * so Cyrillic (and other non-Latin) text renders as blank boxes. To fix this we
 * embed a real Unicode TrueType font. We look for a bundled font first (drop any
 * TTF into server/fonts/ to override), then fall back to a system font that ships
 * with the OS. Arial / DejaVu Sans both cover Cyrillic.
 */

const WINDIR = process.env.WINDIR || 'C:\\Windows';

type FontPair = { regular: string; bold: string };

// Ordered by preference. First pair whose files both exist wins.
const CANDIDATES: FontPair[] = [
  // Bundled — put DejaVuSans.ttf / DejaVuSans-Bold.ttf (or regular.ttf/bold.ttf)
  // in server/fonts/ to make the export fully self-contained & cross-platform.
  { regular: path.join(__dirname, '../fonts/regular.ttf'), bold: path.join(__dirname, '../fonts/bold.ttf') },
  { regular: path.join(__dirname, '../fonts/DejaVuSans.ttf'), bold: path.join(__dirname, '../fonts/DejaVuSans-Bold.ttf') },
  // Windows system fonts (this project's primary target)
  { regular: path.join(WINDIR, 'Fonts', 'arial.ttf'), bold: path.join(WINDIR, 'Fonts', 'arialbd.ttf') },
  { regular: path.join(WINDIR, 'Fonts', 'segoeui.ttf'), bold: path.join(WINDIR, 'Fonts', 'segoeuib.ttf') },
  { regular: path.join(WINDIR, 'Fonts', 'tahoma.ttf'), bold: path.join(WINDIR, 'Fonts', 'tahomabd.ttf') },
  // Common Linux locations (for a non-Windows shared server)
  { regular: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', bold: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' },
  { regular: '/usr/share/fonts/dejavu/DejaVuSans.ttf', bold: '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf' },
];

// Filesystem scan runs once at module load. Every PDF export used to do
// this on the request path — cheap individually, but wasteful under load.
const RESOLVED: FontPair | null = (() => {
  for (const pair of CANDIDATES) {
    if (fs.existsSync(pair.regular) && fs.existsSync(pair.bold)) return pair;
  }
  return null;
})();

export const FONT = { regular: 'Body', bold: 'Body-Bold' } as const;

/**
 * Registers 'Body' and 'Body-Bold' on the document. Returns true if a Unicode
 * font was embedded, false if we fell back to Helvetica (Latin-only).
 */
export function setupFonts(doc: PDFKit.PDFDocument): boolean {
  if (RESOLVED) {
    doc.registerFont(FONT.regular, RESOLVED.regular);
    doc.registerFont(FONT.bold, RESOLVED.bold);
    return true;
  }
  // Fallback: alias to the built-in Latin fonts so callers can always use FONT.*
  doc.registerFont(FONT.regular, 'Helvetica');
  doc.registerFont(FONT.bold, 'Helvetica-Bold');
  return false;
}
