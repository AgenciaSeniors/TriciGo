const s = require('sharp');
const path = require('path');
const files = [
  'Almendron Para marcador del mapa (vista desde arriba).png',
  'Auto Para marcador del mapa (vista desde arriba).png',
  'Moto Para marcador del mapa (vista desde arriba).png',
  'Triciclo Para marcador del mapa (vista desde arriba).png',
];
(async () => {
  for (const f of files) {
    const p = path.join('C:', 'Users', 'Eduardo', 'Downloads', 'img', f);
    const m = await s(p).metadata();
    const { data } = await s(p).extract({ left: 5, top: 5, width: 1, height: 1 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    console.log(f.split(' ')[0], m.width+'x'+m.height, m.channels+'ch', 'corner rgba:', data[0], data[1], data[2], data[3]);
  }
})();
