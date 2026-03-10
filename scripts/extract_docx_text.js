const fs = require('fs');

function extractText(xmlPath) {
  const xml = fs.readFileSync(xmlPath, 'utf8');
  const fullText = [];
  const paras = xml.split('<w:p>');

  for (const p of paras) {
    let heading = '';
    const styleMatch = p.match(/<w:pStyle w:val="(Heading\d)"/);
    if (styleMatch) {
      const level = parseInt(styleMatch[1].replace('Heading', ''));
      heading = '#'.repeat(level) + ' ';
    }
    const tMatches = [...p.matchAll(/<w:t[^>]*>(.*?)<\/w:t>/gs)];
    if (tMatches.length > 0) {
      const text = tMatches.map(m => m[1]).join('');
      if (text.trim()) {
        fullText.push(heading + text);
      }
    }
  }
  return fullText.join('\n');
}

const file = process.argv[2];
console.log(extractText(file));
