// Exercise the actual round selector with the embedded, shipped corpus.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'dino-game.html'), 'utf8');
const corpus = JSON.parse(html.match(/const CORPUS = (.*);/)[1]);
const selector = html.match(/function buildRound\(answer\)\{[\s\S]*?\n\}/)[0];
const shuffle = html.match(/const shuffle = a => \{[\s\S]*?return a; \};/)[0];
const pick = html.match(/const pick = .*;/)[0];
const context = vm.createContext({CORPUS: corpus});
vm.runInContext(`${shuffle}\n${pick}\n${selector}`, context);
assert.equal(new Set(corpus.map(d => d.slug)).size, corpus.length);
for (const answer of corpus) {
  for (let i = 0; i < 5000; i++) {
    const options = context.buildRound(answer);
    assert.equal(options.length, 3);
    assert.equal(options.filter(d => d.slug === answer.slug).length, 1);
    assert.equal(new Set(options.map(d => d.trackType)).size, 3);
  }
  for (const language of ['en', 'es']) {
    assert.ok(answer.name[language]);
    assert.ok(answer.kidDescription[language]);
  }
  assert.ok(answer.image.startsWith('data:image/'));
  assert.ok(answer.footprint.startsWith('data:image/'));
}
console.log(`Passed ${corpus.length * 5000} rounds across ${corpus.length} dinosaurs; bilingual text and embedded assets present.`);
