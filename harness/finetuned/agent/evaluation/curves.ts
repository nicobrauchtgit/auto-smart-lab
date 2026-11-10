/** Small standalone diagnostic plot; coordinates are measured by sklearn. */
export function curveSvg(curves: { available: boolean; roc?: number[][]; precisionRecall?: number[][] }): string | undefined {
 if (!curves.available) return undefined;
 const panel = (title: string, points: number[][], offset: number, xLabel: string, yLabel: string) => {
  const path = points.map(([x, y], i) => `${i ? 'L' : 'M'}${(offset + 45 + x * 260).toFixed(2)},${(300 - y * 250).toFixed(2)}`).join(' ');
  return `<text x="${offset + 175}" y="25" text-anchor="middle">${title}</text>
<path d="M${offset + 45},50 V300 H${offset + 305}" fill="none" stroke="#666"/>
<text x="${offset + 45}" y="320">0</text><text x="${offset + 295}" y="320">1</text>
<text x="${offset + 25}" y="55">1</text><text x="${offset + 25}" y="300">0</text>
<text x="${offset + 175}" y="343" text-anchor="middle">${xLabel}</text>
<text transform="translate(${offset + 15},175) rotate(-90)" text-anchor="middle">${yLabel}</text>
<path d="${path}" fill="none" stroke="#2563eb" stroke-width="2"/>`;
 };
 return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="395" viewBox="0 0 720 395">
<rect width="720" height="395" fill="white"/><g font-family="sans-serif" font-size="13" fill="#222">
${panel('Development OOF ROC', curves.roc!, 0, 'False-positive rate', 'True-positive rate')}
${panel('Development OOF precision–recall', curves.precisionRecall!, 360, 'Recall', 'Precision')}
<text x="360" y="375" text-anchor="middle">Pooled CV predictions; sampled curve points. Compare per-fold evidence.</text></g></svg>\n`;
}
