// Run: node tests/node-base64.mjs > tests/node-base64.json
const inputs = ['', 'Zg', 'Zg=', 'Zg===junk', 'Z', 'Zh', 'Zm9', 'Zm9v', ' Z!m\n9v?', '-_8', '+/8=', '====', 'ab=c', 'a', 'abcde', '💩', 'ŁŁ', 'ＡＡ', '\u0141\u0141', 'Zm9v\u013dAAAA'];
console.log(JSON.stringify({ node: process.version, cases: inputs.map(input => ({input, base64: Buffer.from(input,'base64').toString('hex'), base64url: Buffer.from(input,'base64url').toString('hex')})) }, null, 2));
