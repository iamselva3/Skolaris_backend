const fs = require('fs');
const path = require('path');

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) { 
      results = results.concat(walk(file));
    } else if (file.endsWith('.spec.ts')) {
      results.push(file);
    }
  });
  return results;
}

const files = walk('./src');
let changedCount = 0;
files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  const original = content;
  content = content.replace(/'a@b\.test',\s*'h'/g, "'a@b.test', null, 'h'");
  content = content.replace(/'admin@b\.test',\s*'h'/g, "'admin@b.test', null, 'h'");
  content = content.replace(/'test@example\.com',\s*'hashed'/g, "'test@example.com', null, 'hashed'");
  if (content !== original) {
    fs.writeFileSync(file, content);
    changedCount++;
  }
});
console.log('Changed ' + changedCount + ' files');
